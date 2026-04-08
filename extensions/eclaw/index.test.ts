import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  readJsonWebhookBodyOrReject: async () => ({ ok: true, value: {} }),
  registerPluginHttpRoute: () => () => {},
}));
vi.mock("openclaw/plugin-sdk/channel-lifecycle", () => ({
  waitUntilAbort: async () => undefined,
}));

import { listAccountIds, resolveAccount } from "./src/accounts.js";
import {
  clearEclawClient,
  setEclawClient,
} from "./src/client-registry.js";
import { EclawClient } from "./src/client.js";
import { setEclawRuntime } from "./src/runtime.js";
import type { EclawInboundMessage } from "./src/types.js";
import {
  dispatchEclawWebhookMessage,
  handleEclawWebhookRequest,
} from "./src/webhook-handler.js";
import {
  eclawWebhookRegistrySize,
  lookupEclawWebhookToken,
  registerEclawWebhookToken,
  unregisterEclawWebhookToken,
} from "./src/webhook-registry.js";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("eclaw bundled entries", () => {
  it("defines a channel entry for the eclaw id", () => {
    expect(entry.id).toBe("eclaw");
    expect(entry.name).toBe("E-Claw");
  });

  it("loads the channel plugin without importing the broad api barrel", () => {
    const plugin = entry.loadChannelPlugin();
    expect(plugin.id).toBe("eclaw");
    expect(plugin.meta?.label).toBe("E-Claw");
  });

  it("loads the setup plugin without importing the broad api barrel", () => {
    const plugin = setupEntry.loadSetupPlugin();
    expect(plugin.id).toBe("eclaw");
    expect(plugin.meta?.label).toBe("E-Claw");
  });
});

describe("eclaw webhook registry", () => {
  afterEach(() => {
    // Clean up any tokens left over
    for (let i = 0; i < 100 && eclawWebhookRegistrySize() > 0; i += 1) {
      unregisterEclawWebhookToken(`t-${i}`);
    }
  });

  it("rejects requests without a Bearer token even when a single account is registered", () => {
    registerEclawWebhookToken("t-0", "default");
    try {
      expect(eclawWebhookRegistrySize()).toBe(1);
      expect(lookupEclawWebhookToken(undefined)).toBeUndefined();
      expect(lookupEclawWebhookToken("")).toBeUndefined();
      expect(lookupEclawWebhookToken("Basic abc")).toBeUndefined();
      expect(lookupEclawWebhookToken("Bearer ")).toBeUndefined();
      expect(lookupEclawWebhookToken("Bearer wrong")).toBeUndefined();
      expect(lookupEclawWebhookToken("Bearer t-0")).toEqual({
        accountId: "default",
      });
    } finally {
      unregisterEclawWebhookToken("t-0");
    }
  });

  it("handleEclawWebhookRequest returns 401 for token-less webhook POSTs", async () => {
    registerEclawWebhookToken("t-0", "default");
    try {
      const result = await handleEclawWebhookRequest({
        cfg: {},
        authHeader: undefined,
        body: {
          event: "message",
          deviceId: "dev",
          entityId: 1,
          from: "user",
          text: "hi",
        } as EclawInboundMessage,
      });
      expect(result.status).toBe(401);
    } finally {
      unregisterEclawWebhookToken("t-0");
    }
  });

  it("handleEclawWebhookRequest returns 401 for a present-but-wrong Bearer token (no single-account fallback)", async () => {
    // Exactly one account registered — this is the scenario where an
    // earlier fallback path would have mis-routed a bogus token.
    registerEclawWebhookToken("t-0", "default");
    try {
      const result = await handleEclawWebhookRequest({
        cfg: {},
        authHeader: "Bearer totally-bogus",
        body: {
          event: "message",
          deviceId: "dev",
          entityId: 1,
          from: "user",
          text: "hi",
        } as EclawInboundMessage,
      });
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ error: "Unauthorized" });
    } finally {
      unregisterEclawWebhookToken("t-0");
    }
  });
});

