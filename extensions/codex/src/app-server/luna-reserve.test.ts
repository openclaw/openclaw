import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  recordCodexAppServerAuthHandoff,
} from "./client-runtime.js";
import { prepareCodexLunaReserveTurn } from "./luna-reserve.js";
import { isJsonObject, type CodexTurnStartParams } from "./protocol.js";
import {
  createCodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import { createClientHarness } from "./test-support.js";

const offer = {
  banner_type: "luna_reserve",
  title: "Reserve",
  description: "Backend offer",
  ctas: [],
  blocked_model_slug: "gpt-5.6-luna",
};
const returnTarget = {
  accountId: "account-a",
  model: "gpt-5.6-luna",
  effort: "high",
  serviceTier: null,
};
const clients: ReturnType<typeof createClientHarness>["client"][] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.close());
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
});

async function fixture(
  options: {
    usage?: unknown;
    binding?: Partial<CodexAppServerThreadBinding>;
    account?: string | null;
    readHook?: () => void;
    readError?: number;
  } = {},
) {
  const requests: { method: string; params: unknown }[] = [];
  const harness = createClientHarness({
    onWrite(line, send) {
      const request: unknown = JSON.parse(line);
      if (!isJsonObject(request) || typeof request.method !== "string") {
        return;
      }
      requests.push({ method: request.method, params: request.params });
      if (request.method === "account/rateLimits/read") {
        options.readHook?.();
        if (options.readError && request.params) {
          return send({
            id: request.id,
            error: { code: options.readError, message: "unsupported" },
          });
        }
        send({
          id: request.id,
          result: options.usage ?? {
            accountId: "account-a",
            rateLimitUpsell: offer,
            ordinaryUsageAllowed: false,
            rateLimits: {},
          },
        });
      } else if (request.method === "model/list") {
        send({
          id: request.id,
          result: {
            data: ["gpt-reserve", "gpt-5.6-luna"].map((model) => ({
              id: model,
              model,
              displayName: model,
              description: "fixture",
              hidden: model === "gpt-reserve",
              isDefault: false,
              inputModalities: ["text"],
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "medium" }],
              defaultReasoningEffort: "medium",
              serviceTiers: [],
              defaultServiceTier: null,
            })),
            nextCursor: null,
          },
        });
      }
    },
  });
  clients.push(harness.client);
  ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/fixture/agent" });
  const accountId = options.account === undefined ? "account-a" : options.account;
  if (accountId) {
    recordCodexAppServerAuthHandoff(harness.client, {
      accessFingerprint: "fixture",
      chatgptAccountId: accountId,
    });
  }
  const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
    namespace: "reserve-test",
    maxEntries: 20,
    overflowPolicy: "reject-new",
  });
  const store = createCodexAppServerBindingStore(state);
  const identity = { kind: "conversation" as const, bindingId: "reserve-test" };
  const binding: CodexAppServerThreadBinding = {
    threadId: "thread-a",
    cwd: "/fixture",
    model: "gpt-5.6-luna",
    modelProvider: "openai",
    ...options.binding,
  };
  await store.mutate(identity, { kind: "set", binding });
  const normal: CodexTurnStartParams = {
    threadId: binding.threadId,
    input: [{ type: "text", text: "pending input", text_elements: [] }],
    model: "gpt-5.6-luna",
    effort: "high",
    serviceTier: null,
  };
  return {
    harness,
    requests,
    store,
    identity,
    binding,
    normal,
    run: () =>
      prepareCodexLunaReserveTurn({
        client: harness.client,
        bindingStore: store,
        identity,
        binding,
        normal,
        assertCurrent: () => undefined,
        signal: new AbortController().signal,
        timeoutMs: 2_000,
      }),
  };
}

