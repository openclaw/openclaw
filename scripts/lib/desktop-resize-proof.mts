import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, stat as fsStat, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { desktopGatewayReadiness } from "./desktop-readiness-proof.mts";

export const desktopResizeStages = [
  "02-panel",
  "03-panel-resized",
  "04-fullscreen",
  "05-portrait",
  "06-landscape",
] as const;
const sha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
export const desktopTerminationLimits = {
  gateway: 512 * 1024,
  node: 64 * 1024,
  rfb: 448 * 1024,
  line: 16 * 1024,
  scenarioOutput: 24 * 1024,
  rfbOutput: 8 * 1024 - 1024,
  checkpoint: 32 * 1024,
} as const;

/** Only the explicitly opted-in fixture children change their console configuration. */
export function desktopProofDiagnosticLogging(enabled: boolean) {
  return {
    env: enabled ? { OPENCLAW_LOG_LEVEL: "info" } : {},
    logging: enabled ? { consoleStyle: "json" as const, consoleLevel: "info" as const } : undefined,
  };
}

type OutputChunks = readonly (string | Uint8Array)[];
type DesktopProofOutput = {
  stdout: OutputChunks;
  stderr: OutputChunks;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  retention: "head" | "tail";
};

/** A private head capture on an existing child's pipes; never an additional process owner. */
export function createDesktopProofOutputCapture(maximum: number) {
  if (!Number.isSafeInteger(maximum) || maximum < 2 || maximum > desktopTerminationLimits.rfb) {
    throw new Error("Invalid desktop diagnostic capture bound");
  }
  const create = () => ({
    data: Buffer.alloc(Math.floor(maximum / 2)),
    length: 0,
    truncated: false,
  });
  const streams = { stdout: create(), stderr: create() };
  return {
    append(stream: "stdout" | "stderr", chunk: Uint8Array) {
      const target = streams[stream];
      const length = Math.min(chunk.byteLength, target.data.length - target.length);
      target.data.set(chunk.subarray(0, length), target.length);
      target.length += length;
      target.truncated ||= length !== chunk.byteLength;
    },
    snapshot(): DesktopProofOutput {
      return {
        stdout: [Buffer.from(streams.stdout.data.subarray(0, streams.stdout.length))],
        stderr: [Buffer.from(streams.stderr.data.subarray(0, streams.stderr.length))],
        stdoutTruncated: streams.stdout.truncated,
        stderrTruncated: streams.stderr.truncated,
        retention: "head",
      };
    },
  };
}

const observerTriggers = [
  "owner-close",
  "browser-close",
  "browser-error",
  "stream-close",
  "stream-error",
  "authority-revoked",
  "invalid-view-only-stream",
  "authentication-failed",
] as const;
const brokerTriggers = ["attach-rejected", "websocket-error", "websocket-close"] as const;
const transportTriggers = [
  "owner-abort",
  "target-close",
  "target-error",
  "websocket-close",
  "websocket-error",
  "send-error",
  "invalid-frame",
  "splice-unavailable",
  "startup-error",
] as const;
const terminationProducers = [
  "gateway-observer",
  "gateway-broker",
  "node-transport",
  "rfb",
] as const;
type TerminationRecord = {
  stream: "stdout" | "stderr";
  ordinal: number;
  producer: (typeof terminationProducers)[number];
  trigger: string;
  closeCode: number | null;
  cleanupCode: number | null;
};
const closeCode = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 65_535
    ? Number(value)
    : null;

function terminationRecord(line: string, source: "gateway" | "node" | "rfb") {
  if (source === "rfb") {
    // TigerVNC 1.13.1 emits its stored first close reason from the connection destructor.
    // This can follow client cleanup; the endpoint and arbitrary reason remain private.
    if (!/^\s*VNCSConnST:\s+closing .+: /u.test(line)) {
      return null;
    }
    const message = line.replace(/\r$/u, "");
    return {
      producer: "rfb" as const,
      trigger: message.endsWith(": Clean disconnection")
        ? "clean-disconnection"
        : message.endsWith(": Client does not support desktop resize")
          ? "resize-unsupported"
          : "other-close",
      closeCode: null,
      cleanupCode: null,
    };
  }
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || value.level !== "info") {
    return null;
  }
  let producer: TerminationRecord["producer"];
  let allowed: readonly string[];
  if (
    source === "gateway" &&
    value.subsystem === "gateway/desktop" &&
    value.message === "desktop observer closed"
  ) {
    producer = "gateway-observer";
    allowed = observerTriggers;
  } else if (
    source === "gateway" &&
    value.subsystem === "gateway/node-stream" &&
    value.message === "node stream closed" &&
    value.streamKind === "desktop"
  ) {
    producer = "gateway-broker";
    allowed = brokerTriggers;
  } else if (
    source === "node" &&
    value.subsystem === "node-host/stream" &&
    value.message === "node stream closed" &&
    value.streamKind === "desktop"
  ) {
    producer = "node-transport";
    allowed = transportTriggers;
  } else {
    return null;
  }
  return {
    producer,
    trigger: allowed.find((trigger) => trigger === value.trigger) ?? "unknown",
    closeCode: closeCode(value.closeCode),
    cleanupCode: producer === "gateway-observer" ? closeCode(value.cleanupCode) : null,
  };
}