describe("eclaw gateway bind-failure cleanup", () => {
  const savedEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...savedEnv };
    const mod = await import("./src/gateway.js");
    mod.__resetEclawSharedRouteForTests();
    vi.restoreAllMocks();
  });

  it("unregisters the remote callback when bindEntity fails after registerCallback succeeded", async () => {
    process.env.ECLAW_API_KEY = "env-key";

    const registerCallback = vi
      .spyOn(EclawClient.prototype, "registerCallback")
      .mockImplementation(async function (this: EclawClient) {
        // Mimic a successful register: set internal state as the real
        // client would. We only need deviceId to be non-null so that a
        // later unregister call is a real HTTP attempt (stubbed below).
        (this as unknown as { "#state"?: unknown }); // keep TS happy
        return {
          success: true,
          deviceId: "dev-1",
          entities: [],
        } as never;
      });
    const bindEntity = vi
      .spyOn(EclawClient.prototype, "bindEntity")
      .mockImplementation(async () => {
        throw new Error("bind exploded");
      });
    const unregisterCallback = vi
      .spyOn(EclawClient.prototype, "unregisterCallback")
      .mockImplementation(async () => {
        /* no-op */
      });

    const { startEclawAccount } = await import("./src/gateway.js");

    const logs: string[] = [];
    const abortCtrl = new AbortController();
    await startEclawAccount({
      cfg: {} as never,
      accountId: "default",
      abortSignal: abortCtrl.signal,
      log: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
    });

    expect(registerCallback).toHaveBeenCalledTimes(1);
    expect(bindEntity).toHaveBeenCalledTimes(1);
    // The critical assertion: we must have issued a best-effort
    // unregisterCallback so the E-Claw backend doesn't keep pushing
    // to a route we've already torn down locally.
    expect(unregisterCallback).toHaveBeenCalledTimes(1);
    expect(
      logs.some(
        (l) =>
          l.startsWith("error:") && l.includes("bind exploded"),
      ),
    ).toBe(true);
  });
});

describe("eclaw env-only account startup", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("listAccountIds returns default when only env vars are set", () => {
    delete process.env.ECLAW_API_KEY;
    expect(listAccountIds({} as never)).toEqual([]);

    process.env.ECLAW_API_KEY = "env-key";
    expect(listAccountIds({} as never)).toEqual(["default"]);
  });

  it("resolveAccount picks up env-only ECLAW_API_KEY", () => {
    process.env.ECLAW_API_KEY = "env-key";
    const account = resolveAccount({} as never, "default");
    expect(account.apiKey).toBe("env-key");
    expect(account.enabled).toBe(true);
  });
});

