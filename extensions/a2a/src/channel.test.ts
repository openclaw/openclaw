import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";
import { a2aChannelPlugin } from "./channel.js";
import { a2aPluginConfigSchema } from "./config-schema.js";
import type { A2aCoreConfig } from "./types.js";

/** Outbound A2A bodies are serialized JSON strings; assert that before parsing. */
function parseA2aOutboundBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error(`expected a serialized A2A request body, got ${typeof body}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

// Cold (discovery-time) validation uses the zod-derived generated bundled
// channel metadata, which the generator builds from this same config-schema
// module — the manifest carries no schema copy to drift (see #131292).
function assertConfigAcceptance(value: unknown, expected: boolean, label: string): void {
  const runtime = a2aPluginConfigSchema.runtime;
  if (!runtime) {
    throw new Error("expected A2A runtime config schema");
  }
  expect(runtime.safeParse(value).success, `${label}: runtime`).toBe(expected);
  const result = validateJsonSchemaValue({
    cacheKey: "a2a.channel.config.runtime-json",
    schema: a2aPluginConfigSchema.schema,
    value,
  });
  expect(result.ok, `${label}: runtime-json`).toBe(expected);
}

describe("A2A channel configuration", () => {
  it("keeps runtime and cold-manifest validation aligned for supported settings", () => {
    assertConfigAcceptance(
      {
        enabled: true,
        advertisedUrl: "https://gateway.example.test",
        replyTimeoutMs: 120_000,
        rateLimitPerMinute: 30,
        exposeAgents: ["assistant"],
        peers: {
          "hermes.bot-1": {
            token: "test-inbound-token",
            url: "https://peer.example.test/a2a/v1",
            outboundToken: "test-outbound-token",
          },
        },
      },
      true,
      "complete channel config",
    );
    expect(a2aPluginConfigSchema.uiHints?.["peers.*.token"]?.sensitive).toBe(true);
    expect(a2aPluginConfigSchema.uiHints?.["peers.*.outboundToken"]?.sensitive).toBe(true);
  });

  it.each([
    ["uppercase peer name", { peers: { Hermes: { token: "test-token" } } }],
    ["invalid peer punctuation", { peers: { "bad/peer": { token: "test-token" } } }],
    ["empty peer token", { peers: { hermes: { token: "" } } }],
    ["missing peer token", { peers: { hermes: { url: "https://peer.example.test" } } }],
    ["empty outbound token", { peers: { hermes: { token: "test", outboundToken: "" } } }],
    ["non-HTTP advertised URL", { advertisedUrl: "ftp://gateway.example.test" }],
    ["non-HTTP peer URL", { peers: { hermes: { token: "test", url: "file:///tmp/peer" } } }],
    ["reply timeout below minimum", { replyTimeoutMs: 4_999 }],
    ["reply timeout above maximum", { replyTimeoutMs: 600_001 }],
    ["negative rate limit", { rateLimitPerMinute: -1 }],
    ["unsupported multiple accounts", { accounts: { work: {} } }],
    ["unknown channel field", { target: "https://untrusted.example.test" }],
  ])("rejects %s in every validation surface", (label, value) => {
    assertConfigAcceptance(value, false, label);
  });

  it("exposes only the configured default account and peer-derived sender allowlist", () => {
    const cfg: A2aCoreConfig = {
      channels: {
        a2a: {
          peers: {
            hermes: { token: "test-hermes-token" },
            crew: { token: "test-crew-token" },
          },
        },
      },
    };

    expect(a2aChannelPlugin.config.listAccountIds(cfg)).toEqual(["default"]);
    expect(a2aChannelPlugin.config.resolveAccount(cfg)).toMatchObject({
      accountId: "default",
      enabled: true,
      configured: true,
    });
    expect(a2aChannelPlugin.config.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([
      "hermes",
      "crew",
    ]);
    expect(a2aChannelPlugin.config.listAccountIds({})).toEqual([]);
    expect(a2aChannelPlugin.config.resolveAccount({ channels: { a2a: {} } }).configured).toBe(
      false,
    );
  });
});

describe("A2A channel message adapter", () => {
  it.each(["preferred", "legacy"] as const)(
    "checks authority after transport preparation through the %s registered send",
    async (surface) => {
      const guardedFetch = ssrfRuntime.fetchWithSsrFGuard;
      let markLookupStarted: (() => void) | undefined;
      const lookupStarted = new Promise<void>((resolve) => {
        markLookupStarted = resolve;
      });
      let finishLookup: ((addresses: Array<{ address: string; family: 4 }>) => void) | undefined;
      const lookupFinished = new Promise<Array<{ address: string; family: 4 }>>((resolve) => {
        finishLookup = resolve;
      });
      const lookupFn: NonNullable<Parameters<typeof guardedFetch>[0]["lookupFn"]> = vi.fn(
        async () => {
          markLookupStarted?.();
          return await lookupFinished;
        },
      );
      vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementationOnce(
        async (params) => await guardedFetch({ ...params, lookupFn }),
      );
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response('{"jsonrpc":"2.0","result":{}}'));
      const cfg: A2aCoreConfig = {
        channels: {
          a2a: {
            peers: {
              hermes: {
                token: "test-inbound-token",
                url: "https://peer.example.test/a2a/v1",
              },
            },
          },
        },
      };
      let current = true;
      const assertDirectAdapterHandoff = vi.fn(() => {
        if (!current) {
          throw new Error("source authority revoked");
        }
      });

      try {
        const send =
          surface === "preferred"
            ? a2aChannelPlugin.message?.send?.text?.({
                cfg,
                accountId: "default",
                to: "hermes",
                text: "hello",
                assertDirectAdapterHandoff,
              })
            : a2aChannelPlugin.outbound?.sendText?.({
                cfg,
                to: "hermes",
                text: "hello",
                assertDirectAdapterHandoff,
              });
        if (!send) {
          throw new Error(`expected ${surface} A2A text sender`);
        }
        await lookupStarted;
        current = false;
        finishLookup?.([{ address: "93.184.216.34", family: 4 }]);

        await expect(send).rejects.toThrow("source authority revoked");
        expect(lookupFn).toHaveBeenCalledOnce();
        expect(assertDirectAdapterHandoff).toHaveBeenCalledOnce();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("keeps authority current through preferred and legacy registered sends", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "response-id",
            result: { task: { id: "task-42" } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    try {
      const cfg: A2aCoreConfig = {
        channels: {
          a2a: {
            peers: {
              hermes: {
                token: "test-inbound-token",
                url: "https://peer.example.test/a2a/v1",
                outboundToken: "test-outbound-token",
              },
            },
          },
        },
      };
      const adapter = a2aChannelPlugin.message;
      const sendText = adapter?.send?.text;
      if (!adapter || !sendText) {
        throw new Error("expected A2A channel message adapter with text sender");
      }
      expect(adapter.send?.media).toBeUndefined();
      const assertDirectAdapterHandoff = vi.fn();

      await verifyChannelMessageAdapterCapabilityProofs({
        adapterName: "a2aChannelMessageAdapter",
        adapter,
        proofs: {
          text: async () => {
            const result = await sendText({
              cfg,
              accountId: "default",
              to: "hermes",
              text: "hello",
              assertDirectAdapterHandoff,
            });
            expect(fetchSpy).toHaveBeenCalledOnce();
            const [url, request] = fetchSpy.mock.calls[0] ?? [];
            expect(url).toBe("https://peer.example.test/a2a/v1");
            expect(request).toMatchObject({
              headers: { authorization: "Bearer test-outbound-token" },
              method: "POST",
              // The SSRF guard inspects redirects itself instead of delegating to fetch.
              redirect: "manual",
            });
            expect(parseA2aOutboundBody(request?.body)).toMatchObject({
              jsonrpc: "2.0",
              method: "SendMessage",
              params: {
                message: {
                  role: "ROLE_USER",
                  contextId: "ctx-oc-hermes",
                  parts: [{ text: "hello" }],
                },
                configuration: { returnImmediately: true },
              },
            });
            expect(result.messageId).toBe("task-42");
            expect(result.receipt.parts[0]).toMatchObject({
              kind: "text",
              platformMessageId: "task-42",
            });
            expect(assertDirectAdapterHandoff).toHaveBeenCalledOnce();
          },
        },
      });

      const legacySendText = a2aChannelPlugin.outbound?.sendText;
      if (!legacySendText) {
        throw new Error("expected A2A legacy outbound text sender");
      }
      const assertLegacyHandoff = vi.fn();
      fetchSpy.mockClear();
      await expect(
        legacySendText({
          cfg,
          to: "hermes",
          text: "legacy hello",
          assertDirectAdapterHandoff: assertLegacyHandoff,
        }),
      ).resolves.toMatchObject({ channel: "a2a", messageId: "task-42" });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(assertLegacyHandoff).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