function projectTerminationOutput(
  input: DesktopProofOutput | undefined,
  source: "gateway" | "node" | "rfb",
  maximum: number,
  recordLimit: number,
) {
  const records: TerminationRecord[] = [];
  const streams = (["stdout", "stderr"] as const).map((stream) => {
    const chunks = input?.[stream] ?? [];
    const retainedTruncation =
      input?.[stream === "stdout" ? "stdoutTruncated" : "stderrTruncated"] === true ||
      Object.getOwnPropertyDescriptor(chunks, "truncated")?.value === true;
    const bytes = Buffer.alloc(Math.floor(maximum / 2));
    let length = 0;
    let inputLimited = false;
    // A chunk count also bounds empty-chunk scans; encodeInto never allocates the full input.
    for (let index = 0; index < chunks.length; index += 1) {
      if (index >= 4096 || length === bytes.length) {
        inputLimited = true;
        break;
      }
      const chunk = chunks[index]!;
      const remaining = bytes.length - length;
      if (typeof chunk === "string") {
        const result = new TextEncoder().encodeInto(
          chunk.slice(0, remaining),
          bytes.subarray(length),
        );
        length += result.written;
        if (result.read !== chunk.length) {
          inputLimited = true;
          break;
        }
      } else {
        const count = Math.min(chunk.byteLength, remaining);
        bytes.set(chunk.subarray(0, count), length);
        length += count;
        if (count !== chunk.byteLength) {
          inputLimited = true;
          break;
        }
      }
    }
    let offset = 0;
    let ordinal = 0;
    let malformedLines = 0;
    let oversizedLines = 0;
    let recordsLimited = false;
    let partialLine = false;
    const partialPrefix = retainedTruncation && input?.retention === "tail";
    while (offset < length) {
      if (ordinal >= 4096) {
        inputLimited = true;
        break;
      }
      const end = bytes.indexOf(10, offset);
      if (end < 0 || end >= length) {
        partialLine = true;
        break;
      }
      ordinal += 1;
      if (!(partialPrefix && offset === 0)) {
        if (end - offset > desktopTerminationLimits.line) {
          oversizedLines += 1;
        } else {
          try {
            const row = terminationRecord(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end)),
              source,
            );
            if (row) {
              if (records.length < recordLimit) {
                records.push({ stream, ordinal, ...row });
              } else {
                recordsLimited = true;
              }
            }
          } catch {
            malformedLines += 1;
          }
        }
      }
      offset = end + 1;
    }
    return {
      stream,
      scannedBytes: length,
      retainedTruncation,
      inputLimited,
      partialPrefix,
      partialLine,
      malformedLines,
      oversizedLines,
      recordsLimited,
    };
  });
  return { status: input ? ("captured" as const) : ("unavailable" as const), streams, records };
}

type TerminationOutput = ReturnType<typeof projectTerminationOutput>;
type ScenarioTermination =
  | {
      status: "captured";
      boundary: "before-scenario-cleanup";
      signalAborted: boolean;
      correlation: "unavailable";
      writerMayBeBuffered: true;
      gateway: TerminationOutput;
      node: TerminationOutput;
    }
  | { status: "unavailable" | "invalid" };

/** No stream IDs or timestamps cross this boundary; ordinals are local to each producer pipe. */
export function desktopScenarioTermination(
  gateway: DesktopProofOutput,
  node: DesktopProofOutput | undefined,
  signalAborted: boolean,
): ScenarioTermination {
  try {
    const value: ScenarioTermination = {
      status: "captured",
      boundary: "before-scenario-cleanup",
      signalAborted,
      correlation: "unavailable",
      writerMayBeBuffered: true,
      gateway: projectTerminationOutput(gateway, "gateway", desktopTerminationLimits.gateway, 32),
      node: projectTerminationOutput(node, "node", desktopTerminationLimits.node, 16),
    };
    if (Buffer.byteLength(JSON.stringify(value)) > desktopTerminationLimits.scenarioOutput) {
      return { status: "unavailable" };
    }
    return value;
  } catch {
    return { status: "unavailable" };
  }
}

export function desktopRfbTermination(
  dynamic: DesktopProofOutput | undefined,
  fixed: DesktopProofOutput | undefined,
) {
  try {
    const value = {
      status: "captured" as const,
      boundary: "after-test-process-join-before-daemon-cleanup" as const,
      correlation: "unavailable" as const,
      writerMayBeBuffered: true,
      dynamic: projectTerminationOutput(dynamic, "rfb", desktopTerminationLimits.rfb / 2, 8),
      fixed: projectTerminationOutput(fixed, "rfb", desktopTerminationLimits.rfb / 2, 8),
    };
    return Buffer.byteLength(JSON.stringify(value)) <= desktopTerminationLimits.rfbOutput
      ? value
      : { status: "unavailable" as const };
  } catch {
    return { status: "unavailable" as const };
  }
}

/** Diagnostic projection or persistence cannot replace the operation or cleanup error. */
export async function withDesktopTerminationSnapshot<T>(
  run: () => Promise<T>,
  freeze: () => void,
): Promise<T> {
  try {
    return await run();
  } finally {
    try {
      freeze();
    } catch {
      /* Optional evidence is unavailable. */
    }
  }
}

