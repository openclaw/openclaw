import { randomUUID } from "node:crypto";
import { isJsonObject, type JsonObject } from "./protocol.js";

const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_ACTIVE_ROOTS = 64;
export const CODEX_INFERENCE_GENERATION_KEY = "openclaw_inference_generation";

type Registration = {
  generation: string;
  text: string;
  controller: AbortController;
  assertCurrent: () => void;
  release: () => void;
};

/** One physical inference transport owns these confidential, nonpersistent snapshots. */
export function createCodexInferenceContext(assertClientCurrent: () => void) {
  const roots = new Map<string, Registration>();
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Codex parent-local inference transport is closed");
    }
    assertClientCurrent();
  };
  return {
    register(params: {
      threadId: string;
      text: string;
      signal: AbortSignal;
      assertCurrent: () => void;
    }) {
      assertOpen();
      params.signal.throwIfAborted();
      params.assertCurrent();
      if (Buffer.byteLength(params.text) > MAX_CONTEXT_BYTES) {
        throw new Error("Codex parent-local context exceeds the 256 KiB inference limit");
      }
      if (!roots.has(params.threadId) && roots.size >= MAX_ACTIVE_ROOTS) {
        throw new Error("Codex parent-local inference root limit reached");
      }
      roots.get(params.threadId)?.release();
      const controller = new AbortController();
      const registration: Registration = {
        generation: randomUUID(),
        text: params.text,
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
          }
          registration.text = "";
          controller.abort();
          params.signal.removeEventListener("abort", registration.release);
        },
      };
      roots.set(params.threadId, registration);
      params.signal.addEventListener("abort", registration.release, { once: true });
      return { generation: registration.generation, release: registration.release };
    },
    /** Caller must authenticate its private transport before parsing any model request. */
    prepare(body: JsonObject) {
      assertOpen();
      const metadata = isJsonObject(body.client_metadata) ? body.client_metadata : undefined;
      const raw = metadata?.["x-codex-turn-metadata"];
      if (typeof raw !== "string" || Buffer.byteLength(raw) > 1024 * 1024) {
        throw new Error("Codex inference request is missing bounded native metadata");
      }
      const value: unknown = JSON.parse(raw);
      if (!isJsonObject(value)) {
        throw new Error("Codex inference request has invalid native metadata");
      }
      const threadId = value.thread_id;
      // Native memory requests omit nested turn identity; only present IDs can disagree.
      if (metadata?.thread_id != null && threadId != null && metadata.thread_id !== threadId) {
        throw new Error("Codex inference thread metadata disagrees");
      }
      const child = Boolean(
        value.parent_thread_id ||
        value.subagent_kind ||
        metadata?.["x-openai-subagent"] ||
        metadata?.["x-codex-parent-thread-id"],
      );
      const kind = value.request_kind;
      // Native children/reviewers and compaction/memory keep their original instructions.
      if (child || kind === "compaction" || kind === "memory") {
        return { body, assertCurrent: assertOpen, signal: undefined };
      }
      if (kind !== "turn" && kind !== "prewarm") {
        throw new Error("Codex inference request has an unsupported native purpose");
      }
      const registration = typeof threadId === "string" ? roots.get(threadId) : undefined;
      const generation = value[CODEX_INFERENCE_GENERATION_KEY];
      // Startup prewarm precedes host admission; it must never borrow a later turn's persona.
      if (kind === "prewarm" && body.generate === false && generation == null) {
        return { body, assertCurrent: assertOpen, signal: undefined };
      }
      if (!registration || generation !== registration.generation) {
        throw new Error("Codex inference has no current admitted parent generation");
      }
      registration.assertCurrent();
      // Responses Lite carries native base instructions in input and omits this optional field.
      const instructions = body.instructions;
      if (instructions !== undefined && typeof instructions !== "string") {
        throw new Error("Codex inference request has invalid top-level instructions");
      }
      return {
        body: registration.text
          ? {
              ...body,
              instructions:
                instructions === undefined
                  ? registration.text
                  : instructions + "\n\n" + registration.text,
            }
          : body,
        assertCurrent: registration.assertCurrent,
        signal: registration.controller.signal,
      };
    },
    close() {
      closed = true;
      for (const registration of roots.values()) {
        registration.release();
      }
    },
  };
}
