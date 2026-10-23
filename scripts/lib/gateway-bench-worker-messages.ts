import { channel } from "node:diagnostics_channel";
import { basename } from "node:path";
import { types } from "node:util";
import { Serializer } from "node:v8";
import { createRuntimeProcessEntrypoints } from "../../src/infra/runtime-process-manifest.ts";
import type {
  WorkerMessageDirection,
  WorkerMessageKind,
} from "../../src/infra/worker-message-metrics.ts";

const observationChannel = channel("openclaw.benchmark.worker-message");
const scripts = new Set(
  Object.values(createRuntimeProcessEntrypoints(import.meta.url)).map((entry) =>
    basename(entry.distWorkerPath),
  ),
);
const labels = new Set([
  "native-commit",
  "native-settlement",
  "sqlite-database-admissions",
  "session-actor-admission",
  "session-actor-committed",
  "session-actor-committed-transfer",
  "session-actor-outcome",
  "session-turn",
  "command",
  "result",
  "outcome",
  "row",
  "committed",
  "open",
  "prepare",
  "transaction",
  "commit",
  "create",
  "created",
  "close",
  "closed",
  "ok",
  "failed",
  "request",
  "notification",
  "consumed",
  "memory",
  "ready",
  "acceptInput",
  "adoptRun",
  "appendToolResult",
  "appendTranscriptEvent",
  "completeTurn",
  "deliveryPending",
  "deliverySettled",
  "patch",
  "read",
]);

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !types.isProxy(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

export function gatewayBenchMessageLabel(value: unknown): string {
  return typeof value === "string" && labels.has(value) ? value : "other";
}

type Observation = {
  kind: WorkerMessageKind;
  direction: WorkerMessageDirection;
  payloadBytes?: number;
  message?: unknown;
};

type Group = {
  kind: WorkerMessageKind;
  direction: WorkerMessageDirection;
  script: string;
  operation: string;
  facts: string;
  receipt: string;
  phase: string;
  publication: string;
  messages: number;
  knownPayloadMessages: number;
  knownPayloadBytes: number;
  serializedMessages: number;
  serializedBytes: number;
  sharedBufferMessages: number;
  sharedBackingBytes: number;
  failedSerializationMessages: number;
  unavailableMessageValues: number;
  sections: Record<
    string,
    { messages: number; serializedBytes: number; failedSerializationMessages: number }
  >;
};

// Shared backing memory is referenced, not copied. IDs and byte counts live only
// until this one serialization finishes; nothing retains a message or its buffers.
class MessageSizer extends Serializer {
  readonly shared = new Map<SharedArrayBuffer, number>();
  sharedBackingBytes = 0;
  _getSharedArrayBufferId(buffer: SharedArrayBuffer): number {
    let id = this.shared.get(buffer);
    if (id === undefined) {
      id = this.shared.size;
      this.shared.set(buffer, id);
      this.sharedBackingBytes += buffer.byteLength;
    }
    return id;
  }
}

/** Diagnostic pass only: serialization itself adds work and must not gate allocation/GC. */
export function startGatewayBenchWorkerMessages() {
  const groups = new Map<string, Group>();
  let overflowMessages = 0;
  const observe = (event: unknown) => {
    const { kind, direction, payloadBytes, message } = event as Observation;
    const envelope = property(message, "type");
    const body =
      envelope === "message" || envelope === "post" ? property(message, "value") : message;
    const committed =
      property(body, "committed") ?? property(property(body, "settlement"), "committed");
    const rawFacts = property(body, "facts") ?? property(committed, "facts");
    const facts =
      property(property(rawFacts, "publication"), "kind") === "session-actor-admission"
        ? property(rawFacts, "publication")
        : rawFacts;
    const receipt = property(facts, "receipt");
    const publication = property(facts, "publication");
    const filename = property(property(body, "filename"), "value");
    const name =
      typeof filename === "string"
        ? basename(filename).replace(/\.[cm]?[jt]s$/u, ".js")
        : undefined;
    const script = name && scripts.has(name) ? name : "unknown";
    const operation = gatewayBenchMessageLabel(
      property(body, "kind") ??
        property(body, "stage") ??
        property(body, "type") ??
        property(body, "status"),
    );
    const factsKind = gatewayBenchMessageLabel(property(facts, "kind"));
    const receiptKind = gatewayBenchMessageLabel(property(receipt, "kind"));
    const phase = gatewayBenchMessageLabel(property(receipt, "phase"));
    const publicationKind = gatewayBenchMessageLabel(property(publication, "kind"));
    const key = [
      kind,
      direction,
      script,
      operation,
      factsKind,
      receiptKind,
      phase,
      publicationKind,
    ].join(":");
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= 512) {
        overflowMessages++;
        return;
      }
      group = {
        kind,
        direction,
        script,
        operation,
        facts: factsKind,
        receipt: receiptKind,
        phase,
        publication: publicationKind,
        messages: 0,
        knownPayloadMessages: 0,
        knownPayloadBytes: 0,
        serializedMessages: 0,
        serializedBytes: 0,
        sharedBufferMessages: 0,
        sharedBackingBytes: 0,
        failedSerializationMessages: 0,
        unavailableMessageValues: 0,
        sections: {},
      };
      groups.set(key, group);
    }
    group.messages++;
    if (payloadBytes !== undefined) {
      group.knownPayloadMessages++;
      group.knownPayloadBytes += payloadBytes;
    }
    if (message === undefined) {
      group.unavailableMessageValues++;
      return;
    }
    const entries = [
      [
        "authorityEntry",
        factsKind === "session-actor-admission"
          ? property(property(facts, "snapshot"), "entry")
          : undefined,
      ],
      [
        "postimageEntry",
        receiptKind === "session-actor-committed"
          ? property(property(receipt, "postimage"), "entry")
          : undefined,
      ],
    ] as const;
    for (const [label, entry] of entries) {
      if (entry === undefined) {
        continue;
      }
      for (const field of ["", "skillsSnapshot", "systemPromptReport", "pendingFinalDelivery"]) {
        const value = field ? property(entry, field) : entry;
        if (value === undefined) {
          continue;
        }
        const section = (group.sections[field ? `${label}.${field}` : label] ??= {
          messages: 0,
          serializedBytes: 0,
          failedSerializationMessages: 0,
        });
        section.messages++;
        try {
          const serializer = new MessageSizer();
          serializer.writeHeader();
          serializer.writeValue(value);
          section.serializedBytes += serializer.releaseBuffer().byteLength;
        } catch {
          section.failedSerializationMessages++;
        }
      }
    }
    const serializer = new MessageSizer();
    try {
      serializer.writeHeader();
      serializer.writeValue(message);
      group.serializedBytes += serializer.releaseBuffer().byteLength;
      group.serializedMessages++;
      if (serializer.shared.size > 0) {
        group.sharedBufferMessages++;
        group.sharedBackingBytes += serializer.sharedBackingBytes;
      }
    } catch {
      // MessagePorts and unsupported native objects cannot be sized by V8's
      // public serializer. Keep the missing denominator instead of counting zero.
      group.failedSerializationMessages++;
    }
  };
  observationChannel.subscribe(observe);
  return () => {
    observationChannel.unsubscribe(observe);
    return {
      scope: "main-isolate-worker-boundaries",
      byteMeaning: "V8 reserialization estimate, not heap bytes or native transport bytes",
      overflowMessages,
      groups: [...groups.values()],
    };
  };
}