function checkpointTermination(value: unknown): ScenarioTermination {
  try {
    if (!isRecord(value)) {
      throw new Error("Invalid termination checkpoint");
    }
    if (value.status === "unavailable" || value.status === "invalid") {
      return { status: value.status };
    }
    if (
      value.status !== "captured" ||
      value.boundary !== "before-scenario-cleanup" ||
      typeof value.signalAborted !== "boolean" ||
      value.correlation !== "unavailable" ||
      value.writerMayBeBuffered !== true
    ) {
      throw new Error("Invalid termination checkpoint");
    }
    const output = (
      raw: unknown,
      maximum: number,
      recordLimit: number,
      producers: readonly string[],
    ): TerminationOutput => {
      if (
        !isRecord(raw) ||
        (raw.status !== "captured" && raw.status !== "unavailable") ||
        !Array.isArray(raw.streams) ||
        raw.streams.length !== 2 ||
        !Array.isArray(raw.records) ||
        raw.records.length > recordLimit
      ) {
        throw new Error("Invalid termination output");
      }
      return {
        status: raw.status,
        streams: raw.streams.map((entry, index) => {
          if (!isRecord(entry) || entry.stream !== ["stdout", "stderr"][index]) {
            throw new Error("Invalid termination stream");
          }
          const boolean = (key: string) => {
            if (typeof entry[key] !== "boolean") {
              throw new Error("Invalid termination flag");
            }
            return entry[key];
          };
          return {
            stream: index === 0 ? "stdout" : "stderr",
            scannedBytes: reportInteger(entry.scannedBytes, maximum / 2),
            retainedTruncation: boolean("retainedTruncation"),
            inputLimited: boolean("inputLimited"),
            partialPrefix: boolean("partialPrefix"),
            partialLine: boolean("partialLine"),
            malformedLines: reportInteger(entry.malformedLines, 4096),
            oversizedLines: reportInteger(entry.oversizedLines, 4096),
            recordsLimited: boolean("recordsLimited"),
          };
        }),
        records: raw.records.map((row) => {
          if (!isRecord(row) || (row.stream !== "stdout" && row.stream !== "stderr")) {
            throw new Error("Invalid termination row");
          }
          const producer = terminationProducers.find(
            (candidate) => candidate === row.producer && producers.includes(candidate),
          );
          const allowed =
            producer === "gateway-observer"
              ? observerTriggers
              : producer === "gateway-broker"
                ? brokerTriggers
                : transportTriggers;
          if (
            !producer ||
            typeof row.trigger !== "string" ||
            (row.trigger !== "unknown" && !(allowed as readonly string[]).includes(row.trigger)) ||
            (row.closeCode !== null && closeCode(row.closeCode) === null) ||
            (row.cleanupCode !== null && closeCode(row.cleanupCode) === null)
          ) {
            throw new Error("Invalid termination row");
          }
          return {
            stream: row.stream,
            ordinal: reportInteger(row.ordinal, 4096),
            producer,
            trigger: row.trigger,
            closeCode: closeCode(row.closeCode),
            cleanupCode: closeCode(row.cleanupCode),
          };
        }),
      };
    };
    const safe: ScenarioTermination = {
      status: "captured",
      boundary: "before-scenario-cleanup",
      signalAborted: value.signalAborted,
      correlation: "unavailable",
      writerMayBeBuffered: true,
      gateway: output(value.gateway, desktopTerminationLimits.gateway, 32, [
        "gateway-observer",
        "gateway-broker",
      ]),
      node: output(value.node, desktopTerminationLimits.node, 16, ["node-transport"]),
    };
    return Buffer.byteLength(JSON.stringify(safe)) <= desktopTerminationLimits.scenarioOutput
      ? safe
      : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

export function encodeDesktopProofPhase(
  lastObservedPhase: string,
  owners: unknown,
  termination?: unknown,
) {
  const phase = desktopProofTestPhases.find((candidate) => candidate === lastObservedPhase);
  if (!phase) {
    throw new Error("Invalid desktop phase");
  }
  const value = {
    lastObservedPhase: phase,
    owners: desktopOwners(owners),
    ...(termination === undefined ? {} : { termination: checkpointTermination(termination) }),
  };
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > desktopTerminationLimits.checkpoint) {
    throw new Error("Desktop checkpoint exceeded bound");
  }
  return encoded;
}
const desktopProofTestPhases = [
  "file-loaded",
  "fixture",
  "gateway-config",
  "gateway-start",
  "admin-connect",
  "node-admission",
  "guest-ssh",
  "browser-context",
  "browser-navigation",
  "ui-ready",
  "desktop-connect",
  "initial-framebuffer",
  "control-takeover",
  "resize-matrix",
] as const;
const desktopOwnerStates = ["not-started", "owned", "closed"] as const;
function desktopOwners(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const gateway = desktopOwnerStates.find((state) => state === value.gateway);
  const endpointTap = desktopOwnerStates.find((state) => state === value.endpointTap);
  return gateway && endpointTap ? { gateway, endpointTap } : null;
}
const desktopTestFile = "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts";
const failureSourceFiles = [
  desktopTestFile,
  "ui/src/e2e/desktop-resize-real.test-support.ts",
  "ui/src/e2e/control-ui-e2e-suite.test-support.ts",
  "ui/src/test-helpers/control-ui-e2e.ts",
  "ui/src/test-helpers/control-ui-e2e-readiness.ts",
  "test/e2e/qa-lab/runtime/skill-library-node-process.ts",
  "test/e2e/qa-lab/runtime/skill-library-wire-fixture.ts",
  "test/e2e/qa-lab/runtime/cloud-worker-midturn-loss-fixture.ts",
  "test/helpers/openclaw-test-instance.ts",
];

function reportInteger(value: unknown, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error("Invalid desktop test report number");
  }
  return Number(value);
}

