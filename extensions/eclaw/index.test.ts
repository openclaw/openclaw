import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
