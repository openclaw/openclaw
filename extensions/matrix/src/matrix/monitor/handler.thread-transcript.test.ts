import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { testing as bindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  getSessionEntryAsync,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime, resetMatrixTestStores } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  bindingTesting.resetSessionBindingAdaptersForTests();
  await resetMatrixTestStores();
  await cleanup?.();
  cleanup = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("keeps a fresh Matrix thread transcript isolated while preserving allowed root context and room model inheritance", async () => {
  const state = await createOpenClawTestState({ label: "matrix-thread-transcript" });
  cleanup = () => state.cleanup();
  const storePath = state.path("sessions.json");
  const roomKey = "agent:ops:matrix:channel:room";
  const parent = { agentId: "ops", storePath, sessionKey: roomKey, sessionId: "room-session" };
  await upsertSessionEntry({
    ...parent,
    entry: {
      sessionId: parent.sessionId,
      updatedAt: Date.now(),
      providerOverride: "synthetic",
      modelOverride: "room-model",
      modelOverrideSource: "user",
    },
  });
  await appendSessionTranscriptMessageByIdentity({
    ...parent,
    message: { role: "user", content: "ROOM_ONLY_SENTINEL" },
  });
  await appendSessionTranscriptMessageByIdentity({
    ...parent,
    message: { role: "assistant", content: "ROOM_REPLY_SENTINEL" },
  });
  expect(JSON.stringify(await readSessionTranscriptEvents(parent))).toContain("ROOM_ONLY_SENTINEL");
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    commands: { native: false, text: true },
    agents: {
      ownership: "explicit",
      entries: { ops: { workspace: state.workspaceDir } },
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "synthetic/default-model" },
      },
    },
    plugins: { enabled: false },
    channels: { matrix: { groupPolicy: "open", groupAllowFrom: ["@user:example.org"] } },
  };
  await state.writeConfig(cfg);
  await captureRuntimeConfigAsyncReader()();
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
  installMatrixMonitorTestRuntime({ cfg, stateDir: state.stateDir });
  const initialized: Parameters<typeof getReplyFromConfig>[0][] = [];
  const startedAt = Date.now();
  const { handler } = createMatrixHandlerTestHarness({
    cfg,
    isDirectMessage: false,
    groupAllowFrom: ["@user:example.org"],
    threadReplies: "inbound",
    shouldHandleTextCommands: () => true,
    hasControlCommand: () => true,
    resolveAgentRoute: () => ({
      agentId: "ops",
      channel: "matrix",
      accountId: "ops",
      sessionKey: roomKey,
      mainSessionKey: roomKey,
      matchedBy: "binding.account",
    }),
    client: {
      getEvent: async () =>
        createMatrixTextMessageEvent({
          eventId: "$root",
          sender: "@alice:example.org",
          body: "ALLOWED_ROOT",
        }),
    },
    dispatchInboundMessage: async ({ ctx }) => {
      initialized.push(ctx);
      // A real command traverses session initialization and inherited model
      // selection without requiring a provider request.
      const reply = await getReplyFromConfig(ctx, {}, cfg);
      const replies = Array.isArray(reply) ? reply : [reply];
      expect(replies.map((payload) => payload?.text ?? "").join("")).toContain(
        "synthetic/room-model",
      );
      return { queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } };
    },
  });
  await handler(
    "!room:example.org",
    createMatrixTextMessageEvent({
      eventId: "$first",
      body: "@bot /status",
      mentions: { user_ids: ["@bot:example.org"] },
      relatesTo: {
        rel_type: "m.thread",
        event_id: "$root",
        "m.in_reply_to": { event_id: "$root" },
      },
    }),
  );
  expect(initialized).toHaveLength(1);
  const first = initialized[0]!;
  const entry = await getSessionEntryAsync({
    agentId: "ops",
    storePath,
    sessionKey: first.SessionKey!,
  });
  expect(entry?.sessionStartedAt).toBeGreaterThanOrEqual(startedAt);
  const child = {
    agentId: "ops",
    storePath,
    sessionKey: first.SessionKey!,
    sessionId: entry!.sessionId,
  };
  // Assert persisted content, not just the adapter's ParentSessionKey field.
  expect(JSON.stringify(await readSessionTranscriptEvents(child))).not.toContain(
    "ROOM_ONLY_SENTINEL",
  );
  expect(entry?.forkSource).toBeUndefined();
  expect(first.ThreadStarterBody).toContain("ALLOWED_ROOT");
  expect(first.ReplyToBody).toBe("ALLOWED_ROOT");
});
