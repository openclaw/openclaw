import { isDeepStrictEqual } from "node:util";
import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import { isSubagentSessionKey } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isSilentReplyText } from "openclaw/plugin-sdk/reply-runtime";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";
import { z } from "zod";
import { resolveCodexBindingAppServerConnection } from "./binding-connection.js";
import { readCodexPluginConfig } from "./config-parsing.js";
import {
  codexManagedChildRecoveryFingerprint,
  codexManagedChildTurnReceipt,
} from "./managed-child-turn.js";
import { buildCodexAppServerRuntimeFingerprint } from "./plugin-app-cache-key.js";
import { sessionBindingIdentity, type CodexAppServerBindingStore } from "./session-binding.js";
import { openCodexConfiguredHistoryClient } from "./shared-client.js";
import { buildCodexMirrorIdempotencyKey } from "./transcript-mirror-attestation.js";

const HISTORY_READ_TIMEOUT_MS = 30_000;
const MAX_REPLY_BYTES = 64 * 1024;
const identifier = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());

const simpleUserMessage = z.object({
  id: identifier,
  type: z.literal("userMessage"),
  clientId: identifier,
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).nonempty(),
});
const simpleAssistantMessage = z.strictObject({
  id: identifier,
  type: z.literal("agentMessage"),
  phase: z.literal("final_answer").nullable(),
  delivery: z.null().optional(),
  questions: z.null().optional(),
  memoryCitation: z.null().optional(),
  text: z.string().max(MAX_REPLY_BYTES),
});
// Only explicit commentary is interim. A second unmarked assistant message
// competes with the final answer. Never send progress or tool output to the parent.
const settledWork = z.discriminatedUnion("type", [
  simpleAssistantMessage.extend({ phase: z.literal("commentary") }),
  z.object({ type: z.literal("reasoning"), id: identifier }),
  z.object({
    type: z.literal("dynamicToolCall"),
    id: identifier,
    status: z.literal("completed"),
    success: z.literal(true),
  }),
]);
const childTurnPage = z.object({
  nextCursor: z.null(),
  // The server supplies a reverse anchor even when there is exactly one turn.
  backwardsCursor: identifier.nullish(),
  data: z.tuple([
    z.object({
      id: identifier,
      threadId: identifier.optional(),
      status: z.enum(["completed", "inProgress", "failed", "interrupted"]),
      completedAt: z.number().int().positive().nullish(),
      itemsView: z.literal("full"),
      error: z.unknown().optional(),
      items: z.tuple([simpleUserMessage], z.unknown()),
    }),
  ]),
});

type RecoveryParams = Parameters<NonNullable<AgentHarness["withInterruptedSubagentReply"]>>[0];

/** Inspect one exact persisted turn without acquiring a native thread subscription. */
export async function withCodexInterruptedSubagentReply(
  params: RecoveryParams,
  options: { bindingStore: CodexAppServerBindingStore; resolvePluginConfig: () => unknown },
): Promise<"pending" | "unknown" | "interrupted" | void> {
  params.assertCurrent();
  if (!isSubagentSessionKey(params.sessionKey)) {
    return;
  }
  const reader = await options.bindingStore.prepareRead(sessionBindingIdentity(params));
  try {
    params.assertCurrent();
    const binding = reader?.read();
    if (!reader || !binding?.managedChildRecoveryFingerprint) {
      return;
    }
    await params.claim();
    params.assertCurrent();
    const pluginConfig = readCodexPluginConfig(options.resolvePluginConfig());
    if (
      pluginConfig.appServer?.transport !== "websocket" ||
      !binding.appServerRuntimeFingerprint ||
      binding.connectionScope ||
      binding.authProfileId ||
      binding.preserveNativeModel ||
      binding.pendingSupervisionBranch ||
      binding.pendingResumeConfiguration
    ) {
      return "unknown";
    }
    const assertCurrent = () => {
      params.assertCurrent();
      if (
        !isDeepStrictEqual(binding, reader.read()) ||
        !isDeepStrictEqual(pluginConfig, readCodexPluginConfig(options.resolvePluginConfig()))
      ) {
        throw new Error("Codex managed child recovery binding changed");
      }
    };
    const { appServer } = await resolveCodexBindingAppServerConnection({
      binding,
      pluginConfig,
      config: params.config,
      assertCurrent,
    });
    assertCurrent();
    if (
      appServer.start.transport !== "websocket" ||
      codexManagedChildRecoveryFingerprint({
        ...params,
        appServer,
      }) !== binding.managedChildRecoveryFingerprint
    ) {
      return "unknown";
    }
    const timeoutMs = Math.min(appServer.requestTimeoutMs, HISTORY_READ_TIMEOUT_MS);
    const signal = AbortSignal.timeout(timeoutMs);
    const client = await openCodexConfiguredHistoryClient({
      startOptions: appServer.start,
      abandonSignal: signal,
      timeoutMs,
      assertCurrent,
    }).catch(() => undefined);
    if (!client) {
      assertCurrent();
      return "unknown";
    }
    try {
      assertCurrent();
      if (
        buildCodexAppServerRuntimeFingerprint({
          appServer,
          appServerVersion: client.getServerVersion(),
          runtimeIdentity: client.getRuntimeIdentity(),
        }) !== binding.appServerRuntimeFingerprint
      ) {
        return "unknown";
      }
      const { threadId } = binding;
      const result = await client
        .request(
          "thread/turns/list",
          { threadId, limit: 2, sortDirection: "desc", itemsView: "full" },
          { signal, timeoutMs, assertCurrent },
        )
        .catch(() => undefined);
      assertCurrent();
      if (client.getCloseError()) {
        return "unknown";
      }
      const page = childTurnPage.safeParse(result);
      if (!page.success) {
        return "unknown";
      }
      const [turn] = page.data.data;
      const [user] = turn.items;
      if (
        (turn.threadId !== undefined && turn.threadId !== threadId) ||
        user.clientId !== codexManagedChildTurnReceipt({ ...params, threadId })
      ) {
        return "unknown";
      }
      if (turn.completedAt != null && (turn.status === "failed" || turn.status === "interrupted")) {
        return "interrupted";
      }
      if (turn.error != null) {
        return "unknown";
      }
      if (turn.status === "inProgress" && turn.completedAt == null) {
        return "pending";
      }
      const assistant = simpleAssistantMessage.safeParse(turn.items.at(-1));
      if (
        turn.status !== "completed" ||
        turn.completedAt == null ||
        !assistant.success ||
        user.id === assistant.data.id
      ) {
        return "unknown";
      }
      const ids = new Set([user.id, assistant.data.id]);
      for (const item of turn.items.slice(1, -1)) {
        const work = settledWork.safeParse(item);
        if (!work.success || ids.has(work.data.id)) {
          return "unknown";
        }
        ids.add(work.data.id);
      }
      const text = assistant.data.text.trim();
      if (
        !text ||
        Buffer.byteLength(text) > MAX_REPLY_BYTES ||
        isSilentReplyText(text) ||
        stripReasoningTagsFromText(text, { recoverUnclosed: true, trim: "none" }) !== text
      ) {
        return "unknown";
      }
      assertCurrent();
      await params.accept(
        text,
        () => {
          assertCurrent();
          const closed = client.getCloseError();
          if (closed) {
            throw closed;
          }
        },
        buildCodexMirrorIdempotencyKey(`codex-app-server:${threadId}`, `${turn.id}:assistant`),
      );
    } finally {
      await client.closeAndWait();
    }
  } finally {
    reader?.release();
  }
}