function nullableFramebuffer(value: unknown) {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error("Invalid desktop framebuffer diagnostic");
  }
  return {
    width: reportInteger(value.width, 8192),
    height: reportInteger(value.height, 8192),
  };
}

function desktopSocketCloses(value: unknown) {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("Invalid desktop socket close diagnostics");
  }
  return value.map((event) => {
    const category = (
      [
        "takeover",
        "authority-revoked",
        "stream-close",
        "authentication",
        "other",
        "unknown",
      ] as const
    ).find((candidate) => isRecord(event) && candidate === event.category);
    if (!isRecord(event) || typeof event.wasClean !== "boolean" || !category) {
      throw new Error("Invalid desktop socket close diagnostic");
    }
    return {
      socketIndex: reportInteger(event.socketIndex, 9_999),
      code: reportInteger(event.code, 65_535),
      wasClean: event.wasClean,
      category,
    };
  });
}

const nodeStreamCloseTriggers = [
  "owner-abort",
  "target-close",
  "target-error",
  "websocket-close",
  "websocket-error",
  "send-error",
  "invalid-frame",
  "splice-unavailable",
  "startup-error",
] as const;

function desktopNodeStreamCloses(value: unknown) {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("Invalid desktop node stream diagnostics");
  }
  return value.map((event) => {
    const trigger = nodeStreamCloseTriggers.find(
      (candidate) => isRecord(event) && candidate === event.trigger,
    );
    if (!isRecord(event) || !trigger) {
      throw new Error("Invalid desktop node stream diagnostic");
    }
    return { trigger, closeCode: reportInteger(event.closeCode, 65_535) };
  });
}

/** Read at most 1 MiB, including when a live fixture log grows after admission. */
async function readDesktopProofLog(file: string) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      return null;
    }
    const handle = await open(file, "r");
    let text: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
        return null;
      }
      const buffer = Buffer.alloc(1024 * 1024);
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
        if (result.bytesRead === 0) {
          break;
        }
        bytes += result.bytesRead;
      }
      if ((await handle.stat()).size > buffer.length) {
        return null;
      }
      text = buffer.toString("utf8", 0, bytes);
    } finally {
      await handle.close();
    }
    return text.split("\n").flatMap((line): unknown[] => {
      try {
        return [JSON.parse(line)];
      } catch {
        // An in-progress final write is not a completed lifecycle record.
        return [];
      }
    });
  } catch {
    // Diagnostic collection must not replace the framebuffer assertion failure.
    return null;
  }
}

/** Preserve the existing node projection while sharing the actual-byte read bound. */
export async function readDesktopProofNodeStreamCloses(file: string) {
  const records = await readDesktopProofLog(file);
  if (!records) {
    return null;
  }
  try {
    return desktopNodeStreamCloses(
      records
        .flatMap((record) =>
          isRecord(record) &&
          record["0"] === '{"subsystem":"node-host/stream"}' &&
          record["2"] === "node stream closed" &&
          isRecord(record["1"]) &&
          record["1"].streamKind === "desktop"
            ? [record["1"]]
            : [],
        )
        .slice(-8),
    );
  } catch {
    return null;
  }
}

function diagnosticEvents<T>(value: unknown, project: (event: unknown) => T) {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.events) || value.events.length > 8) {
    throw new Error("Invalid desktop lifecycle diagnostics");
  }
  return { events: value.events.map(project), omitted: reportInteger(value.omitted, 1_000_000) };
}

function diagnosticEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  const found = values.find((entry) => entry === value);
  if (!found) {
    throw new Error("Invalid desktop lifecycle category");
  }
  return found;
}

function desktopEndpointCloses(value: unknown) {
  return diagnosticEvents(value, (event) => {
    if (!isRecord(event) || (event.hadError !== null && typeof event.hadError !== "boolean")) {
      throw new Error("Invalid desktop endpoint close");
    }
    return {
      connectionIndex: reportInteger(event.connectionIndex, 1_000_000),
      side: diagnosticEnum(event.side, ["client", "upstream", "fixture"]),
      event: diagnosticEnum(event.event, ["end", "error", "close", "cleanup"]),
      errorCategory:
        event.errorCategory === null
          ? null
          : diagnosticEnum(event.errorCategory, [
              "reset",
              "broken-pipe",
              "refused",
              "timeout",
              "other",
            ]),
      hadError: event.hadError,
    };
  });
}

function desktopRfbLifecycle(value: unknown) {
  return diagnosticEvents(value, (event) => {
    if (
      !isRecord(event) ||
      typeof event.connectedObserved !== "boolean" ||
      (event.clean !== null && typeof event.clean !== "boolean")
    ) {
      throw new Error("Invalid desktop RFB lifecycle");
    }
    return {
      ordinal: reportInteger(event.ordinal, 1_000_000),
      socketIndex: event.socketIndex === null ? null : reportInteger(event.socketIndex, 9_999),
      phase: diagnosticEnum(event.phase, [
        "connecting",
        "connected",
        "security-failure",
        "disconnected",
      ]),
      connectedObserved: event.connectedObserved,
      clean: event.clean,
      securityStatus:
        event.securityStatus === null ? null : reportInteger(event.securityStatus, 0xffff_ffff),
    };
  });
}

