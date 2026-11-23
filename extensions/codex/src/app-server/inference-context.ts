import { randomUUID } from "node:crypto";
import {
  embeddedAgentLog,
  type AgentHarnessV2,
  type EmbeddedContextFile,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { defineCodexBuildState } from "../build-state.js";
import { readCodexInferenceMetadata, type CodexInferenceMetadata } from "./inference-metadata.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

export { CODEX_INFERENCE_GENERATION_KEY } from "./inference-metadata.js";
export type CodexPersonaContinuation = { responseId?: string; generation?: string };

const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_ACTIVE_ROOTS = 64;
const MAX_PREPARED_PREFIXES = 256;
const MAX_RETAINED_REQUEST_BYTES = 32 * 1024 * 1024;
export type CodexInferenceStreamParams = Parameters<
  NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>
>[0]["streamParams"];
type WorkspaceInstructions = {
  persona: string;
  requestLocal: string;
  files?: readonly EmbeddedContextFile[];
  profileId?: string;
};
type PersonaProjection = {
  contextWindowId?: string;
  base: { after: string; text: string };
  additions: { before: string; text: string }[];
};
type PreparedPrefix = {
  text: string;
  workspaceInstructions?: WorkspaceInstructions;
  projection?: PersonaProjection;
  pendingAddition?: string;
};
type PreparedRequest = {
  body: JsonObject;
  bytes: number;
  requestLocal?: string;
  projection?: PersonaProjection;
};
const retained = defineCodexBuildState("openclaw.codexPreparedRequests", () => ({
  requests: new Map<PreparedPrefix, PreparedRequest>(),
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

function retainRequest(prefix: PreparedPrefix, body: JsonObject, projection?: PersonaProjection) {
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
  const bytes =
    Buffer.byteLength(JSON.stringify(snapshot)) +
    (projection ? Buffer.byteLength(JSON.stringify(projection)) : 0);
  if (bytes > MAX_RETAINED_REQUEST_BYTES) {
    return;
  }
  while (retained.bytes + bytes > MAX_RETAINED_REQUEST_BYTES) {
    forgetRequest(retained.requests.keys().next().value);
  }
  retained.requests.set(prefix, {
    body: snapshot,
    bytes,
    requestLocal: projection ? prefix.workspaceInstructions?.requestLocal : undefined,
    projection,
  });
  retained.bytes += bytes;
}

// Codex assigns UUIDv7 IDs to history items (session.rs). Legacy Responses Lite
// also emits additional_tools, but as a prompt-only UUIDv5 item (client.rs).
const RECORDED_DECLARATION_ID =
  /^at_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function readIncrementalInput(body: JsonObject) {
  if (
    body.instructions !== undefined ||
    body.previous_response_id !== undefined ||
    body.generate === false ||
    body.store !== false ||
    !isJsonObject(body.reasoning) ||
    body.reasoning.context !== "all_turns" ||
    !Array.isArray(body.input)
  ) {
    return undefined;
  }
  for (const item of body.input) {
    if (
      isJsonObject(item) &&
      item.type === "additional_tools" &&
      item.role === "developer" &&
      typeof item.id === "string" &&
      RECORDED_DECLARATION_ID.test(item.id) &&
      Array.isArray(item.tools) &&
      item.tools.length > 0
    ) {
      return { input: body.input, declarationId: item.id };
    }
  }
  return undefined;
}

function getPersonaAddition(previous?: WorkspaceInstructions, current?: WorkspaceInstructions) {
  if (!previous?.files || !current?.files || previous.profileId !== current.profileId) {
    return undefined;
  }
  const sections: string[] = [];
  for (const file of previous.files) {
    const next = current.files.find((item) => item.path === file.path);
    if (!next || next.personalUser !== file.personalUser) {
      return undefined;
    }
    if (next.content !== file.content) {
      // Never append updates to a selected personal overlay. Rebase without the old text.
      if (file.personalUser || !next.content.startsWith(file.content + "\n")) {
        return undefined;
      }
    }
  }
  for (const file of current.files) {
    const prior = previous.files.find((item) => item.path === file.path);
    if (file.content === prior?.content) {
      continue;
    }
    if (file.personalUser) {
      return undefined;
    }
    const added = prior ? file.content.slice(prior.content.length + 1) : file.content;
    if (added.trim()) {
      sections.push(`### ${file.path}\n\n${added}`);
    }
  }
  return sections.length
    ? "Additional OpenClaw workspace instructions (earlier workspace instructions still apply):\n\n" +
        sections.join("\n\n")
    : undefined;
}

function insertPersona(input: JsonValue[], projection: PersonaProjection): JsonValue[] | undefined {
  const developerMessage = (text: string): JsonObject => ({
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text }],
  });
  const baseIndex = input.findIndex(
    (item) => isJsonObject(item) && item.id === projection.base.after,
  );
  if (baseIndex < 0) {
    return undefined;
  }
  let nextIndex = baseIndex + 1;
  const projected = [...input.slice(0, nextIndex), developerMessage(projection.base.text)];
  for (const addition of projection.additions) {
    const index = input.findIndex((item) => isJsonObject(item) && item.id === addition.before);
    if (index < nextIndex) {
      return undefined;
    }
    for (; nextIndex < index; nextIndex++) {
      projected.push(input[nextIndex]!);
    }
    projected.push(developerMessage(addition.text));
  }
  return [...projected, ...input.slice(nextIndex)];
}

function preparePersonaProjection(
  input: JsonValue[],
  declarationId: string,
  contextWindowId: string | undefined,
  persona: string,
  previous: PersonaProjection | undefined,
  pendingAddition: string | undefined,
) {
  if (previous?.base.after === declarationId && previous.contextWindowId === contextWindowId) {
    if (!pendingAddition && insertPersona(input, previous)) {
      return previous;
    }
    // The last native user item anchors the addition, even on an HTTP retry.
    const user = input.findLast(
      (item): item is JsonObject =>
        isJsonObject(item) &&
        item.type === "message" &&
        item.role === "user" &&
        typeof item.id === "string",
    );
    if (
      pendingAddition &&
      typeof user?.id === "string" &&
      previous.additions.length < 32 &&
      !previous.additions.some((addition) => addition.before === user.id)
    ) {
      const extended = {
        ...previous,
        additions: [...previous.additions, { before: user.id, text: pendingAddition }],
      };
      if (insertPersona(input, extended)) {
        return extended;
      }
    }
  }
  return { contextWindowId, base: { after: declarationId, text: persona }, additions: [] };
}

type Registration = {
  generation: string;
  text: string;
  workspaceInstructions?: WorkspaceInstructions;
  forkRequest?: PreparedRequest;
  denyToolCalls: boolean;
  streamParams?: CodexInferenceStreamParams;
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
      workspaceInstructions?: WorkspaceInstructions;
      signal: AbortSignal;
      assertCurrent: () => void;
      retainPrefix?: boolean;
      forkRequest?: PreparedRequest;
      denyToolCalls?: boolean;
      streamParams?: CodexInferenceStreamParams;
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
          workspaceInstructions: params.workspaceInstructions,
          forkRequest: params.forkRequest,
          denyToolCalls: params.denyToolCalls === true,
          streamParams: params.streamParams,
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
            registration.workspaceInstructions = undefined;
            registration.forkRequest = undefined;
            controller.abort();
            params.signal.removeEventListener("abort", registration.release);
          },
        };
        const previous = roots.get(params.threadId);
        roots.set(params.threadId, registration);
        previous?.release();
        if (params.retainPrefix !== false) {
          const prefix = prefixes.get(params.threadId);
          const workspace = params.workspaceInstructions;
          const previousWorkspace = prefix?.workspaceInstructions;
          if (
            prefix &&
            previousWorkspace?.persona === workspace?.persona &&
            previousWorkspace?.profileId === workspace?.profileId
          ) {
            prefix.text = params.text;
            prefix.workspaceInstructions = workspace;
          } else {
            const addition = getPersonaAddition(previousWorkspace, workspace);
            const projection =
              addition && !prefix?.pendingAddition ? prefix?.projection : undefined;
            forgetRequest(prefix);
            prefixes.set(params.threadId, {
              text: params.text,
              workspaceInstructions: workspace,
              projection,
              pendingAddition: projection ? addition : undefined,
            });
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
        forkRequest: request,
        retainPrefix: false,
        denyToolCalls: true,
        signal: params.signal,
        assertCurrent: () => {
          params.assertCurrent();
          const current = prefixes.get(params.sourceThreadId);
          if (current !== prefix && (current || prefix.workspaceInstructions)) {
            throw new Error("Codex side-question workspace instructions changed");
          }
        },
      });
    },
    forget(threadId: string) {
      forgetRequest(prefixes.get(threadId));
      prefixes.delete(threadId);
      roots.get(threadId)?.release();
    },
    /** Caller must authenticate its private transport before parsing any model request. */
    // Host-held OAuth may fund only admitted generations; native background work has no such grant.
    prepare(
      body: JsonObject,
      preparedMetadata?: CodexInferenceMetadata,
      requireAdmission = false,
      transport: "http" | "websocket" = "http",
      continuation?: CodexPersonaContinuation,
    ) {
      assertOpen();
      const metadata = preparedMetadata ?? readCodexInferenceMetadata(body);
      const child = Boolean(metadata.parentThreadId || metadata.subagentKind || metadata.subagent);
      const kind = metadata.requestKind;
      const projectedDelta =
        kind === "turn" &&
        !child &&
        transport === "websocket" &&
        continuation?.generation !== undefined &&
        body.previous_response_id === continuation.responseId;
      if (transport === "websocket" && continuation && body.previous_response_id !== undefined) {
        if (
          body.previous_response_id !== continuation.responseId ||
          (continuation.generation !== undefined &&
            (!projectedDelta || continuation.generation !== metadata.generation))
        ) {
          throw new Error("Codex persona continuation has no current admitted response");
        }
      }
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
      let matchedForkPrefix = false;
      let personaGeneration: string | undefined;
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
        const forkRequest = registration.forkRequest;
        const prefix = forkRequest?.body;
        const inputTools = Array.isArray(prefix?.input)
          ? prefix.input.find((item) => isJsonObject(item) && item.type === "additional_tools")
          : prefix?.inputTools;
        const input =
          prefix && Array.isArray(body.input)
            ? forkRequest?.projection
              ? body.input
              : body.input.map((item) =>
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
          matchedForkPrefix = true;
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
        const { maxTokens, temperature } = registration.streamParams ?? {};
        if (maxTokens !== undefined || temperature !== undefined) {
          preparedBody = {
            ...preparedBody,
            ...(maxTokens !== undefined ? { max_output_tokens: maxTokens } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
          };
        }
        const retainedPrefix = metadata.threadId ? prefixes.get(metadata.threadId) : undefined;
        const persona = registration.workspaceInstructions?.persona;
        const requestLocal = forkRequest
          ? forkRequest.requestLocal
          : registration.workspaceInstructions?.requestLocal;
        const wire = persona || forkRequest?.projection ? readIncrementalInput(body) : undefined;
        let projection: PersonaProjection | undefined;
        if (wire && Array.isArray(preparedBody.input)) {
          if (retainedPrefix && persona) {
            projection = preparePersonaProjection(
              wire.input,
              wire.declarationId,
              metadata.contextWindowId,
              persona,
              retainedPrefix.projection,
              retainedPrefix.pendingAddition,
            );
            retainedPrefix.projection = projection;
            retainedPrefix.pendingAddition = undefined;
          } else if (matchedForkPrefix) {
            projection = forkRequest?.projection;
          }
        }
        if (retainedPrefix) {
          // Side questions match the native history, then apply the exact projection
          // for the sampled parent request. Neither projection mutates native history.
          retainRequest(retainedPrefix, preparedBody, projection);
        }
        const projectedInput =
          projection && Array.isArray(preparedBody.input)
            ? insertPersona(preparedBody.input, projection)
            : undefined;
        if (projectedInput || projectedDelta) {
          const { instructions: _legacyInstructions, ...native } = preparedBody;
          const nativeInstructions = projectedDelta ? body.instructions : undefined;
          const instructions =
            typeof nativeInstructions === "string"
              ? requestLocal
                ? nativeInstructions + "\n\n" + requestLocal
                : nativeInstructions
              : requestLocal || undefined;
          preparedBody = {
            ...native,
            ...(projectedInput ? { input: projectedInput } : {}),
            ...(instructions === undefined ? {} : { instructions }),
          };
          personaGeneration = registration.generation;
        }
      }
      return {
        body: preparedBody,
        assertCurrent: registration.assertCurrent,
        signal: registration.controller.signal,
        personaGeneration,
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