describe("eclaw webhook media-only delivery", () => {
  type Captured = {
    text: string;
    state: string;
    mediaType?: string;
    mediaUrl?: string;
  };

  let sentMessages: Captured[];
  let sentSpeakTo: Array<{ entityId: number; text: string }>;

  class FakeEclawClient extends EclawClient {
    constructor() {
      super({ apiBase: "https://example.test", apiKey: "test" });
    }
    // Override with a minimal capture. Keep the signature loose; runtime uses
    // positional args same as the real client.
    sendMessage = vi.fn(
      async (text: string, state = "IDLE", mediaType?: string, mediaUrl?: string) => {
        sentMessages.push({ text, state, mediaType, mediaUrl });
        return { success: true };
      },
    ) as unknown as EclawClient["sendMessage"];
    speakTo = vi.fn(async (entityId: number, text: string) => {
      sentSpeakTo.push({ entityId, text });
      return { success: true };
    }) as unknown as EclawClient["speakTo"];
  }

  // Minimal runtime mock: invokes the dispatcher's deliver callback once with
  // a pre-baked payload, mimicking the buffered block dispatcher.
  function installRuntimeWithPayload(payload: {
    text?: string;
    mediaType?: string;
    mediaUrl?: string;
  }) {
    setEclawRuntime({
      channel: {
        reply: {
          finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
          dispatchReplyWithBufferedBlockDispatcher: async (args: {
            dispatcherOptions: {
              deliver: (p: typeof payload) => Promise<void>;
            };
          }) => {
            await args.dispatcherOptions.deliver(payload);
          },
        },
      },
    } as never);
  }

  beforeEach(() => {
    sentMessages = [];
    sentSpeakTo = [];
    const client = new FakeEclawClient();
    setEclawClient("default", client as unknown as EclawClient);
  });

  afterEach(() => {
    clearEclawClient("default");
  });

  it("delivers media-only payloads when text is empty", async () => {
    installRuntimeWithPayload({
      text: "",
      mediaType: "image",
      mediaUrl: "https://cdn.example/img.png",
    });

    await dispatchEclawWebhookMessage({
      accountId: "default",
      cfg: {},
      msg: {
        event: "message",
        deviceId: "dev-1",
        entityId: 2,
        from: "user-1",
        text: "hi",
      } as EclawInboundMessage,
    });

    expect(sentMessages).toEqual([
      {
        text: "",
        state: "IDLE",
        mediaType: "photo",
        mediaUrl: "https://cdn.example/img.png",
      },
    ]);
  });

  it("suppresses media delivery when silent-token is present", async () => {
    installRuntimeWithPayload({
      text: "[SILENT]",
      mediaType: "image",
      mediaUrl: "https://cdn.example/img.png",
    });

    await dispatchEclawWebhookMessage({
      accountId: "default",
      cfg: {},
      msg: {
        event: "message",
        deviceId: "dev-1",
        entityId: 2,
        from: "user-1",
        text: "hi",
      } as EclawInboundMessage,
    });

    expect(sentMessages).toEqual([]);
  });

  it("delivers text AND media in a single sendMessage when both are present", async () => {
    installRuntimeWithPayload({
      text: "caption here",
      mediaType: "image",
      mediaUrl: "https://cdn.example/img.png",
    });

    await dispatchEclawWebhookMessage({
      accountId: "default",
      cfg: {},
      msg: {
        event: "message",
        deviceId: "dev-1",
        entityId: 2,
        from: "user-1",
        text: "hi",
      } as EclawInboundMessage,
    });

    expect(sentMessages).toEqual([
      {
        text: "caption here",
        state: "IDLE",
        mediaType: "photo",
        mediaUrl: "https://cdn.example/img.png",
      },
    ]);
  });

  it("for entity_message replies, includes media on the wallpaper sendMessage and text-only on speakTo", async () => {
    installRuntimeWithPayload({
      text: "hello bot",
      mediaType: "image",
      mediaUrl: "https://cdn.example/img.png",
    });

    await dispatchEclawWebhookMessage({
      accountId: "default",
      cfg: {},
      msg: {
        event: "entity_message",
        deviceId: "dev-1",
        entityId: 2,
        fromEntityId: 3,
        from: "user-1",
        text: "hi",
      } as EclawInboundMessage,
    });

    expect(sentMessages).toEqual([
      {
        text: "hello bot",
        state: "IDLE",
        mediaType: "photo",
        mediaUrl: "https://cdn.example/img.png",
      },
    ]);
    expect(sentSpeakTo).toEqual([{ entityId: 3, text: "hello bot" }]);
  });
});

describe("eclaw onError logging", () => {
  beforeEach(() => {
    const client = new (class extends EclawClient {
      constructor() {
        super({ apiBase: "https://example.test", apiKey: "test" });
      }
      sendMessage = vi.fn(async () => {
        throw new Error("boom");
      }) as unknown as EclawClient["sendMessage"];
    })();
    setEclawClient("default", client as unknown as EclawClient);
  });

  afterEach(() => {
    clearEclawClient("default");
  });

  it("invokes the installed onError callback when delivery throws (no silent swallow)", async () => {
    const errorsSeen: Array<{ err: unknown; kind?: string }> = [];
    setEclawRuntime({
      // Surface delivery failures via the runtime error sink so the
      // handler's onError has somewhere to log.
      error: (msg: string) => {
        errorsSeen.push({ err: msg });
      },
      channel: {
        reply: {
          finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
          dispatchReplyWithBufferedBlockDispatcher: async (args: {
            dispatcherOptions: {
              deliver: (p: {
                text?: string;
                mediaType?: string;
                mediaUrl?: string;
              }) => Promise<void>;
              onError?: (err: unknown, info?: { kind?: string }) => void;
            };
          }) => {
            try {
              await args.dispatcherOptions.deliver({ text: "hello" });
            } catch (err) {
              args.dispatcherOptions.onError?.(err, { kind: "text" });
            }
          },
        },
      },
    } as never);

    await dispatchEclawWebhookMessage({
      accountId: "default",
      cfg: {},
      msg: {
        event: "message",
        deviceId: "dev-1",
        entityId: 2,
        from: "user-1",
        text: "hi",
      } as EclawInboundMessage,
    });

    expect(errorsSeen).toHaveLength(1);
    expect(String(errorsSeen[0]?.err)).toContain("boom");
    expect(String(errorsSeen[0]?.err)).toContain("eclaw:");
  });
});