function desktopGatewayCloses(value: unknown) {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error("Invalid desktop gateway diagnostics");
  }
  return {
    observerCloses: diagnosticEvents(value.observerCloses, (event) => {
      if (!isRecord(event)) {
        throw new Error("Invalid desktop observer close");
      }
      return {
        trigger: diagnosticEnum(event.trigger, [
          "browser-close",
          "browser-error",
          "stream-close",
          "stream-error",
          "owner-close",
          "authority-revoked",
          "invalid-view-only-stream",
          "authentication-failed",
        ]),
        cleanupCode: reportInteger(event.cleanupCode, 65_535),
        closeCode: reportInteger(event.closeCode, 65_535),
      };
    }),
    sshTunnelExits: diagnosticEvents(value.sshTunnelExits, (event) => {
      if (!isRecord(event) || typeof event.stopRequested !== "boolean") {
        throw new Error("Invalid desktop SSH exit");
      }
      return {
        code: event.code === null ? null : reportInteger(event.code, 255),
        signal:
          event.signal === null
            ? null
            : diagnosticEnum(event.signal, [
                "SIGHUP",
                "SIGINT",
                "SIGQUIT",
                "SIGILL",
                "SIGTRAP",
                "SIGABRT",
                "SIGBUS",
                "SIGFPE",
                "SIGKILL",
                "SIGUSR1",
                "SIGSEGV",
                "SIGUSR2",
                "SIGPIPE",
                "SIGALRM",
                "SIGTERM",
                "SIGCHLD",
                "SIGCONT",
                "SIGSTOP",
                "SIGTSTP",
                "SIGTTIN",
                "SIGTTOU",
                "SIGURG",
                "SIGXCPU",
                "SIGXFSZ",
                "SIGVTALRM",
                "SIGPROF",
                "SIGWINCH",
                "SIGIO",
                "SIGSYS",
              ]),
        stopRequested: event.stopRequested,
      };
    }),
  };
}

export async function readDesktopProofGatewayCloses(file: string) {
  const records = await readDesktopProofLog(file);
  if (!records) {
    return null;
  }
  const events = (message: string) => {
    const matching = records.flatMap((record) =>
      isRecord(record) &&
      record["0"] === '{"subsystem":"gateway/desktop"}' &&
      record["2"] === message
        ? [record["1"]]
        : [],
    );
    return { events: matching.slice(-8), omitted: Math.max(0, matching.length - 8) };
  };
  try {
    return desktopGatewayCloses({
      observerCloses: events("desktop observer closed"),
      sshTunnelExits: events("desktop SSH tunnel exited"),
    });
  } catch {
    return null;
  }
}

function desktopViewerResizeFailure(value: unknown) {
  if (!isRecord(value) || typeof value.pageClosed !== "boolean") {
    throw new Error("Invalid desktop viewer diagnostic");
  }
  const snapshotStatus = (["available", "unavailable", "timed-out"] as const).find(
    (status) => status === value.snapshotStatus,
  );
  const latestReadyState = value.latestReadyState;
  if (
    !snapshotStatus ||
    (latestReadyState !== null &&
      latestReadyState !== 0 &&
      latestReadyState !== 1 &&
      latestReadyState !== 2 &&
      latestReadyState !== 3)
  ) {
    throw new Error("Invalid desktop viewer snapshot state");
  }
  return {
    expected: geometry(value.expected),
    lastFramebuffer: nullableFramebuffer(value.lastFramebuffer),
    snapshotStatus,
    pageClosed: value.pageClosed,
    canvasCount: value.canvasCount === null ? null : reportInteger(value.canvasCount, 10_000),
    snapshotFramebuffer: nullableFramebuffer(value.snapshotFramebuffer),
    socketCount: value.socketCount === null ? null : reportInteger(value.socketCount, 10_000),
    latestReadyState,
    socketCloses: desktopSocketCloses(value.socketCloses),
    ...(value.nodeStreamCloses !== undefined
      ? { nodeStreamCloses: desktopNodeStreamCloses(value.nodeStreamCloses) }
      : {}),
    ...(value.endpointCloses !== undefined
      ? { endpointCloses: desktopEndpointCloses(value.endpointCloses) }
      : {}),
    ...(value.rfbLifecycle !== undefined
      ? { rfbLifecycle: desktopRfbLifecycle(value.rfbLifecycle) }
      : {}),
    ...(value.gatewayCloses !== undefined
      ? { gatewayCloses: desktopGatewayCloses(value.gatewayCloses) }
      : {}),
  };
}

function publicTestFailure(value: unknown) {
  if (typeof value !== "string" || value.length > 64 * 1024) {
    throw new Error("Invalid desktop test failure");
  }
  const message = stripVTControlCharacters(value).trimStart();
  // Vitest emits these exact timeout prefixes; elapsed time is not failure evidence.
  const category = /^(?:Error: )?Test timed out in \d+ms(?:\.| while waiting for )/u.test(message)
    ? "test-timeout"
    : /^(?:Error: )?Hook timed out in \d+ms(?:\.| while waiting for )/u.test(message)
      ? "hook-timeout"
      : (/^(AssertionError|TimeoutError|TypeError|ReferenceError|SyntaxError|RangeError):/u.exec(
          message,
        )?.[1] ?? "test-error");
  const locations = failureSourceFiles
    .flatMap((file) =>
      [
        ...message
          .replaceAll("\\", "/")
          .matchAll(new RegExp(`${file.replaceAll(".", "\\.")}:(\\d+):(\\d+)`, "gu")),
      ]
        .slice(0, 4)
        .map((match) => ({
          file,
          line: reportInteger(Number(match[1]), 100_000),
          column: reportInteger(Number(match[2]), 100_000),
        })),
    )
    .slice(0, 8);
  return { category, failureLocations: locations };
}

