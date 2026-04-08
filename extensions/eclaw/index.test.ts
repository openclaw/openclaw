/**
 * Regression test suite for the E-Claw channel plugin.
 *
 * Doc references (OpenClaw repo):
 *   - docs/plugins/building-plugins.md §"Pre-submission checklist" —
 *     "Tests pass (`pnpm test -- <bundled-plugin-root>/my-plugin/`)"
 *     and "`pnpm check` passes (in-repo plugins)"; this file is what
 *     `pnpm test:extension eclaw` picks up via
 *     `vitest.extension-messaging-paths.mjs`.
 *   - docs/plugins/sdk-testing.md — shared test harness helpers and
 *     contract-test fixtures used by some describe blocks below.
 *
 * Test coverage map (review rounds referenced in comments below):
 *   - `eclaw bundled entries` — basic plugin shape
 *     (initial port)
 *   - `eclaw webhook registry` — strict Bearer auth
 *     (round 2, codex `webhook-registry.ts` P1)
 *   - `eclaw gateway bind-failure cleanup` — unregister + rethrow
 *     (rounds 2 + 4, codex P2 "unregister on bind failure" +
 *     "propagate setup failures")
 *   - `eclaw env-only account startup` — ECLAW_API_KEY without
 *     `channels.eclaw` entry (round 2, codex P2)
 *   - `eclaw webhook media-only delivery` — media-only payload path
 *     (round 2, codex P1 "media-only dropped")
 *   - `eclaw onError logging` — delivery failure surfaced via
 *     runtime error sink (round 2, codex P2)
 *   - `eclaw client strict response validation` — sendMessage /
 *     speakTo res.ok + success checks (round 3, codex P2)
 *   - `eclaw webhook Bearer scheme case-insensitivity (RFC 7235)` —
 *     case variants, whitespace, non-Bearer schemes
 *     (round 5, codex webhook-registry.ts P2)
 *   - `eclaw active-event suppression is async-local, not global` —
 *     AsyncLocalStorage concurrency test
 *     (round 5, codex send.ts P1)
 *   - `eclaw shared HTTP route conflict detection` — sentinel-log
 *     detection of route conflict / overlap denied
 *     (round 6, codex gateway.ts P2)
 *   - `eclaw inbound backupUrl fallback` — media context falls back
 *     when primary mediaUrl is absent
 *     (round 7, codex webhook-handler.ts P2)
 *   - `eclaw state cleanup on shared-route failure` — no leak of
 *     webhook-token / client registry when acquireSharedEclawHttpRoute
 *     throws (round 7, codex gateway.ts P2)
 *   - `eclaw account stop awaits unregisterCallback` — onAbort callback
 *     is async so the remote deregister completes before stop resolves
 *     (round 10, codex gateway.ts P1)
 */
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
      .mockImplementation(async () => {
        // Mimic a successful register: the unregister-on-failure test
        // below only checks that unregisterCallback was invoked once,
        // so we don't need to set any internal state here.
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
    // The catch path now re-throws so the channel manager can mark the
    // account as failed and attempt a restart. Previously it silently
    // returned waitUntilAbort, leaving the startup task alive forever.
    await expect(
      startEclawAccount({
        cfg: {} as never,
        accountId: "default",
        abortSignal: abortCtrl.signal,
        log: {
          info: (m) => logs.push(`info:${m}`),
          warn: (m) => logs.push(`warn:${m}`),
          error: (m) => logs.push(`error:${m}`),
        },
      }),
    ).rejects.toThrow(/bind exploded/);

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

  it("logs delivery failures via runtime.logging.getChildLogger().error (no silent swallow)", async () => {
    // Round 8 fix: the handler must reach for the RuntimeLogger
    // returned by `runtime.logging.getChildLogger({...})`, NOT a
    // top-level `runtime.error` property that does not exist on
    // PluginRuntime (see src/plugins/runtime/types-core.ts).
    const errorsSeen: Array<{
      message: string;
      meta?: Record<string, unknown>;
      bindings?: Record<string, unknown>;
    }> = [];

    const bindingsSeen: Array<Record<string, unknown>> = [];
    const makeChildLogger = (
      bindings?: Record<string, unknown>,
    ): {
      info: (m: string, meta?: Record<string, unknown>) => void;
      warn: (m: string, meta?: Record<string, unknown>) => void;
      error: (m: string, meta?: Record<string, unknown>) => void;
    } => {
      if (bindings) {
        bindingsSeen.push(bindings);
      }
      return {
        info: () => {},
        warn: () => {},
        error: (m, meta) => {
          errorsSeen.push({ message: m, meta, bindings });
        },
      };
    };

    setEclawRuntime({
      logging: {
        getChildLogger: makeChildLogger,
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
      cfg: {} as never,
      msg: {
        event: "message",
        deviceId: "dev-1",
        entityId: 2,
        from: "user-1",
        text: "hi",
      } as EclawInboundMessage,
    });

    expect(errorsSeen).toHaveLength(1);
    expect(errorsSeen[0]?.message).toContain("boom");
    expect(errorsSeen[0]?.message).toContain("reply");
    expect(errorsSeen[0]?.message).toContain("text");
    expect(errorsSeen[0]?.meta).toEqual({ kind: "text" });
    // Child logger must be bound with plugin + accountId so log
    // aggregators can filter per-plugin and per-account.
    expect(errorsSeen[0]?.bindings).toEqual({
      plugin: "eclaw",
      accountId: "default",
    });
  });

  it("drops the error silently (no throw) when the runtime has no logging surface", async () => {
    // Second half of the round-8 fix: a missing `logging` surface
    // must not crash the webhook dispatch — earlier rounds passed a
    // runtime with a direct `.error` method which no longer matches
    // the real `PluginRuntime` shape. The onError block is wrapped
    // in try/catch so that a missing/misshaped logger never breaks
    // the inbound path.
    setEclawRuntime({
      // Intentionally no `logging` surface.
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

    await expect(
      dispatchEclawWebhookMessage({
        accountId: "default",
        cfg: {} as never,
        msg: {
          event: "message",
          deviceId: "dev-1",
          entityId: 2,
          from: "user-1",
          text: "hi",
        } as EclawInboundMessage,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("eclaw client strict response validation", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mkClient(): EclawClient {
    const client = new EclawClient({
      apiBase: "https://example.test",
      apiKey: "eck_test",
    });
    // Bypass the "not bound" guard so sendMessage/speakTo reach fetch
    (client as unknown as { "#state": Record<string, unknown> })["#state"] = {
      deviceId: "dev-1",
      botSecret: "secret-1",
      entityId: 2,
    };
    // TypeScript private fields can't be set from outside; do it via Object.defineProperty
    // on the client-registry proxy path. Simpler: use setEclawClient + direct call.
    return client;
  }

  function stubFetch(status: number, body: unknown): void {
    globalThis.fetch = vi.fn(async () => {
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  it("sendMessage throws on HTTP 500", async () => {
    stubFetch(500, "internal server error");
    const client = new EclawClient({
      apiBase: "https://example.test",
      apiKey: "eck_test",
    });
    // Stamp state via bindEntity path: call bindEntity with stubbed ok response first.
    stubFetch(200, { success: true, deviceId: "dev-1", entityId: 2, botSecret: "s", publicCode: "p", bindingType: "channel" });
    await client.bindEntity(2, "bot");
    // Now stub the failing sendMessage response and invoke it
    stubFetch(500, "internal server error");
    await expect(client.sendMessage("hi")).rejects.toThrow(/HTTP 500/);
  });

  it("sendMessage throws when response JSON has success: false", async () => {
    const client = new EclawClient({
      apiBase: "https://example.test",
      apiKey: "eck_test",
    });
    stubFetch(200, { success: true, deviceId: "dev-1", entityId: 2, botSecret: "s", publicCode: "p", bindingType: "channel" });
    await client.bindEntity(2, "bot");
    stubFetch(200, { success: false, message: "quota exceeded" });
    await expect(client.sendMessage("hi")).rejects.toThrow(/quota exceeded/);
    void mkClient; // silence unused-helper warning if any
  });

  it("speakTo throws on HTTP 404", async () => {
    const client = new EclawClient({
      apiBase: "https://example.test",
      apiKey: "eck_test",
    });
    stubFetch(200, { success: true, deviceId: "dev-1", entityId: 2, botSecret: "s", publicCode: "p", bindingType: "channel" });
    await client.bindEntity(2, "bot");
    stubFetch(404, "not found");
    await expect(client.speakTo(3, "hi")).rejects.toThrow(/HTTP 404/);
  });

  it("speakTo throws when response JSON has success: false", async () => {
    const client = new EclawClient({
      apiBase: "https://example.test",
      apiKey: "eck_test",
    });
    stubFetch(200, { success: true, deviceId: "dev-1", entityId: 2, botSecret: "s", publicCode: "p", bindingType: "channel" });
    await client.bindEntity(2, "bot");
    stubFetch(200, { success: false, message: "target offline" });
    await expect(client.speakTo(3, "hi")).rejects.toThrow(/target offline/);
  });

  it("speakTo accepts empty body on 2xx", async () => {
    const client = new EclawClient({
      apiBase: "https://example.test",
      apiKey: "eck_test",
    });
    stubFetch(200, { success: true, deviceId: "dev-1", entityId: 2, botSecret: "s", publicCode: "p", bindingType: "channel" });
    await client.bindEntity(2, "bot");
    stubFetch(200, "");
    await expect(client.speakTo(3, "hi")).resolves.toBeUndefined();
  });
});

describe("eclaw webhook Bearer scheme case-insensitivity (RFC 7235)", () => {
  beforeEach(() => {
    registerEclawWebhookToken("rfc-token", "default");
  });
  afterEach(() => {
    unregisterEclawWebhookToken("rfc-token");
  });

  it("accepts lowercase `bearer` scheme", () => {
    expect(lookupEclawWebhookToken("bearer rfc-token")?.accountId).toBe("default");
  });

  it("accepts uppercase `BEARER` scheme", () => {
    expect(lookupEclawWebhookToken("BEARER rfc-token")?.accountId).toBe("default");
  });

  it("accepts mixed-case `BeArEr` scheme", () => {
    expect(lookupEclawWebhookToken("BeArEr rfc-token")?.accountId).toBe("default");
  });

  it("accepts `Bearer` with extra leading/trailing whitespace", () => {
    expect(lookupEclawWebhookToken("  Bearer rfc-token  ")?.accountId).toBe("default");
  });

  it("still rejects unknown token even when scheme case differs", () => {
    expect(lookupEclawWebhookToken("bearer wrong-token")).toBeUndefined();
  });

  it("still rejects non-Bearer schemes", () => {
    expect(lookupEclawWebhookToken("Basic rfc-token")).toBeUndefined();
    expect(lookupEclawWebhookToken("token rfc-token")).toBeUndefined();
  });
});

describe("eclaw active-event suppression is async-local, not global", () => {
  it("does NOT suppress a concurrent outbound send on the same account", async () => {
    // Import the per-request helper + outbound sender. We stub EclawClient
    // directly via the client-registry so we can count sendMessage calls
    // without running real HTTP.
    const { runWithActiveEclawEvent, getActiveEclawEvent, setEclawClient, clearEclawClient } =
      await import("./src/client-registry.js");
    const { sendEclawText } = await import("./src/send.js");

    let sendCount = 0;
    const fakeClient = {
      sendMessage: vi.fn(async () => {
        sendCount += 1;
        return { success: true } as unknown;
      }),
    };
    setEclawClient("default", fakeClient as unknown as EclawClient);

    try {
      // Start a webhook dispatch that holds the flag open while we race
      // a concurrent outbound send from a DIFFERENT async context.
      let releaseDispatch: (() => void) | undefined;
      const dispatchHeld = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });

      const dispatchPromise = runWithActiveEclawEvent(
        "default",
        "entity_message",
        async () => {
          // Inside the dispatch, the flag IS set (suppression is the desired
          // behavior for b2b duplicate-delivery).
          expect(getActiveEclawEvent("default")).toBe("entity_message");
          await dispatchHeld;
          // Inside the dispatch, a send should be suppressed (returns ok=true
          // without calling sendMessage).
          const inside = await sendEclawText({
            accountId: "default",
            to: "dev:2",
            text: "suppressed",
          });
          expect(inside.ok).toBe(true);
        },
      );

      // From OUTSIDE the dispatch's async context, do a concurrent send.
      // Before the fix, this would see the global flag and be dropped.
      // After the fix (AsyncLocalStorage), it's not in the frame so the
      // flag reads as "message" and the send goes through.
      const outside = await sendEclawText({
        accountId: "default",
        to: "dev:3",
        text: "should NOT be suppressed",
      });
      expect(outside.ok).toBe(true);

      releaseDispatch?.();
      await dispatchPromise;

      // The outside send must have reached sendMessage exactly once.
      // The inside send was suppressed and must NOT have reached it.
      expect(sendCount).toBe(1);
      expect(fakeClient.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      clearEclawClient("default");
    }
  });

  it("reads `message` outside any runWithActiveEclawEvent frame", async () => {
    const { getActiveEclawEvent } = await import("./src/client-registry.js");
    expect(getActiveEclawEvent("default")).toBe("message");
  });
});

describe("eclaw shared HTTP route conflict detection", () => {
  const savedEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...savedEnv };
    const mod = await import("./src/gateway.js");
    mod.__resetEclawSharedRouteForTests();
    vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
    vi.restoreAllMocks();
  });

  it("throws when registerPluginHttpRoute reports a route conflict", async () => {
    // Override the module-level mock to simulate a conflict log.
    // registerPluginHttpRoute returns a no-op AND logs a conflict message
    // when the path is already taken by another plugin.
    vi.doMock("openclaw/plugin-sdk/webhook-ingress", () => ({
      readJsonWebhookBodyOrReject: async () => ({ ok: true, value: {} }),
      registerPluginHttpRoute: (p: {
        log?: (msg: string) => void;
      }) => {
        p.log?.(
          "plugin: route conflict at /eclaw-webhook (exact) for account \"default\"; owned by other-plugin (other-source)",
        );
        return () => {};
      },
    }));
    vi.doMock("openclaw/plugin-sdk/channel-lifecycle", () => ({
      waitUntilAbort: async () => undefined,
    }));

    // Force fresh module graph so the new mock takes effect
    vi.resetModules();
    process.env.ECLAW_API_KEY = "env-key";

    const { startEclawAccount } = await import("./src/gateway.js");

    const logs: string[] = [];
    const abortCtrl = new AbortController();
    // Route-conflict path must re-throw, not silently return — a no-op
    // route means inbound webhooks never arrive, and the manager needs
    // to see the failure so it can alert operators / retry.
    await expect(
      startEclawAccount({
        cfg: {} as never,
        accountId: "default",
        abortSignal: abortCtrl.signal,
        log: {
          info: (m) => logs.push(`info:${m}`),
          warn: (m) => logs.push(`warn:${m}`),
          error: (m) => logs.push(`error:${m}`),
        },
      }),
    ).rejects.toThrow(/failed to register shared HTTP route \/eclaw-webhook.*route conflict/);

    // Sanity: the conflict message from the registry was forwarded to
    // the info log before the throw.
    expect(
      logs.some((l) => l.startsWith("info:") && l.includes("route conflict")),
    ).toBe(true);
  });

  it("throws when registerPluginHttpRoute reports an overlap denial", async () => {
    vi.doMock("openclaw/plugin-sdk/webhook-ingress", () => ({
      readJsonWebhookBodyOrReject: async () => ({ ok: true, value: {} }),
      registerPluginHttpRoute: (p: {
        log?: (msg: string) => void;
      }) => {
        p.log?.(
          "plugin: route overlap denied at /eclaw-webhook (exact, plugin) for account \"default\"; overlaps /eclaw-* (prefix, plugin)",
        );
        return () => {};
      },
    }));
    vi.doMock("openclaw/plugin-sdk/channel-lifecycle", () => ({
      waitUntilAbort: async () => undefined,
    }));

    vi.resetModules();
    process.env.ECLAW_API_KEY = "env-key";

    const { startEclawAccount } = await import("./src/gateway.js");
    const abortCtrl = new AbortController();
    await expect(
      startEclawAccount({
        cfg: {} as never,
        accountId: "default",
        abortSignal: abortCtrl.signal,
      }),
    ).rejects.toThrow(/route overlap denied/);
  });
});

describe("eclaw state cleanup on shared-route failure (round 7)", () => {
  const savedEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...savedEnv };
    const mod = await import("./src/gateway.js");
    mod.__resetEclawSharedRouteForTests();
    vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
    vi.restoreAllMocks();
  });

  it("does not leak webhook token or client registry when acquireSharedEclawHttpRoute throws", async () => {
    vi.doMock("openclaw/plugin-sdk/webhook-ingress", () => ({
      readJsonWebhookBodyOrReject: async () => ({ ok: true, value: {} }),
      registerPluginHttpRoute: (p: { log?: (msg: string) => void }) => {
        p.log?.(
          "plugin: route conflict at /eclaw-webhook (exact) for account \"default\"",
        );
        return () => {};
      },
    }));
    vi.doMock("openclaw/plugin-sdk/channel-lifecycle", () => ({
      waitUntilAbort: async () => undefined,
    }));

    vi.resetModules();
    process.env.ECLAW_API_KEY = "env-key";

    const { startEclawAccount } = await import("./src/gateway.js");
    const { eclawWebhookRegistrySize } = await import("./src/webhook-registry.js");
    const { getEclawClient } = await import("./src/client-registry.js");

    const sizeBefore = eclawWebhookRegistrySize();
    const clientBefore = getEclawClient("default");

    const abortCtrl = new AbortController();
    await expect(
      startEclawAccount({
        cfg: {} as never,
        accountId: "default",
        abortSignal: abortCtrl.signal,
      }),
    ).rejects.toThrow(/route conflict/);

    // Neither the webhook-token registry nor the client registry
    // should hold a stale entry — the thrown acquireSharedEclawHttpRoute
    // happens AFTER registerEclawWebhookToken + setEclawClient but
    // BEFORE the register/bind try/catch, so the guarded cleanup has
    // to live inside an isolated try block wrapped around the
    // acquisition. See gateway.ts round-7 fix.
    expect(eclawWebhookRegistrySize()).toBe(sizeBefore);
    expect(getEclawClient("default")).toBe(clientBefore);
  });
});

describe("eclaw inbound backupUrl fallback (round 7)", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
    clearEclawClient("default");
    vi.restoreAllMocks();
  });

  it("uses backupUrl as MediaUrl when primary mediaUrl is absent", async () => {
    const capturedCtx: Array<Record<string, unknown>> = [];
    const { dispatchEclawWebhookMessage } = await import("./src/webhook-handler.js");
    const { setEclawRuntime } = await import("./src/runtime.js");

    setEclawRuntime({
      channel: {
        reply: {
          finalizeInboundContext: (ctx: Record<string, unknown>) => {
            capturedCtx.push(ctx);
            return ctx;
          },
          dispatchReplyWithBufferedBlockDispatcher: async () => {
            /* no-op */
          },
        },
      },
    } as never);

    // Install a no-op client so the handler doesn't short-circuit.
    setEclawClient("default", {} as unknown as EclawClient);

    await dispatchEclawWebhookMessage({
      accountId: "default",
      cfg: {} as never,
      msg: {
        event: "message",
        deviceId: "dev-1",
        entityId: 2,
        from: "user-1",
        mediaType: "photo",
        mediaUrl: undefined,
        backupUrl: "https://backup.example.test/asset.jpg",
      } as EclawInboundMessage,
    });

    expect(capturedCtx).toHaveLength(1);
    expect(capturedCtx[0]).toMatchObject({
      MediaType: "image",
      MediaUrl: "https://backup.example.test/asset.jpg",
    });
  });

  it("prefers primary mediaUrl over backupUrl when both are present", async () => {
    const capturedCtx: Array<Record<string, unknown>> = [];
    const { dispatchEclawWebhookMessage } = await import("./src/webhook-handler.js");
    const { setEclawRuntime } = await import("./src/runtime.js");

    setEclawRuntime({
      channel: {
        reply: {
          finalizeInboundContext: (ctx: Record<string, unknown>) => {
            capturedCtx.push(ctx);
            return ctx;
          },
          dispatchReplyWithBufferedBlockDispatcher: async () => {
            /* no-op */
          },
        },
      },
    } as never);

    setEclawClient("default", {} as unknown as EclawClient);

    await dispatchEclawWebhookMessage({
      accountId: "default",
      cfg: {} as never,
      msg: {
        event: "message",
        deviceId: "dev-1",
        entityId: 2,
        from: "user-1",
        mediaType: "photo",
        mediaUrl: "https://primary.example.test/asset.jpg",
        backupUrl: "https://backup.example.test/asset.jpg",
      } as EclawInboundMessage,
    });

    expect(capturedCtx).toHaveLength(1);
    expect(capturedCtx[0]?.MediaUrl).toBe("https://primary.example.test/asset.jpg");
  });
});

describe("eclaw webhook handler uses live config snapshot (round 9)", () => {
  const savedEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...savedEnv };
    const mod = await import("./src/gateway.js");
    mod.__resetEclawSharedRouteForTests();
    vi.doUnmock("openclaw/plugin-sdk/runtime-config-snapshot");
    vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
    vi.doUnmock("openclaw/plugin-sdk/channel-lifecycle");
    vi.doUnmock("./src/webhook-handler.js");
    vi.restoreAllMocks();
  });

  it("passes getRuntimeConfigSnapshot() result to handleEclawWebhookRequest instead of startup cfg", async () => {
    const startupCfg = { _tag: "startup-cfg" } as never;
    const snapshotCfg = { _tag: "live-snapshot-cfg" } as never;

    // Capture the cfg seen by the webhook request handler
    const capturedCfgArgs: unknown[] = [];
    vi.doMock("./src/webhook-handler.js", () => ({
      handleEclawWebhookRequest: async (params: { cfg: unknown }) => {
        capturedCfgArgs.push(params.cfg);
        return { status: 200, body: { ok: true } };
      },
    }));

    // Provide a live config snapshot that differs from startupCfg
    vi.doMock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
      getRuntimeConfigSnapshot: () => snapshotCfg,
    }));

    // Capture the registered HTTP handler so we can invoke it directly
    let capturedHandler: ((req: unknown, res: unknown) => Promise<void>) | null = null;
    vi.doMock("openclaw/plugin-sdk/webhook-ingress", () => ({
      readJsonWebhookBodyOrReject: async () => ({ ok: true, value: {} }),
      registerPluginHttpRoute: (p: {
        handler: (req: unknown, res: unknown) => Promise<void>;
        log?: (msg: string) => void;
      }) => {
        capturedHandler = p.handler;
        return () => {};
      },
    }));

    vi.doMock("openclaw/plugin-sdk/channel-lifecycle", () => ({
      waitUntilAbort: () => new Promise(() => { /* never resolves */ }),
    }));

    vi.resetModules();
    process.env.ECLAW_API_KEY = "env-key";

    const { startEclawAccount } = await import("./src/gateway.js");

    const abortCtrl = new AbortController();
    // Start without awaiting — account stays alive until aborted
    const startPromise = startEclawAccount({
      cfg: startupCfg,
      accountId: "default",
      abortSignal: abortCtrl.signal,
    });

    // Poll until the route handler is registered
    for (let i = 0; i < 50 && !capturedHandler; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(capturedHandler).not.toBeNull();

    // Simulate a POST to /eclaw-webhook
    const mockReq = { method: "POST", headers: { authorization: "Bearer token" } };
    const chunks: unknown[] = [];
    const mockRes = {
      statusCode: 0,
      setHeader: () => {},
      end: (body: unknown) => { chunks.push(body); },
    };
    await capturedHandler!(mockReq, mockRes);

    // The handler must have forwarded the LIVE snapshot config, not the startup snapshot
    expect(capturedCfgArgs).toHaveLength(1);
    expect(capturedCfgArgs[0]).toBe(snapshotCfg);
    expect(capturedCfgArgs[0]).not.toBe(startupCfg);

    abortCtrl.abort();
    await startPromise.catch(() => { /* aborted */ });
  });

  it("falls back to startup cfg when getRuntimeConfigSnapshot() returns null", async () => {
    const startupCfg = { _tag: "startup-cfg" } as never;
    const capturedCfgArgs: unknown[] = [];

    vi.doMock("./src/webhook-handler.js", () => ({
      handleEclawWebhookRequest: async (params: { cfg: unknown }) => {
        capturedCfgArgs.push(params.cfg);
        return { status: 200, body: { ok: true } };
      },
    }));

    vi.doMock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
      getRuntimeConfigSnapshot: () => null,
    }));

    let capturedHandler: ((req: unknown, res: unknown) => Promise<void>) | null = null;
    vi.doMock("openclaw/plugin-sdk/webhook-ingress", () => ({
      readJsonWebhookBodyOrReject: async () => ({ ok: true, value: {} }),
      registerPluginHttpRoute: (p: {
        handler: (req: unknown, res: unknown) => Promise<void>;
      }) => {
        capturedHandler = p.handler;
        return () => {};
      },
    }));

    vi.doMock("openclaw/plugin-sdk/channel-lifecycle", () => ({
      waitUntilAbort: () => new Promise(() => { /* never resolves */ }),
    }));

    vi.resetModules();
    process.env.ECLAW_API_KEY = "env-key";

    const { startEclawAccount } = await import("./src/gateway.js");

    const abortCtrl = new AbortController();
    const startPromise = startEclawAccount({
      cfg: startupCfg,
      accountId: "default",
      abortSignal: abortCtrl.signal,
    });

    for (let i = 0; i < 50 && !capturedHandler; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(capturedHandler).not.toBeNull();

    const mockReq = { method: "POST", headers: { authorization: "Bearer token" } };
    const mockRes = { statusCode: 0, setHeader: () => {}, end: () => {} };
    await capturedHandler!(mockReq, mockRes);

    // When snapshot is null, must fall back to startup cfg
    expect(capturedCfgArgs).toHaveLength(1);
    expect(capturedCfgArgs[0]).toBe(startupCfg);

    abortCtrl.abort();
    await startPromise.catch(() => { /* aborted */ });
  });
});