describe("active-owner Luna Reserve transitions (mocked backend)", () => {
  it("persists return intent before input and records the model only after acceptance", async () => {
    const f = await fixture();
    const prepared = await f.run();
    expect(prepared?.settings).toMatchObject({
      model: "gpt-reserve",
      effort: "medium",
      serviceTier: null,
    });
    expect(f.store.read(f.identity)?.model).toBe("gpt-5.6-luna");
    await prepared?.accepted?.();
    expect(f.store.read(f.identity)).toMatchObject({
      model: "gpt-reserve",
      reserveReturn: returnTarget,
    });
    expect(f.requests.map((r) => r.method)).toEqual(["account/rateLimits/read", "model/list"]);
    expect(f.requests[0]?.params).toEqual({
      supportsLunaReserve: true,
      excludeResetCreditDetails: true,
    });
    expect(f.normal.input).toHaveLength(1);
  });
  it.each([
    null,
    { ...offer, banner_type: "upgrade" },
    { ...offer, blocked_model_slug: "different" },
    { banner_type: "luna_reserve" },
  ])("does not infer Reserve from absent/malformed/nonmatching banner %j", async (banner) => {
    const f = await fixture({
      usage: {
        accountId: "account-a",
        rateLimitUpsell: banner,
        ordinaryUsageAllowed: false,
        rateLimits: { primary: { usedPercent: 100 } },
      },
    });
    expect((await f.run())?.settings).toBeUndefined();
    expect(f.requests).toHaveLength(1);
  });
  it("honors the native account-level Reserve offer without inventing a Luna-only restriction", async () => {
    // Codex 0.154.0 backend_banners.rs treats absent blocked_model_slug as account-wide;
    // its luna_reserve_recovery_tests.rs explicitly switches from gpt-5.4.
    const { blocked_model_slug: _blockedModel, ...accountOffer } = offer;
    const f = await fixture({
      usage: {
        accountId: "account-a",
        rateLimitUpsell: accountOffer,
        ordinaryUsageAllowed: false,
        rateLimits: {},
      },
    });
    f.normal.model = "gpt-5.4";
    expect((await f.run())?.settings).toMatchObject({ model: "gpt-reserve" });
    expect(f.store.read(f.identity)?.reserveReturn?.model).toBe("gpt-5.4");
  });
  it("does not advertise capability for API-key or unowned clients", async () => {
    const f = await fixture({ account: null });
    expect((await f.run())?.settings).toBeUndefined();
    expect(f.requests).toEqual([]);
  });
  it("does not take model ownership from an adopted native thread", async () => {
    const f = await fixture({ binding: { preserveNativeModel: true } });
    expect((await f.run())?.settings).toBeUndefined();
    expect(f.requests).toEqual([]);
  });
  it("rejects mismatched backend identity without entering Reserve", async () => {
    const f = await fixture({ usage: { accountId: "other", rateLimitUpsell: offer } });
    expect((await f.run())?.settings).toBeUndefined();
    expect(f.binding.reserveReturn).toBeUndefined();
  });
  it.each([-32600, -32602])("uses only old-server compatibility errors %s", async (code) => {
    const f = await fixture({ readError: code });
    expect((await f.run())?.settings).toBeUndefined();
    expect(f.requests.map((r) => r.params)).toEqual([
      { supportsLunaReserve: true, excludeResetCreditDetails: true },
      undefined,
    ]);
  });
  it("does not downgrade authentication failures to ordinary inference", async () => {
    const f = await fixture({ readError: -32603 });
    await expect(f.run()).rejects.toThrow("unsupported");
    expect(f.requests).toHaveLength(1);
  });
  it("rejects a stale account observation", async () => {
    const options: { readHook?: () => void } = {};
    const f = await fixture(options);
    options.readHook = () =>
      recordCodexAppServerAuthHandoff(f.harness.client, {
        accessFingerprint: "new",
        chatgptAccountId: "account-b",
      });
    await expect(f.run()).rejects.toThrow("ownership changed");
    expect(f.requests).toHaveLength(1);
  });
  it.each([true, false])(
    "restores only validated ordinary permission or usable credits (ordinary=%s)",
    async (allowed) => {
      const f = await fixture({
        binding: { model: "gpt-reserve", reserveReturn: returnTarget },
        usage: {
          accountId: "account-a",
          rateLimitUpsell: null,
          ordinaryUsageAllowed: allowed,
          rateLimits: { credits: { hasCredits: true } },
        },
      });
      const prepared = await f.run();
      expect(prepared?.settings).toMatchObject({ model: "gpt-5.6-luna", serviceTier: null });
      expect(f.store.read(f.identity)?.reserveReturn).toEqual(returnTarget);
      await prepared?.accepted?.();
      expect(f.store.read(f.identity)?.reserveReturn).toBeUndefined();
    },
  );
  it.each([
    { ordinaryUsageAllowed: null, rateLimits: {} },
    { ordinaryUsageAllowed: true, rateLimits: { spendControlReached: true } },
    { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: "weekly" } },
  ])("does not restore ordinary from unknown permission or blocker %j", async (permission) => {
    const f = await fixture({
      binding: { model: "gpt-reserve", reserveReturn: returnTarget },
      usage: { accountId: "account-a", rateLimitUpsell: null, ...permission },
    });
    await expect(f.run()).rejects.toThrow("not confirmed Reserve continuation");
    expect(f.store.read(f.identity)?.reserveReturn).toEqual(returnTarget);
  });
  it("never restores another account’s saved model", async () => {
    const f = await fixture({
      account: "account-b",
      binding: { model: "gpt-reserve", reserveReturn: returnTarget },
    });
    await expect(f.run()).rejects.toThrow("Reserve account changed");
    expect(f.requests).toEqual([]);
  });
  it("keeps an explicit new ordinary choice and discards only its own return target", async () => {
    const f = await fixture({ binding: { model: "gpt-reserve", reserveReturn: returnTarget } });
    f.normal.model = "explicit-model";
    const prepared = await f.run();
    expect(prepared?.settings).toMatchObject({ model: "explicit-model" });
    await prepared?.accepted?.();
    expect(f.store.read(f.identity)?.reserveReturn).toBeUndefined();
  });
  it("cannot force the hidden route through an explicit model choice", async () => {
    const f = await fixture({ binding: { model: "gpt-reserve", reserveReturn: returnTarget } });
    f.normal.model = "gpt-reserve";
    await expect(f.run()).rejects.toThrow("cannot be selected manually");
    expect(f.requests).toEqual([]);
  });
  it("preserves a native model choice made outside OpenClaw", async () => {
    const f = await fixture({ binding: { model: "external-model", reserveReturn: returnTarget } });
    await expect(f.run()).rejects.toThrow("native model changed");
    expect(f.requests).toEqual([]);
  });
  it("does not treat a pending return marker as permission to enter Reserve", async () => {
    const f = await fixture({
      binding: { reserveReturn: returnTarget },
      usage: {
        accountId: "account-a",
        rateLimitUpsell: null,
        ordinaryUsageAllowed: null,
        rateLimits: {},
      },
    });
    await expect(f.run()).rejects.toThrow("not confirmed");
    expect(f.requests).toHaveLength(1);
  });
});
