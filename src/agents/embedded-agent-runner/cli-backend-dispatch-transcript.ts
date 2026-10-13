import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import {
  acquireSessionActorStorage,
  captureSessionActorStorageOwner,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ToolResultMessage } from "../../llm/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AgentMessage } from "../runtime/index.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../stream-message-shared.js";

const log = createSubsystemLogger("agents/embedded-cli-dispatch");

type CliDispatchTranscriptToolEvent = {
  phase: "start" | "result";
  toolName: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  resultContentSource?: "network";
};

// The CLI writes no OpenClaw transcript. Mirror tools immediately for live readers,
// but batch assistant deltas until abort or finalization for partial-text salvage.
export function createCliDispatchTranscriptRecorder(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  storePath?: string;
  sessionFile?: string;
  runId: string;
  prompt: string;
  provider: string;
  model?: string;
  cwd?: string;
  config?: OpenClawConfig;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
  senderIsOwner?: boolean;
}) {
  let tail: Promise<void> = Promise.resolve();
  let lastAssistantText = "";
  let lastWrittenAssistantText = "";
  let finalized = false;
  let turnTainted = false;
  let toolRecordSequence = 0;

  const scope = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    expectedLifecycleRevision: params.expectedLifecycleRevision,
    expectedWriterRunId: params.expectedWriterRunId,
  };
  const memory = captureSessionActorStorageOwner(scope, { assertCurrent() {}, authorize() {} });
  if (memory) {
    scope.agentId = memory.agentId;
    scope.storePath = memory.path;
  }
  const selected = acquireSessionActorStorage(scope, {
    lifetime: { assertCurrent() {}, assertReadable() {} },
    authority: { assertCurrent() {}, authorize() {} },
  });
  // Attach a handler now; the FIFO reports acquisition failure with append failures.
  void selected.catch(() => {});

  const enqueue = (build: () => AgentMessage) => {
    tail = tail.then(async () => {
      const append = () =>
        appendTranscriptMessage(scope, {
          message: build(),
          config: params.config,
          cwd: params.cwd,
        });
      // Events accepted into this FIFO settle even when the run is stopped.
      // Keep their original actor; event callbacks need not retain its ambient scope.
      const binding = await selected;
      if (memory && !binding) {
        return;
      }
      await (binding ? runWithSessionActorStorage(binding, append) : append());
    });
    // Transcript mirroring is best-effort; a failed append must not fail the
    // run or poison later appends in the chain.
    tail = tail.catch((error: unknown) => {
      log.warn(
        `cli dispatch transcript append failed: runId=${params.runId} error=${String(error)}`,
      );
    });
  };

  const model = {
    api: "cli",
    provider: params.provider,
    id: params.model ?? "",
  };

  type AssistantBuildParams = Parameters<typeof buildAssistantMessage>[0];
  // Mirrored records carry zero usage: the CLI child's token accounting is
  // not visible on this bridge, and cost fields must not invent values.
  const buildZeroUsageAssistantMessage = (
    content: AssistantBuildParams["content"],
    stopReason: AssistantBuildParams["stopReason"],
    tainted = turnTainted,
  ) => {
    const message = buildAssistantMessage({
      model,
      content,
      stopReason,
      usage: buildUsageWithNoCost({}),
    });
    return tainted ? ({ ...message, __openclaw: { turnTainted: true } } as AgentMessage) : message;
  };
  const appendAssistantSnapshot = (text: string, stopReason: "aborted" | "stop") => {
    if (text && text !== lastWrittenAssistantText) {
      lastWrittenAssistantText = text;
      enqueue(() => buildZeroUsageAssistantMessage([{ type: "text", text }], stopReason));
    }
  };

  enqueue(() => ({
    role: "user",
    content: [{ type: "text", text: params.prompt }],
    timestamp: Date.now(),
    ...(params.senderIsOwner !== undefined
      ? { __openclaw: { senderIsOwner: params.senderIsOwner } }
      : {}),
  }));

  return {
    noteToolEvent: (event: CliDispatchTranscriptToolEvent) => {
      if (finalized) {
        return;
      }
      toolRecordSequence += 1;
      const toolCallId =
        event.toolCallId?.trim() || `${params.runId}-tool-${String(toolRecordSequence)}`;
      if (event.phase === "start") {
        const taintedAtStart = turnTainted;
        enqueue(() =>
          buildZeroUsageAssistantMessage(
            [
              {
                type: "toolCall",
                id: toolCallId,
                name: event.toolName,
                arguments: event.args ?? {},
              },
            ],
            "toolUse",
            taintedAtStart,
          ),
        );
        return;
      }
      turnTainted ||= event.resultContentSource === "network";
      enqueue(() => ({
        role: "toolResult",
        toolCallId,
        toolName: event.toolName,
        content: normalizeToolResultContent(event.result),
        details: asOptionalObjectRecord(asOptionalObjectRecord(event.result)?.details),
        isError: event.isError === true,
        timestamp: Date.now(),
        ...(event.resultContentSource
          ? { __openclaw: { resultContentSource: event.resultContentSource } }
          : {}),
      }));
    },
    noteAssistantText: (text: string) => {
      if (!finalized && text.trim()) {
        lastAssistantText = text;
      }
    },
    // Flush before the CLI child settles so timeout salvage can read partial text.
    flushAssistantSnapshot: () => {
      if (finalized) {
        return;
      }
      appendAssistantSnapshot(lastAssistantText.trim(), "aborted");
    },
    finalize: async (finalText?: string) => {
      if (!finalized) {
        finalized = true;
        appendAssistantSnapshot(finalText?.trim() || lastAssistantText.trim(), "stop");
      }
      await tail;
      await selected.then(
        (binding) => binding?.actor.release(),
        () => {},
      );
    },
  };
}

/** Maps a sanitized CLI tool result onto transcript content blocks. */
function normalizeToolResultContent(result: unknown): ToolResultMessage["content"] {
  if (typeof result === "string") {
    return result ? [{ type: "text", text: result }] : [];
  }
  // Claude stream-json echoes MCP tool_result content as a bare block array.
  const content = Array.isArray(result) ? result : asOptionalObjectRecord(result)?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap<ToolResultMessage["content"][number]>((block) => {
    if (typeof block === "string") {
      return [{ type: "text", text: block }];
    }
    const record = asOptionalObjectRecord(block);
    if (!record) {
      return [];
    }
    const { type, text, data, mimeType } = record;
    if (type === "text" && typeof text === "string") {
      return [{ type: "text", text }];
    }
    if (type === "image" && typeof data === "string" && typeof mimeType === "string") {
      return [{ type: "image", data, mimeType }];
    }
    return [];
  });
}