describe("eclaw account stop awaits unregisterCallback (round 10)", () => {
  const savedEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...savedEnv };
    const mod = await import("./src/gateway.js");
    mod.__resetEclawSharedRouteForTests();
    vi.doUnmock("openclaw/plugin-sdk/channel-lifecycle");
    vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
    vi.restoreAllMocks();
  });

  it("awaits unregisterCallback during graceful account stop so the remote callback is fully torn down", async () => {
    // Track whether unregisterCallback resolved before we observed it.
    // Must use doMock on client.js so the mock is in effect for the
    // re-imported gateway module after vi.resetModules().
    let unregisterResolved = false;
    vi.doMock("./src/client.js", () => ({
      EclawClient: class MockEclawClient {
        async registerCallback() {
          return { success: true, deviceId: "dev-stop", entities: [] };
        }
        async bindEntity() {
          return { entityId: 1, publicCode: "PC1" };
        }
        async unregisterCallback() {
          unregisterResolved = true;
        }
      },
    }));

    // Capture onAbort so we can trigger it manually
    let capturedOnAbort: (() => void | Promise<void>) | undefined;
    vi.doMock("openclaw/plugin-sdk/channel-lifecycle", () => ({
      waitUntilAbort: (
        _signal: AbortSignal,
        onAbort?: () => void | Promise<void>,
      ) => {
        capturedOnAbort = onAbort;
        // Never resolves on its own — we call onAbort manually
        return new Promise<void>(() => {});
      },
    }));

    vi.doMock("openclaw/plugin-sdk/webhook-ingress", () => ({
      readJsonWebhookBodyOrReject: async () => ({ ok: true, value: {} }),
      registerPluginHttpRoute: () => () => {},
    }));

    vi.resetModules();
    process.env.ECLAW_API_KEY = "env-key-stop-test";

    const { startEclawAccount } = await import("./src/gateway.js");

    const abortCtrl = new AbortController();
    // Start without awaiting — account stays alive until onAbort fires
    void startEclawAccount({
      cfg: {} as never,
      accountId: "default",
      abortSignal: abortCtrl.signal,
    });

    // Poll until waitUntilAbort has been called and onAbort captured
    for (let i = 0; i < 50 && capturedOnAbort === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(capturedOnAbort).toBeDefined();

    // Invoke the cleanup and await it — must not resolve until unregisterCallback finishes
    await capturedOnAbort!();

    // The critical assertion: unregisterCallback must have been awaited
    // (resolved) before onAbort's returned Promise settled.
    expect(unregisterResolved).toBe(true);
  });
});
