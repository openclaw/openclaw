import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AgentMessage } from "../runtime/index.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../stream-message-shared.js";

const log = createSubsystemLogger("agents/embedded-cli-dispatch");

type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type CliDispatchTranscriptToolEvent = {
  phase: "start" | "result";
  toolName: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  resultContentSource?: "network";
};

type CliDispatchTranscriptRecorder = {
  noteToolEvent: (event: CliDispatchTranscriptToolEvent) => void;
  noteAssistantText: (text: string) => void;
  /** Flushes on abort before the CLI child settles so timeout salvage can read partial text. */
  flushAssistantSnapshot: () => void;
  /** Appends the final assistant snapshot and drains pending writes. */
  finalize: (finalText?: string) => Promise<void>;
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
}): CliDispatchTranscriptRecorder {
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

  const enqueue = (build: () => AgentMessage) => {
    tail = tail.then(async () => {
      await appendTranscriptMessage(scope, {
        message: build(),
        config: params.config,
        cwd: params.cwd,
      });
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

  enqueue(() => ({
    role: "user",
    content: [{ type: "text", text: params.prompt }],
    timestamp: Date.now(),
    ...(params.senderIsOwner !== undefined
      ? { __openclaw: { senderIsOwner: params.senderIsOwner } }
      : {}),
  }));

  return {
    noteToolEvent: (event) => {
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
    noteAssistantText: (text) => {
      if (!finalized && text.trim()) {
        lastAssistantText = text;
      }
    },
    flushAssistantSnapshot: () => {
      if (finalized) {
        return;
      }
      const text = lastAssistantText.trim();
      if (!text || text === lastWrittenAssistantText) {
        return;
      }
      lastWrittenAssistantText = text;
      enqueue(() => buildZeroUsageAssistantMessage([{ type: "text", text }], "aborted"));
    },
    finalize: async (finalText) => {
      if (finalized) {
        await tail;
        return;
      }
      finalized = true;
      const text = finalText?.trim() || lastAssistantText.trim();
      if (text && text !== lastWrittenAssistantText) {
        lastWrittenAssistantText = text;
        enqueue(() => buildZeroUsageAssistantMessage([{ type: "text", text }], "stop"));
      }
      await tail;
    },
  };
}

/** Maps a sanitized CLI tool result onto transcript content blocks. */
function normalizeToolResultContent(result: unknown): ToolResultContent[] {
  if (typeof result === "string") {
    return result ? [{ type: "text", text: result }] : [];
  }
  // Claude stream-json echoes MCP tool_result content as a bare block array.
  const content = Array.isArray(result) ? result : asOptionalObjectRecord(result)?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: ToolResultContent[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      blocks.push({ type: "text", text: block });
      continue;
    }
    const record = asOptionalObjectRecord(block);
    if (!record) {
      continue;
    }
    const { type, text, data, mimeType } = record;
    if (type === "text" && typeof text === "string") {
      blocks.push({ type: "text", text });
      continue;
    }
    if (type === "image" && typeof data === "string" && typeof mimeType === "string") {
      blocks.push({ type: "image", data, mimeType });
    }
  }
  return blocks;
}
