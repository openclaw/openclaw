import { randomUUID } from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { defineCodexBuildState } from "../build-state.js";
import { readCodexInferenceMetadata, type CodexInferenceMetadata } from "./inference-metadata.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

export { CODEX_INFERENCE_GENERATION_KEY } from "./inference-metadata.js";

const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_ACTIVE_ROOTS = 64;
const MAX_PREPARED_PREFIXES = 256;
const MAX_RETAINED_REQUEST_BYTES = 32 * 1024 * 1024;
type PreparedPrefix = { text: string };
const retained = defineCodexBuildState("openclaw.codexPreparedRequests", () => ({
  requests: new Map<PreparedPrefix, { body: JsonObject; bytes: number }>(),
  bytes: 0,
}))();

function forgetRequest(prefix: PreparedPrefix | undefined) {
  if (!prefix) {
    return;
  }
  const request = retained.requests.get(prefix);
  if (request) {
    retained.bytes -= request.bytes;
    retained.requests.delete(prefix);
  }
}

function retainRequest(prefix: PreparedPrefix, body: JsonObject) {
  const previous = retained.requests.get(prefix)?.body;
  forgetRequest(prefix);
  const continuation = body.previous_response_id != null;
  const snapshot: JsonObject = {};
  for (const key of ["instructions", "tools", "input", "prompt_cache_key"]) {
    // A WS delta cannot stand in for full history. Only declarations survive it.
    if (continuation && key === "input") {
      continue;
    }
    const value = body[key] ?? (continuation ? previous?.[key] : undefined);
    if (value !== undefined) {
      snapshot[key] = value;
    }
  }
  if (continuation) {
    const inputTools = Array.isArray(previous?.input)
      ? previous.input.find((item) => isJsonObject(item) && item.type === "additional_tools")
      : previous?.inputTools;
    if (inputTools !== undefined) {
      snapshot.inputTools = inputTools;
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (bytes > MAX_RETAINED_REQUEST_BYTES) {
    return;
  }
  while (retained.bytes + bytes > MAX_RETAINED_REQUEST_BYTES) {
    forgetRequest(retained.requests.keys().next().value);
  }
  retained.requests.set(prefix, { body: snapshot, bytes });
  retained.bytes += bytes;
}

type Registration = {
  generation: string;
  text: string;
  forkPrefix?: JsonObject;
  denyToolCalls: boolean;
  controller: AbortController;
  assertCurrent: () => void;
  release: () => void;
};

/** One physical inference transport owns these confidential, nonpersistent snapshots. */
export function createCodexInferenceContext(assertClientCurrent: () => void) {
  const roots = new Map<string, Registration>();
  // Prepared bytes survive turn settlement, but confer no execution authority.
  const prefixes = new Map<string, PreparedPrefix>();
  const waiters = new Set<{ admit: () => void; cancel: (error: unknown) => void }>();
  const drain = () => {
    while (roots.size < MAX_ACTIVE_ROOTS && waiters.size > 0) {
      waiters.values().next().value?.admit();
    }
  };
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Codex parent-local inference transport is closed");
    }
    assertClientCurrent();
  };
  return {
    async register(params: {
      threadId: string;
      text: string;
      signal: AbortSignal;
      assertCurrent: () => void;
      retainPrefix?: boolean;
      forkPrefix?: JsonObject;
      denyToolCalls?: boolean;
    }) {
      assertOpen();
      params.signal.throwIfAborted();
      params.assertCurrent();
      if (Buffer.byteLength(params.text) > MAX_CONTEXT_BYTES) {
        throw new Error("Codex parent-local context exceeds the 256 KiB inference limit");
      }
      const admit = () => {
        assertOpen();
        params.signal.throwIfAborted();
        params.assertCurrent();
        if (
          params.retainPrefix !== false &&
          !prefixes.has(params.threadId) &&
          prefixes.size >= MAX_PREPARED_PREFIXES
        ) {
          throw new Error(
            "Codex prepared inference prefix limit reached; reconnect before retrying",
          );
        }
        const controller = new AbortController();
        const registration: Registration = {
          generation: randomUUID(),
          text: params.text,
          forkPrefix: params.forkPrefix,
          denyToolCalls: params.denyToolCalls === true,
          controller,
          assertCurrent: () => {
            assertOpen();
            controller.signal.throwIfAborted();
            params.signal.throwIfAborted();
            params.assertCurrent();
            if (roots.get(params.threadId) !== registration) {
              throw new Error("Codex parent-local inference generation was replaced");
            }
          },
          release: () => {
            if (roots.get(params.threadId) === registration) {
              roots.delete(params.threadId);
              drain();
            }
            registration.text = "";
            controller.abort();
            params.signal.removeEventListener("abort", registration.release);
          },
        };
        const previous = roots.get(params.threadId);
        roots.set(params.threadId, registration);
        previous?.release();
        if (params.retainPrefix !== false) {
          const prefix = prefixes.get(params.threadId);
          if (prefix) {
            prefix.text = params.text;
          } else {
            prefixes.set(params.threadId, { text: params.text });
          }
        }
        params.signal.addEventListener("abort", registration.release, { once: true });
        return { generation: registration.generation, release: registration.release };
      };
      if (roots.has(params.threadId) || roots.size < MAX_ACTIVE_ROOTS) {
        return admit();
      }
      embeddedAgentLog.debug("codex parent-local inference waiting for an active root", {
        limit: MAX_ACTIVE_ROOTS,
        waiting: waiters.size + 1,
      });
      return new Promise<ReturnType<typeof admit>>((resolve, reject) => {
        const remove = () => {
          waiters.delete(waiter);
          params.signal.removeEventListener("abort", onAbort);
        };
        const waiter = {
          admit: () => {
            remove();
            try {
              resolve(admit());
            } catch (error) {
              reject(toErrorObject(error, "Codex inference root admission failed"));
            }
          },
          cancel: (error: unknown) => {
            remove();
            reject(toErrorObject(error, "Codex inference root admission cancelled"));
          },
        };
        const onAbort = () => waiter.cancel(params.signal.reason);
        waiters.add(waiter);
        params.signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    /** A retained prefix is data; only the new root's caller grants model authority. */
    async fork(params: {
      sourceThreadId: string;
      threadId: string;
      signal: AbortSignal;
      assertCurrent: () => void;
    }) {
      assertOpen();
      const prefix = prefixes.get(params.sourceThreadId);
      if (!prefix) {
        throw new Error("Cache-parity fork has no prepared parent inference context.");
      }
      const request = retained.requests.get(prefix);
      if (request) {
        // LRU is global across private routes; active forks keep their admitted snapshot.
        retained.requests.delete(prefix);
        retained.requests.set(prefix, request);
      }
      return this.register({
        threadId: params.threadId,
        text: prefix.text,
        forkPrefix: request?.body,
        retainPrefix: false,
        denyToolCalls: true,
        signal: params.signal,
        assertCurrent: params.assertCurrent,
      });
    },
    forget(threadId: string) {
      forgetRequest(prefixes.get(threadId));
      prefixes.delete(threadId);
      roots.get(threadId)?.release();
    },
    /** Caller must authenticate its private transport before parsing any model request. */
    // Host-held OAuth may fund only admitted generations; native background work has no such grant.
    prepare(body: JsonObject, preparedMetadata?: CodexInferenceMetadata, requireAdmission = false) {
      assertOpen();
      const metadata = preparedMetadata ?? readCodexInferenceMetadata(body);
      const child = Boolean(metadata.parentThreadId || metadata.subagentKind || metadata.subagent);
      const kind = metadata.requestKind;
      // Native children/reviewers and compaction/memory keep their original instructions.
      if (!requireAdmission && (child || kind === "compaction" || kind === "memory")) {
        return { body, assertCurrent: assertOpen, signal: undefined };
      }
      if (
        child ||
        (kind !== "turn" && kind !== "prewarm" && !(requireAdmission && kind === "compaction"))
      ) {
        throw new Error("Codex inference request has an unsupported native purpose");
      }
      const registration = metadata.threadId ? roots.get(metadata.threadId) : undefined;
      const generation = metadata.generation;
      // Startup prewarm precedes host admission; it must never borrow a later turn's persona.
      if (
        !requireAdmission &&
        kind === "prewarm" &&
        body.generate === false &&
        generation == null
      ) {
        return { body, assertCurrent: assertOpen, signal: undefined };
      }
      if (!registration || generation !== registration.generation) {
        throw new Error("Codex inference has no current admitted parent generation");
      }
      registration.assertCurrent();
      let preparedBody = body;
      if (kind !== "compaction") {
        // Responses Lite carries native base instructions in input and omits this optional field.
        const instructions = body.instructions;
        if (instructions !== undefined && typeof instructions !== "string") {
          throw new Error("Codex inference request has invalid top-level instructions");
        }
        if (registration.text) {
          preparedBody = {
            ...body,
            instructions:
              instructions === undefined
                ? registration.text
                : instructions + "\n\n" + registration.text,
          };
        }
      }
      if (kind === "turn") {
        const prefix = registration.forkPrefix;
        const inputTools = Array.isArray(prefix?.input)
          ? prefix.input.find((item) => isJsonObject(item) && item.type === "additional_tools")
          : prefix?.inputTools;
        const input =
          prefix && Array.isArray(body.input)
            ? body.input.map((item) =>
                isJsonObject(inputTools) && isJsonObject(item) && item.type === "additional_tools"
                  ? inputTools
                  : item,
              )
            : undefined;
        // Only a complete matching prefix proves where current native history begins.
        // A changed/compacted history uses native reconstruction rather than losing its tail.
        if (
          prefix &&
          Array.isArray(prefix.input) &&
          input &&
          prefix.input.length <= input.length &&
          prefix.input.every((item, index) => JSON.stringify(item) === JSON.stringify(input[index]))
        ) {
          // Native thread/fork reconstructs persisted history and settings. Replay the
          // last actual wire prefix instead, without normalizing any prompt or schema.
          preparedBody = { ...body };
          delete preparedBody.previous_response_id;
          for (const key of ["instructions", "tools", "input"]) {
            delete preparedBody[key];
          }
          for (const key of ["instructions", "tools", "input", "prompt_cache_key"]) {
            const value = prefix[key];
            if (value !== undefined) {
              preparedBody[key] = value;
            }
          }
          preparedBody.input = [...prefix.input, ...input.slice(prefix.input.length)];
        } else if (prefix) {
          // Native history owns the tail; the retained request still owns prepared
          // instructions and declarations, independently of input-prefix equality.
          preparedBody = {
            ...preparedBody,
            ...(prefix.tools !== undefined ? { tools: prefix.tools } : {}),
            ...(input ? { input } : {}),
          };
          delete preparedBody.instructions;
          if (prefix.instructions !== undefined) {
            preparedBody.instructions = prefix.instructions;
          }
        }
        if (registration.denyToolCalls) {
          preparedBody = { ...preparedBody, tool_choice: "none" };
        }
        const retainedPrefix = metadata.threadId ? prefixes.get(metadata.threadId) : undefined;
        if (retainedPrefix) {
          retainRequest(retainedPrefix, preparedBody);
        }
      }
      return {
        body: preparedBody,
        assertCurrent: registration.assertCurrent,
        signal: registration.controller.signal,
      };
    },
    close() {
      closed = true;
      for (const waiter of waiters) {
        waiter.cancel(new Error("Codex parent-local inference transport is closed"));
      }
      for (const prefix of prefixes.values()) {
        forgetRequest(prefix);
      }
      prefixes.clear();
      for (const registration of roots.values()) {
        registration.release();
      }
    },
  };
}