/** Fail closed if an owner changes: silent partial attribution is misleading. */
export function instrumentGatewayBenchWorkerSource(file: string, source: string): string {
  let instrumented = source;
  const replace = (before: string, after: string) => {
    if (instrumented.split(before).length !== 2) {
      throw new Error(`Worker attribution source anchor changed in ${file}`);
    }
    instrumented = instrumented.replace(before, after);
  };
  if (file === "worker-message-metrics.ts") {
    replace(
      "  payloadBytes?: number,\n): void {",
      "  payloadBytes?: number,\n  benchmarkMessage?: unknown,\n): void {",
    );
    replace(
      "  let directions = counters.get(kind);",
      `  if (benchmarkWorkerMessageChannel.hasSubscribers) {
    benchmarkWorkerMessageChannel.publish({ kind, direction, payloadBytes, message: benchmarkMessage });
  }
  let directions = counters.get(kind);`,
    );
    replace(
      "payloadBytes === undefined ? workerMessagePayloadBytes(message) : (payloadBytes ?? undefined),",
      "payloadBytes === undefined ? workerMessagePayloadBytes(message) : (payloadBytes ?? undefined),\n      message,",
    );
    instrumented = `import { channel as benchmarkWorkerDiagnosticChannel } from "node:diagnostics_channel";
const benchmarkWorkerMessageChannel = benchmarkWorkerDiagnosticChannel("openclaw.benchmark.worker-message");
${instrumented}`;
  } else if (file === "sqlite-worker-operation-admission.ts") {
    replace(
      "        ? message.payloadBytes\n        : undefined,\n    );",
      "        ? message.payloadBytes\n        : undefined,\n      message,\n    );",
    );
  }
  return instrumented;
}