/** Project the private built-in Vitest report; no error text, arbitrary metadata, or paths escape. */
export function desktopProofTestReport(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.testResults) || value.testResults.length > 4) {
    throw new Error("Invalid desktop test report");
  }
  const statuses = new Set(["passed", "failed", "pending", "skipped", "todo"]);
  return {
    totalTests: reportInteger(value.numTotalTests, 16),
    failedTests: reportInteger(value.numFailedTests, 16),
    failedSuites: reportInteger(value.numFailedTestSuites, 16),
    files: value.testResults.map((file) => {
      if (
        !isRecord(file) ||
        typeof file.name !== "string" ||
        !file.name.replaceAll("\\", "/").endsWith(`/${desktopTestFile}`) ||
        !Array.isArray(file.assertionResults) ||
        file.assertionResults.length > 16 ||
        (file.status !== "passed" && file.status !== "failed")
      ) {
        throw new Error("Unexpected desktop test report file");
      }
      return {
        file: desktopTestFile,
        status: file.status,
        suiteFailure: file.message ? publicTestFailure(file.message) : null,
        assertions: file.assertionResults.map((test, index) => {
          if (
            !isRecord(test) ||
            typeof test.status !== "string" ||
            !statuses.has(test.status) ||
            !Array.isArray(test.failureMessages) ||
            test.failureMessages.length > 8
          ) {
            throw new Error("Invalid desktop assertion report");
          }
          const meta = isRecord(test.meta) ? test.meta : {};
          const phase: (typeof desktopProofTestPhases)[number] | "unknown" =
            desktopProofTestPhases.find((candidate) => candidate === meta.desktopProofPhase) ??
            "unknown";
          return {
            index,
            status: test.status,
            phase,
            declarationLocation: isRecord(test.location)
              ? {
                  line: reportInteger(test.location.line, 100_000),
                  column: reportInteger(test.location.column, 100_000),
                }
              : null,
            failures: test.failureMessages.map(publicTestFailure),
            ...(meta.desktopGatewayReadiness === undefined
              ? {}
              : {
                  gatewayReadiness: desktopGatewayReadiness(meta.desktopGatewayReadiness),
                }),
            ...(test.status === "failed" && meta.desktopViewerResizeFailure !== undefined
              ? { viewerResize: desktopViewerResizeFailure(meta.desktopViewerResizeFailure) }
              : {}),
          };
        }),
      };
    }),
  };
}

export async function readDesktopProofTestReport(file: string) {
  const stat = await lstat(file);
  // Includes both bounded readiness histories and private Vitest failure logs before projection.
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) {
    throw new Error("Desktop test report must be a bounded regular file");
  }
  return desktopProofTestReport(JSON.parse(await readFile(file, "utf8")));
}

/** The joined child's last observed phase is evidence, not a completion or stall verdict. */
export async function readDesktopProofPhase(file: string) {
  const absent = {
    lastObservedPhase: null,
    owners: null,
  };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > desktopTerminationLimits.checkpoint) {
      return { status: "invalid" as const, ...absent };
    }
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size !== stat.size
    ) {
      return { status: "invalid" as const, ...absent };
    }
    const data = Buffer.alloc(stat.size);
    const read = await handle.read(data, 0, data.length, 0);
    const after = await handle.stat();
    const closing = handle;
    handle = undefined;
    await closing.close();
    if (
      read.bytesRead !== data.length ||
      after.size !== stat.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      return { status: "invalid" as const, ...absent };
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    } catch {
      return { status: "invalid" as const, ...absent };
    }
    const phase = isRecord(value)
      ? desktopProofTestPhases.find((candidate) => candidate === value.lastObservedPhase)
      : undefined;
    return phase
      ? {
          status: "available" as const,
          lastObservedPhase: phase,
          owners: desktopOwners(isRecord(value) ? value.owners : undefined),
          ...(isRecord(value) && value.termination !== undefined
            ? { termination: checkpointTermination(value.termination) }
            : {}),
        }
      : { status: "invalid" as const, ...absent };
  } catch {
    return { status: "unavailable" as const, ...absent };
  } finally {
    try {
      await handle?.close();
    } catch {
      /* Diagnostic cleanup must not replace the child error. */
    }
  }
}

export async function inspectDesktopSshdRuntimeDirectory(directory: string) {
  let symlink: boolean | null = null;
  try {
    symlink = (await lstat(directory)).isSymbolicLink();
    const target = await fsStat(directory);
    return {
      status: "present",
      symlink,
      directory: target.isDirectory(),
      rootOwned: target.uid === 0,
      groupOrWorldWritable: (target.mode & 0o022) !== 0,
    };
  } catch (error) {
    return {
      status:
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "missing"
          : "unavailable",
      symlink,
      directory: null,
      rootOwned: null,
      groupOrWorldWritable: null,
    };
  }
}

export function desktopProofSshdFailure(stderr: string) {
  if (stderr.length > 64 * 1024) {
    return "output-too-large";
  }
  const message = stripVTControlCharacters(stderr);
  // These are OpenSSH's fixed pre-test failures, never copied paths or error text.
  if (/^Missing privilege separation directory: /mu.test(message)) {
    return "privsep-directory-missing";
  }
  if (/^.+ must be owned by root and not group or world-writable\.\r?$/mu.test(message)) {
    return "privsep-directory-permissions";
  }
  if (/^Privilege separation user \S+ does not exist\r?$/mu.test(message)) {
    return "privsep-user-missing";
  }
  if (/^sshd: no hostkeys available -- exiting\.\r?$/mu.test(message)) {
    return "host-key-unavailable";
  }
  return "unclassified";
}

