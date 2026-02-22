import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.js";
import { registerMSTeamsHandlers, type MSTeamsActivityHandler } from "./monitor-handler.js";

// Mock the message handler so we don't pull in the full runtime.
const mockHandleTeamsMessage = vi
  .fn<(ctx: unknown) => Promise<void>>()
  .mockResolvedValue(undefined);
vi.mock("./monitor-handler/message-handler.js", () => ({
  createMSTeamsMessageHandler: () => mockHandleTeamsMessage,
}));

// ---- helpers ----

const INVOKES_KEY = "__openclaw_pending_card_invokes";

function readGlobalInvokes(): Array<{ actionData: unknown; timestamp: number }> {
  const g = globalThis as unknown as Record<string, unknown>;
  return (g[INVOKES_KEY] as Array<{ actionData: unknown; timestamp: number }>) ?? [];
}

function clearGlobalInvokes() {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g[INVOKES_KEY];
}

function makeMockDeps(overrides?: Partial<MSTeamsMessageHandlerDeps>): MSTeamsMessageHandlerDeps {
  return {
    cfg: {} as MSTeamsMessageHandlerDeps["cfg"],
    runtime: { log: vi.fn(), error: vi.fn() } as unknown as MSTeamsMessageHandlerDeps["runtime"],
    appId: "test-app-id",
    adapter: {} as MSTeamsMessageHandlerDeps["adapter"],
    tokenProvider: { getAccessToken: vi.fn() },
    textLimit: 4096,
    mediaMaxBytes: 8 * 1024 * 1024,
    conversationStore: {
      upsert: vi.fn(),
    } as unknown as MSTeamsMessageHandlerDeps["conversationStore"],
    pollStore: {} as unknown as MSTeamsMessageHandlerDeps["pollStore"],
    log: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

function makeMockHandler(): MSTeamsActivityHandler & {
  _onMessageCb?: (context: unknown, next: () => Promise<void>) => Promise<void>;
  _onMembersAddedCb?: (context: unknown, next: () => Promise<void>) => Promise<void>;
} {
  const handler: ReturnType<typeof makeMockHandler> = {
    run: vi.fn(),
    onMessage(cb) {
      handler._onMessageCb = cb;
      return handler;
    },
    onMembersAdded(cb) {
      handler._onMembersAddedCb = cb;
      return handler;
    },
  };
  return handler;
}

function makeTurnContext(activity: Record<string, unknown>) {
  return {
    activity: {
      type: "message" as string,
      name: undefined as string | undefined,
      text: undefined as string | undefined,
      from: { id: "user1", name: "User One" },
      conversation: { id: "conv1" },
      ...activity,
    },
    sendActivity: vi.fn().mockResolvedValue(undefined),
    deleteActivity: vi.fn().mockResolvedValue(undefined),
  };
}

// ---- tests ----

describe("registerMSTeamsHandlers", () => {
  beforeEach(() => {
    clearGlobalInvokes();
    mockHandleTeamsMessage.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    clearGlobalInvokes();
  });

  describe("adaptive card Action.Execute invokes (handler.run)", () => {
    it("stores action data in global queue and sends invoke response", async () => {
      const handler = makeMockHandler();
      const deps = makeMockDeps();
      registerMSTeamsHandlers(handler, deps);

      const ctx = makeTurnContext({
        type: "invoke",
        name: "adaptiveCard/action",
        value: { action: "grant_consent", scope: "email" },
      });
      await handler.run!(ctx);

      // Verify invoke response sent
      expect(ctx.sendActivity).toHaveBeenCalledWith(
        expect.objectContaining({ type: "invokeResponse", value: { status: 200, body: {} } }),
      );

      // Verify action data stored in global queue
      const invokes = readGlobalInvokes();
      expect(invokes).toHaveLength(1);
      expect(invokes[0].actionData).toEqual({ action: "grant_consent", scope: "email" });
      expect(invokes[0].timestamp).toBeGreaterThan(0);
    });

    it("generates fixed synthetic text and routes to message handler", async () => {
      const handler = makeMockHandler();
      const deps = makeMockDeps();
      registerMSTeamsHandlers(handler, deps);

      let capturedText: string | undefined;
      mockHandleTeamsMessage.mockImplementationOnce(async (ctx: unknown) => {
        capturedText = (ctx as { activity: { text: string } }).activity.text;
      });

      const ctx = makeTurnContext({
        type: "invoke",
        name: "adaptiveCard/action",
        value: { verb: "confirmed" },
      });
      await handler.run!(ctx);

      expect(mockHandleTeamsMessage).toHaveBeenCalledOnce();
      // Synthetic text should be fixed regardless of action data
      expect(capturedText).toBe(
        "I approved the permission request. Please proceed with the action.",
      );
      // After the call, activity should be restored
      expect(ctx.activity.type).toBe("invoke");
      expect(ctx.activity.name).toBe("adaptiveCard/action");
    });

    it("restores activity properties even if message handler throws", async () => {
      mockHandleTeamsMessage.mockRejectedValueOnce(new Error("handler boom"));
      const handler = makeMockHandler();
      const deps = makeMockDeps();
      registerMSTeamsHandlers(handler, deps);

      const ctx = makeTurnContext({
        type: "invoke",
        name: "adaptiveCard/action",
        value: { action: "test" },
        text: "original",
      });
      await handler.run!(ctx);

      // Activity should be restored despite the error
      expect(ctx.activity.type).toBe("invoke");
      expect(ctx.activity.name).toBe("adaptiveCard/action");
      expect(ctx.activity.text).toBe("original");
    });

    it("uses fixed synthetic text regardless of action data fields", async () => {
      const handler = makeMockHandler();
      const deps = makeMockDeps();
      registerMSTeamsHandlers(handler, deps);

      // Capture the synthetic text during the handleTeamsMessage call
      let capturedText: string | undefined;
      mockHandleTeamsMessage.mockImplementationOnce(async (ctx: unknown) => {
        capturedText = (ctx as { activity: { text: string } }).activity.text;
      });

      const ctx = makeTurnContext({
        type: "invoke",
        name: "adaptiveCard/action",
        value: { someOtherField: true },
      });
      await handler.run!(ctx);

      expect(capturedText).toBe(
        "I approved the permission request. Please proceed with the action.",
      );
    });

    it("delegates non-adaptive-card invokes to original run", async () => {
      const handler = makeMockHandler();
      const originalRun = vi.fn();
      handler.run = originalRun;
      const deps = makeMockDeps();
      registerMSTeamsHandlers(handler, deps);

      const ctx = makeTurnContext({
        type: "invoke",
        name: "someOther/invoke",
        value: {},
      });
      await handler.run!(ctx);

      expect(originalRun).toHaveBeenCalled();
      expect(readGlobalInvokes()).toHaveLength(0);
    });
  });

  describe("adaptive card Action.Submit messages (onMessage)", () => {
    it("detects Action.Submit (empty text + value object) and routes as synthetic message", async () => {
      const handler = makeMockHandler();
      const deps = makeMockDeps();
      registerMSTeamsHandlers(handler, deps);

      const ctx = makeTurnContext({
        text: "",
        value: { verb: "approve", requestId: "abc" },
      });

      const next = vi.fn().mockResolvedValue(undefined);
      await handler._onMessageCb!(ctx, next);

      // Should store in global queue
      const invokes = readGlobalInvokes();
      expect(invokes).toHaveLength(1);
      expect(invokes[0].actionData).toEqual({ verb: "approve", requestId: "abc" });

      // Should route through message handler
      expect(mockHandleTeamsMessage).toHaveBeenCalledOnce();

      // Should call next()
      expect(next).toHaveBeenCalled();
    });

    it("restores activity.text after routing Action.Submit", async () => {
      const handler = makeMockHandler();
      const deps = makeMockDeps();
      registerMSTeamsHandlers(handler, deps);

      const ctx = makeTurnContext({
        text: "",
        value: { action: "deny" },
      });

      await handler._onMessageCb!(ctx, vi.fn().mockResolvedValue(undefined));

      // Text should be restored to original empty string
      expect(ctx.activity.text).toBe("");
    });

    it("treats whitespace-only text as empty for Action.Submit detection", async () => {
      const handler = makeMockHandler();
      const deps = makeMockDeps();
      registerMSTeamsHandlers(handler, deps);

      const ctx = makeTurnContext({
        text: "   \t\n  ",
        value: { action: "submit" },
      });

      await handler._onMessageCb!(ctx, vi.fn().mockResolvedValue(undefined));

      expect(readGlobalInvokes()).toHaveLength(1);
      expect(mockHandleTeamsMessage).toHaveBeenCalledOnce();
    });

    it("routes normal messages (text present) through message handler directly", async () => {
      const handler = makeMockHandler();
      const deps = makeMockDeps();
      registerMSTeamsHandlers(handler, deps);

      const ctx = makeTurnContext({ text: "Hello bot" });

      await handler._onMessageCb!(ctx, vi.fn().mockResolvedValue(undefined));

      expect(readGlobalInvokes()).toHaveLength(0);
      expect(mockHandleTeamsMessage).toHaveBeenCalledOnce();
    });

    it("does not treat messages with text + value as Action.Submit", async () => {
      const handler = makeMockHandler();
      const deps = makeMockDeps();
      registerMSTeamsHandlers(handler, deps);

      const ctx = makeTurnContext({
        text: "actual message",
        value: { action: "something" },
      });

      await handler._onMessageCb!(ctx, vi.fn().mockResolvedValue(undefined));

      // Should NOT go through Action.Submit path
      expect(readGlobalInvokes()).toHaveLength(0);
      // Should still route through normal message handler
      expect(mockHandleTeamsMessage).toHaveBeenCalledOnce();
    });
  });

  describe("onMembersAdded — conversation reference seeding", () => {
    it("saves conversation reference on install for proactive messaging", async () => {
      const handler = makeMockHandler();
      const upsertFn = vi.fn().mockResolvedValue(undefined);
      const deps = makeMockDeps({
        conversationStore: {
          upsert: upsertFn,
        } as unknown as MSTeamsMessageHandlerDeps["conversationStore"],
      });
      registerMSTeamsHandlers(handler, deps);

      const ctx = makeTurnContext({
        type: "conversationUpdate",
        membersAdded: [{ id: "user1" }],
        recipient: { id: "bot1", name: "Bot" },
        from: { id: "user1", name: "User One", aadObjectId: "aad-user1" },
        conversation: {
          id: "19:abc@thread.tacv2",
          conversationType: "personal",
          tenantId: "tenant1",
        },
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/teams/",
        locale: "en-US",
      });

      const next = vi.fn().mockResolvedValue(undefined);
      await handler._onMembersAddedCb!(ctx, next);

      expect(upsertFn).toHaveBeenCalledOnce();
      expect(upsertFn).toHaveBeenCalledWith(
        "19:abc@thread.tacv2",
        expect.objectContaining({
          user: { id: "user1", name: "User One", aadObjectId: "aad-user1" },
          agent: { id: "bot1", name: "Bot" },
          conversation: {
            id: "19:abc@thread.tacv2",
            conversationType: "personal",
            tenantId: "tenant1",
          },
          serviceUrl: "https://smba.trafficmanager.net/teams/",
        }),
      );
      expect(next).toHaveBeenCalled();
    });

    it("does not fail if conversation reference save errors", async () => {
      const handler = makeMockHandler();
      const upsertFn = vi.fn().mockRejectedValue(new Error("disk full"));
      const deps = makeMockDeps({
        conversationStore: {
          upsert: upsertFn,
        } as unknown as MSTeamsMessageHandlerDeps["conversationStore"],
      });
      registerMSTeamsHandlers(handler, deps);

      const ctx = makeTurnContext({
        type: "conversationUpdate",
        membersAdded: [{ id: "user1" }],
        recipient: { id: "bot1", name: "Bot" },
        from: { id: "user1", name: "User One" },
        conversation: { id: "conv1", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/teams/",
      });

      const next = vi.fn().mockResolvedValue(undefined);
      // Should not throw
      await handler._onMembersAddedCb!(ctx, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe("global invoke queue", () => {
    it("accumulates multiple invokes in order", async () => {
      const handler = makeMockHandler();
      const deps = makeMockDeps();
      registerMSTeamsHandlers(handler, deps);

      // Send two adaptive card invokes
      const ctx1 = makeTurnContext({
        type: "invoke",
        name: "adaptiveCard/action",
        value: { action: "first" },
      });
      const ctx2 = makeTurnContext({
        type: "invoke",
        name: "adaptiveCard/action",
        value: { action: "second" },
      });
      await handler.run!(ctx1);
      await handler.run!(ctx2);

      const invokes = readGlobalInvokes();
      expect(invokes).toHaveLength(2);
      expect((invokes[0].actionData as Record<string, unknown>).action).toBe("first");
      expect((invokes[1].actionData as Record<string, unknown>).action).toBe("second");
    });
  });
});
