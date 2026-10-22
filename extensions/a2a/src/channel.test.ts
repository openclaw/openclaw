import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { a2aChannelPlugin } from "./channel.js";
import { a2aPluginConfigSchema } from "./config-schema.js";
import type { A2aCoreConfig, A2aPeerConfig } from "./types.js";

afterEach(() => vi.restoreAllMocks());

function createA2aSendConfig(
  peers: Record<string, A2aPeerConfig> = { hermes: peer },
): A2aCoreConfig {
  return { channels: { a2a: { peers } } };
}

const peer = {
  token: "test-inbound-token",
  url: "https://peer.example.test/a2a/v1",
  outboundToken: "test-outbound-token",
};

function sendParams(assertDirectAdapterHandoff: () => void, to = "hermes", text = "hello") {
  return { cfg: createA2aSendConfig(), accountId: "default", to, text, assertDirectAdapterHandoff };
}

// Discovery and runtime validation share this schema (#131292).
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
        peers: { "hermes.bot-1": peer },
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
  ])("rejects %s in every validation surface", (label, value) => {
    assertConfigAcceptance(value, false, label);
  });

  it("exposes only the configured default account and peer-derived sender allowlist", () => {
    const { config } = a2aChannelPlugin;
    const cfg = createA2aSendConfig({
      hermes: { token: "test-hermes-token" },
      crew: { token: "test-crew-token" },
    });

    expect(config.listAccountIds(cfg)).toEqual(["default"]);
    expect(config.resolveAccount(cfg)).toMatchObject({
      accountId: "default",
      enabled: true,
      configured: true,
    });
    expect(config.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual(["hermes", "crew"]);
    expect(config.listAccountIds({})).toEqual([]);
    expect(config.resolveAccount({ channels: { a2a: {} } }).configured).toBe(false);
  });
});

describe("A2A channel message adapter", () => {
  it.each(["preferred", "legacy"] as const)(
    "checks authority after transport preparation through the %s registered send",
    async (surface) => {
      const guardedFetch = ssrfRuntime.fetchWithSsrFGuard;
      const lookupStarted = createDeferred<void>();
      const lookupFinished = createDeferred<Array<{ address: string; family: 4 }>>();
      const lookupFn: NonNullable<Parameters<typeof guardedFetch>[0]["lookupFn"]> = vi.fn(
        async () => {
          lookupStarted.resolve();
          return await lookupFinished.promise;
        },
      );
      vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementationOnce(
        async (params) => await guardedFetch({ ...params, lookupFn }),
      );
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response('{"jsonrpc":"2.0","result":{}}'));
      let current = true;
      const assertDirectAdapterHandoff = vi.fn(() => {
        if (!current) {
          throw new Error("source authority revoked");
        }
      });

      const sender =
        surface === "preferred"
          ? a2aChannelPlugin.message?.send?.text
          : a2aChannelPlugin.outbound?.sendText;
      if (!sender) {
        throw new Error(`expected ${surface} A2A text sender`);
      }
      const send = sender(sendParams(assertDirectAdapterHandoff));
      await lookupStarted.promise;
      current = false;
      lookupFinished.resolve([{ address: "93.184.216.34", family: 4 }]);

      await expect(send).rejects.toThrow("source authority revoked");
      expect(lookupFn).toHaveBeenCalledOnce();
      expect(assertDirectAdapterHandoff).toHaveBeenCalledOnce();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("keeps authority current through preferred and legacy registered sends", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ jsonrpc: "2.0", id: "response-id", result: { task: { id: "task-42" } } }),
      );

    const adapter = a2aChannelPlugin.message;
    const sendText = adapter?.send?.text;
    if (!sendText) {
      throw new Error("expected A2A channel message adapter with text sender");
    }
    expect(adapter?.durableFinal?.capabilities).toEqual({ text: true });
    expect(adapter?.send?.media).toBeUndefined();
    const assertDirectAdapterHandoff = vi.fn();

    const result = await sendText(sendParams(assertDirectAdapterHandoff, "a2a:hermes"));
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, request] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://peer.example.test/a2a/v1");
    expect(request).toMatchObject({
      headers: { "content-type": "application/json", authorization: "Bearer test-outbound-token" },
      method: "POST",
      // The SSRF guard inspects redirects itself instead of delegating to fetch.
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    assert(typeof request?.body === "string", "expected a serialized A2A request body");
    expect(JSON.parse(request.body)).toEqual({
      jsonrpc: "2.0",
      id: expect.any(String),
      method: "SendMessage",
      params: {
        message: {
          messageId: expect.any(String),
          role: "ROLE_USER",
          contextId: "ctx-oc-hermes",
          parts: [{ text: "hello" }],
        },
        configuration: { returnImmediately: true },
      },
    });
    expect(result).toMatchObject({
      messageId: "task-42",
      receipt: { parts: [expect.objectContaining({ kind: "text", platformMessageId: "task-42" })] },
    });
    expect(assertDirectAdapterHandoff).toHaveBeenCalledOnce();

    const legacySendText = a2aChannelPlugin.outbound?.sendText;
    if (!legacySendText) {
      throw new Error("expected A2A legacy outbound text sender");
    }
    const assertLegacyHandoff = vi.fn();
    fetchSpy.mockClear();
    await expect(
      legacySendText(sendParams(assertLegacyHandoff, "hermes", "legacy hello")),
    ).resolves.toMatchObject({ channel: "a2a", messageId: "task-42" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(assertLegacyHandoff).toHaveBeenCalledOnce();
  });
});