/** Preserve child ownership before fallible logging or evidence export can replace its error. */
export async function withDesktopProofCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
  recordFailure: (error: unknown) => void,
): Promise<T> {
  const errors: unknown[] = [];
  let result: T | undefined;
  try {
    result = await operation();
  } catch (error) {
    recordFailure(error);
    errors.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    recordFailure(error);
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Desktop proof operation or cleanup failed", {
      cause: errors[0],
    });
  }
  return result as T;
}

export function desktopProofCommit(head: string, rawCommit: string) {
  // Read stored headers, not traversal-derived parents hidden at shallow boundaries.
  const headers = (rawCommit.split("\n\n", 1)[0] ?? "").split("\n");
  return {
    head,
    tree: headers[0]?.startsWith("tree ") ? headers[0].slice(5) : "",
    parents: headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7)),
  };
}

export function desktopProofSource(
  actual: { head: string; tree: string; parents: string[] },
  expected: { checkout: string; head?: string; base?: string },
) {
  if (
    !sha.test(actual.head) ||
    !sha.test(actual.tree) ||
    actual.parents.some((parent) => !sha.test(parent)) ||
    actual.head !== expected.checkout
  ) {
    throw new Error("Desktop proof checkout identity mismatch");
  }
  let kind = "checkout";
  if (expected.head || expected.base) {
    if (!sha.test(expected.head ?? "") || !sha.test(expected.base ?? "")) {
      throw new Error("Desktop proof requires both PR event SHAs");
    }
    kind = actual.head === expected.head ? "pr-head" : "pr-merge";
    if (
      kind === "pr-merge" &&
      (actual.parents.length !== 2 || actual.parents[1] !== expected.head)
    ) {
      throw new Error("Desktop proof merge parents do not match the PR event");
    }
  }
  // Event base and the immutable test merge's first parent can differ on GitHub.
  return {
    ...actual,
    kind,
    prHead: expected.head || null,
    prEventBase: expected.base || null,
    testedBase: kind === "pr-merge" ? (actual.parents[0] ?? null) : null,
  };
}

function desktopProofSourceStatus(head: string, trackedPaths: Buffer, output: Buffer) {
  // Only names from the verified commit are public; the index can contain private new files.
  const tracked = new Set(trackedPaths.toString("utf8").split("\0"));
  const entries: Array<{ status: string; path: string }> = [];
  let totalEntries = 0;
  for (let offset = 0; offset < output.length;) {
    const end = output.indexOf(0, offset);
    totalEntries += 1;
    if (end < 0) {
      break;
    }
    // Count every bounded command record, but decode only a small prefix for publication.
    if (end < 64 * 1024 && end - offset <= 515 && entries.length < 32) {
      const record = output.toString("utf8", offset, end);
      const status = record.slice(0, 2);
      const name = record.slice(3);
      if (
        /^[ MTADU]{2} /u.test(record) &&
        status !== "  " &&
        name !== "." &&
        !path.posix.isAbsolute(name) &&
        name === path.posix.normalize(name) &&
        !/(?:^|\/)\.\.(?:\/|$)|[\\\p{C}\uFFFD]/u.test(name) &&
        tracked.has(name)
      ) {
        entries.push({ status, path: name });
      }
    }
    offset = end + 1;
  }
  return {
    head,
    bytes: output.length,
    totalEntries,
    entries,
    omittedEntries: totalEntries - entries.length,
  };
}

export type DesktopProofSourceStatus = ReturnType<typeof desktopProofSourceStatus>;

/** Record sanitized source facts before refusing a dirty checkout; never publish raw Git output. */
export async function readDesktopProofSource(
  runGit: (label: string, args: string[]) => Promise<Buffer>,
  expected: Parameters<typeof desktopProofSource>[1],
  recordStatus: (status: DesktopProofSourceStatus | null) => void,
) {
  recordStatus(null);
  const head = (await runGit("source-head", ["rev-parse", "--verify", "HEAD"])).toString().trim();
  const commit = await runGit("source-identity", ["cat-file", "commit", head]);
  const source = desktopProofSource(desktopProofCommit(head, commit.toString()), expected);
  const tracked = await runGit("source-files", [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    "--full-tree",
    head,
  ]);
  // NUL framing preserves filenames; disabling renames avoids a second pathname per record.
  // Keep this command last so the runner retains source-clean as the dirty-refusal phase.
  const status = await runGit("source-clean", [
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    "--untracked-files=all",
  ]);
  recordStatus(desktopProofSourceStatus(head, tracked, status));
  assert.equal(status.length, 0, "Desktop proof requires a clean source checkout");
  return source;
}

function geometry(value: unknown) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    Number(value.width) < 1 ||
    Number(value.height) < 1 ||
    Number(value.width) > 8192 ||
    Number(value.height) > 8192
  ) {
    throw new Error("Invalid desktop proof geometry");
  }
  return { width: Number(value.width), height: Number(value.height) };
}

