import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { sanitizeChatHistoryMessages } from "../../gateway/chat-display-projection.sanitize.js";
import type { AssistantMessage } from "../../llm/types.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/hook-types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  onInternalSessionTranscriptUpdate,
  readSessionTranscriptRunId,
  type InternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { isIntermediateAssistantTranscriptMessage } from "../embedded-agent-runner/message-visibility.js";
import { persistCliAssistantTranscript } from "./cli-run-transcript.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cli-coordination-transcript-");
afterEach(() => resetGlobalHookRunner());

it.each([
  {
    sourceTool: "sessions_send",
    hidden: true,
    rewrite: false,
    block: false,
    prepare: false,
    replacement: false,
  },
  {
    sourceTool: "subagent_announce",
    hidden: false,
    rewrite: false,
    block: false,
    prepare: false,
    replacement: false,
  },
  {
    sourceTool: "subagent_announce",
    hidden: false,
    rewrite: false,
    block: false,
    prepare: false,
    replacement: true,
  },
  {
    sourceTool: "subagent_announce",
    hidden: false,
    rewrite: true,
    block: false,
    prepare: false,
    replacement: true,
  },
  {
    sourceTool: "subagent_announce",
    hidden: false,
    rewrite: false,
    block: true,
    prepare: false,
    replacement: true,
  },
  {
    sourceTool: "subagent_announce",
    hidden: false,
    rewrite: false,
    block: false,
    prepare: true,
    replacement: false,
  },
])(
  "preserves CLI $sourceTool receipts and display policy through replacement hooks",
  async ({ sourceTool, hidden, rewrite, block, prepare, replacement }) => {
    const root = sessionDirs.make();
    const target = {
      agentId: "main",
      sessionId: "cli-coordination-session",
      sessionKey: "agent:main:cli-coordination",
      storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: Date.now() },
    });
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "rewrite-output",
      hookName: "before_message_write",
      source: "test",
      handler: ({ message }: PluginHookBeforeMessageWriteEvent) => {
        if (message.role !== "assistant") {
          return { message };
        }
        const preparedMessage = { ...message };
        if (replacement) {
          Reflect.deleteProperty(preparedMessage, "__openclaw");
        }
        if (rewrite) {
          preparedMessage.content = [{ type: "text", text: "Rewritten answer" }];
        }
        return {
          block,
          message: {
            ...preparedMessage,
            display: true,
          },
        };
      },
    });
    initializeGlobalHookRunner(registry);
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const result = await persistCliAssistantTranscript({
        runParams: {
          ...target,
          sessionFile: `sqlite://agents/main/${target.sessionId}`,
          workspaceDir: root,
          prompt: "Review the worker result",
          provider: "claude-cli",
          runId: "cli-coordination-run",
          timeoutMs: 1_000,
          persistAssistantTranscript: true,
          prepareAssistantTranscriptMessage: prepare
            ? (message) => {
                const preparedMessage = { ...message };
                Reflect.deleteProperty(preparedMessage, "__openclaw");
                return preparedMessage;
              }
            : undefined,
          inputProvenance: { kind: "inter_session", sourceTool, sourceRole: "subagent" },
        },
        text: "The worker result passed validation",
        modelId: "claude-sonnet-4-6",
        stopReason: "stop",
        transcriptTextReceipt: {
          provider: "claude-cli",
          cliSessionId: "native-session",
          messages: [
            {
              externalId: "native-assistant",
              textSha256: sha256Hex("The worker result passed validation"),
            },
          ],
        },
      });
      expect(result.owned).toBe(true);
      const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
        typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
      );
      if (block) {
        expect(messages).toHaveLength(0);
        expect(updates).toHaveLength(0);
        return;
      }
      if (rewrite) {
        expect(messages).toHaveLength(1);
        expect(messages[0]).not.toHaveProperty("__openclaw.cliAssistantTextReceipt");
        expect(messages[0]).toMatchObject({
          content: [{ type: "text", text: "Rewritten answer" }],
        });
        return;
      }
      expect(messages).toMatchObject([
        {
          role: "assistant",
          content: [{ type: "text", text: "The worker result passed validation" }],
          __openclaw: {
            cliAssistantTextReceipt: {
              provider: "claude-cli",
              cliSessionId: "native-session",
              messages: [
                {
                  externalId: "native-assistant",
                  textSha256: sha256Hex("The worker result passed validation"),
                },
              ],
            },
          },
        },
      ]);
      expect(Reflect.get(messages[0]!, "display") === false).toBe(hidden);
      expect(updates).toHaveLength(1);
      expect(Reflect.get(updates[0]!.message!, "display") === false).toBe(hidden);
      if (!replacement && !prepare) {
        expect(readSessionTranscriptRunId(updates[0]!.message)).toBe("cli-coordination-run");
      }
    } finally {
      unsubscribe();
    }
  },
);

it.each([
  { kind: "completed", yielded: undefined, stopReason: "stop" },
  { kind: "yielded", yielded: true, stopReason: "stop" },
  { kind: "interrupted after yielding", yielded: true, stopReason: "aborted" },
] as const)(
  "prepares the $kind CLI assistant before its first transcript publication",
  async ({ yielded, stopReason }) => {
    const root = sessionDirs.make();
    const target = {
      agentId: "main",
      sessionId: "cli-media-session",
      sessionKey: "agent:main:cli-media",
      storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: Date.now() },
    });
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) =>
      applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./artifact.json"] }),
    );
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const result = await persistCliAssistantTranscript({
        runParams: {
          ...target,
          sessionFile: `sqlite://agents/main/${target.sessionId}`,
          workspaceDir: root,
          prompt: "make an artifact",
          provider: "claude-cli",
          runId: "cli-media-run",
          timeoutMs: 1_000,
          persistAssistantTranscript: true,
          prepareAssistantTranscriptMessage,
        },
        text: sourceText,
        modelId: "claude-sonnet-4-6",
        stopReason,
        yielded,
      });
      expect(result.owned).toBe(true);
      expect(result.idempotencyKey).toBe("cli-assistant:cli-media-run");
      expect(prepareAssistantTranscriptMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ content: [{ type: "text", text: sourceText }] }),
        sourceText,
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]?.message).toMatchObject({
        content: [{ type: "text", text: sourceText }],
        idempotencyKey: result.idempotencyKey,
        openclawDelivery: { mediaUrls: ["./artifact.json"] },
      });
      const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
        typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
      );
      expect(messages).toHaveLength(1);
      expect(isIntermediateAssistantTranscriptMessage(messages[0])).toBe(
        yielded === true && stopReason === "stop",
      );
      expect(messages[0]).toMatchObject({ stopReason });
      if (yielded && stopReason === "stop") {
        expect(messages[0]).toMatchObject({
          openclawStreamFallback: {
            replacementText: sourceText,
            source: "segment",
            itemId: "cli-media-run",
          },
        });
      } else {
        expect(messages[0]).not.toHaveProperty("openclawStreamFallback");
      }
      expect(sanitizeChatHistoryMessages(messages)).toMatchObject([
        { content: [{ type: "text", text: "Artifacts ready" }] },
      ]);
    } finally {
      unsubscribe();
    }
  },
);