export function desktopProofAssets(value: unknown) {
  if (!isRecord(value) || Object.keys(value).length < 1 || Object.keys(value).length > 64) {
    throw new Error("Missing or unbounded served assets");
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, hash]) => {
      if (
        !/^(?:index|desktop)[\w.-]*\.js$/u.test(name) ||
        typeof hash !== "string" ||
        !digest.test(hash)
      ) {
        throw new Error("Invalid served asset identity");
      }
      return [name, hash];
    }),
  ) as Record<string, string>;
}

export function sanitizeDesktopResizeProof(value: unknown, carrier: "node" | "ssh") {
  if (
    !isRecord(value) ||
    value.carrier !== carrier ||
    !isRecord(value.gateway) ||
    value.gateway.execution !== "built-process" ||
    value.gateway.readiness !== "readyz" ||
    value.gateway.minimal !== false ||
    !isRecord(value.observer) ||
    value.observer.evidence !== "endpoint-marker-brackets" ||
    value.observer.keyboardForwardedBytes !== 0 ||
    value.observer.resizeForwardedBytes !== 0 ||
    !isRecord(value.pixels) ||
    !Number.isSafeInteger(value.pixels.distinctSampledColors) ||
    Number(value.pixels.distinctSampledColors) <= 8 ||
    !Array.isArray(value.samples) ||
    value.samples.length !== desktopResizeStages.length ||
    (carrier === "node" &&
      (!isRecord(value.node) ||
        value.node.passwordAbsentFromObserve !== true ||
        value.node.disconnectClosedViewer !== true)) ||
    (carrier === "ssh" && value.node !== null)
  ) {
    throw new Error("Missing completed desktop carrier proof");
  }
  const samples = value.samples.map((sample, index) => {
    if (!isRecord(sample) || sample.stage !== desktopResizeStages[index]) {
      throw new Error("Missing desktop resize stage");
    }
    return { stage: desktopResizeStages[index], ...geometry(sample) };
  });
  // Never copy arbitrary fixture metadata, node IDs, diagnostics, or credentials.
  return {
    carrier,
    gateway: { execution: "built-process", readiness: "readyz", minimal: false },
    node:
      carrier === "node" ? { passwordAbsentFromObserve: true, disconnectClosedViewer: true } : null,
    observer: {
      evidence: "endpoint-marker-brackets",
      keyboardForwardedBytes: 0,
      resizeForwardedBytes: 0,
    },
    viewports: "native desktop windows; viewport-emulated mobile, not a physical phone",
    assets: desktopProofAssets(value.assets),
    samples,
    pixels: { distinctSampledColors: Number(value.pixels.distinctSampledColors) },
  };
}

/** Export a bounded allowlist, including useful partial captures after a failed test. */
export async function exportDesktopResizeProof(
  input: string,
  output: string,
  carrier: "node" | "ssh",
  budget = { entries: 0, bytes: 0 },
) {
  const allowed = new Set([
    "01-fit.png",
    "served-assets.json",
    "resize-proof.json",
    ...desktopResizeStages.flatMap((stage) => [`${stage}.png`, `${stage}-geometry.json`]),
  ]);
  const exported = new Set<string>();
  let proof: ReturnType<typeof sanitizeDesktopResizeProof> | undefined;
  await mkdir(output, { recursive: true });
  const visit = async (directory: string, depth: number) => {
    if (depth > 4) {
      throw new Error("Desktop proof directory depth exceeded");
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++budget.entries > 256 || entry.isSymbolicLink()) {
        throw new Error("Desktop proof entry bound or regular-file contract violated");
      }
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file, depth + 1);
        continue;
      }
      if (!allowed.has(entry.name)) {
        continue;
      }
      const stat = await lstat(file);
      budget.bytes += stat.size;
      if (
        !stat.isFile() ||
        stat.size > 8 * 1024 * 1024 ||
        budget.bytes > 64 * 1024 * 1024 ||
        exported.has(entry.name)
      ) {
        throw new Error("Desktop proof file bound or uniqueness contract violated");
      }
      const data = await readFile(file);
      let safe: unknown;
      if (entry.name.endsWith(".png")) {
        if (
          data.length < 33 ||
          !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          data.toString("ascii", 12, 16) !== "IHDR" ||
          data.readUInt32BE(16) < 1 ||
          data.readUInt32BE(16) > 8192 ||
          data.readUInt32BE(20) < 1 ||
          data.readUInt32BE(20) > 8192
        ) {
          throw new Error("Invalid desktop screenshot");
        }
      } else {
        const value: unknown = JSON.parse(data.toString("utf8"));
        if (entry.name === "resize-proof.json") {
          proof = sanitizeDesktopResizeProof(value, carrier);
          safe = proof;
        } else if (entry.name === "served-assets.json") {
          safe = desktopProofAssets(value);
        } else {
          const stage = entry.name.replace(/-geometry\.json$/u, "");
          if (
            !isRecord(value) ||
            value.stage !== stage ||
            typeof value.matchOffered !== "boolean"
          ) {
            throw new Error("Invalid desktop geometry evidence");
          }
          safe = {
            stage,
            expected: geometry(value.expected),
            guest: geometry(value.guest),
            canvas: geometry(value.canvas),
            matchOffered: value.matchOffered,
          };
        }
      }
      await writeFile(
        path.join(output, entry.name),
        safe === undefined ? data : `${JSON.stringify(safe, null, 2)}\n`,
      );
      exported.add(entry.name);
    }
  };
  await visit(input, 0);
  return { proof, complete: Boolean(proof) && exported.size === allowed.size };
}
