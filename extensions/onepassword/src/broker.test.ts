import assert from "node:assert/strict";
import type {
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/types";
import { afterEach, expect, it, vi } from "vitest";
import {
  OnePasswordBroker,
  type AuditRow,
  type PendingAuthorization,
  type StandingGrant,
} from "./broker.js";
import type { OnePasswordConfig, OnePasswordItemConfig } from "./config.js";
import { MemoryKeyedStore } from "./memory-store.test-support.js";
import { AUTHORIZATION_NONCE_PARAM } from "./pending-authorization.js";
import { createOnePasswordTool } from "./tool.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const invocation = { agentId: "a", sessionKey: "a", sessionId: "a" };
const unauthorized = "POLICY_NOT_EVALUATED";

function config() {
  function item(name: string, policy: OnePasswordItemConfig["policy"]) {
    return { item: name, vault: "Automation", field: "credential", policy };
  }
  return {
    vault: "Automation",
    defaultPolicy: "approve",
    cacheTtlSeconds: 300,
    grantTtlHours: 1,
    opTimeoutMs: 15_000,
    items: {
      automatic: { ...item("Automatic", "auto"), description: "Automatic item" },
      approval: item("Approval", "approve"),
      blocked: item("Blocked", "deny"),
    },
  } satisfies OnePasswordConfig;
}

function setup(configured: OnePasswordConfig = config()) {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let currentConfig: OnePasswordConfig | undefined = configured;
  const audit = new MemoryKeyedStore<AuditRow>(() => now);
  const grants = new MemoryKeyedStore<StandingGrant>(() => now);
  const pending = new MemoryKeyedStore<PendingAuthorization>(() => now);
  const getItem = vi.fn(async () => ({ value: "secret", itemTitle: "item", fieldLabel: "field" }));
  const createBroker = () =>
    new OnePasswordBroker({
      resolveConfig: () => currentConfig,
      opClient: { getItem },
      stores: { audit, grants, pending },
    });
  const broker = createBroker();
  return {
    broker,
    createBroker,
    grants,
    pending,
    getItem,
    expectRows: async (...rows: Partial<AuditRow>[]) => {
      expect((await audit.entries()).map(({ value }) => value)).toMatchObject(rows);
    },
    expectAudit: async (key: keyof AuditRow, values: unknown[]) => {
      expect((await audit.entries()).map(({ value }) => value[key])).toEqual(values);
    },
    setConfig: (next: OnePasswordConfig | undefined) => {
      currentConfig = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function request(slug: string, reason = "test") {
  return { action: "get", slug, reason } as const;
}

async function before(
  broker: OnePasswordBroker,
  toolCallId: string,
  params: Record<string, unknown>,
  context: Omit<PluginHookToolContext, "toolName" | "toolCallId"> = invocation,
): Promise<PluginHookBeforeToolCallResult | void> {
  return broker.beforeToolCall(
    { toolName: "onepassword", params, toolCallId },
    { toolName: "onepassword", toolCallId, ...context },
  );
}

function nonceOf(result: PluginHookBeforeToolCallResult | void): string | undefined {
  const nonce = result?.params?.[AUTHORIZATION_NONCE_PARAM];
  return typeof nonce === "string" ? nonce : undefined;
}

async function prepareGet(
  broker: OnePasswordBroker,
  toolCallId: string,
  slug: string,
  reason = "test",
  context: Omit<PluginHookToolContext, "toolName" | "toolCallId"> = invocation,
) {
  const input = request(slug, reason);
  const hook = await before(broker, toolCallId, input, context);
  return {
    hook,
    get: (caller = context) => broker.get(toolCallId, input, caller, nonceOf(hook)),
    execute: (executor = broker, dropNonce = false) =>
      createOnePasswordTool(executor, invocation).execute(
        toolCallId,
        dropNonce ? input : { ...input, ...hook?.params },
      ),
  };
}

async function grant(broker: OnePasswordBroker, id: string) {
  const access = await prepareGet(broker, id, "approval");
  await access.hook?.requireApproval?.onResolution?.("allow-always");
  await access.get();
}

async function expectToolError(result: Promise<{ details?: unknown }>, code: string) {
  expect((await result).details).toMatchObject({ ok: false, error: { code } });
}

it.each([
  [{ action: "get", slug: "blocked" }, "INVALID_REASON"],
  [request("blocked", "   "), "INVALID_REASON"],
  [request("blocked", "x".repeat(301)), "INVALID_REASON"],
  [request("Bad"), "INVALID_SLUG"],
  [request("constructor"), "UNKNOWN_SLUG"],
  [request("blocked"), undefined],
  [request("automatic"), "POLICY_CHANGED"],
] as const)("blocks invalid or unavailable access: %j (%s)", async (params, errorCode) => {
  const { broker, expectRows, getItem, setConfig } = setup();
  if (errorCode === "POLICY_CHANGED") {
    setConfig(undefined);
  }
  expect(await before(broker, "blocked", params)).toMatchObject({ block: true });
  await expectRows({
    outcome: errorCode ? "error" : "policy-denied",
    ...(errorCode ? { errorCode } : {}),
  });
  expect(getItem).not.toHaveBeenCalled();
});

it("handles allow-once, deny, timeout, and cancellation decisions", async () => {
  const { broker, expectAudit, pending } = setup();
  const approved = await prepareGet(broker, "approve-1", "approval", "one use");
  const approval = approved.hook?.requireApproval;
  expect(approval?.allowedDecisions).toEqual(["allow-once", "allow-always", "deny"]);
  await approval?.onResolution?.("allow-once");
  await approved.get();

  for (const decision of ["deny", "timeout", "cancelled"] as const) {
    const hook = await before(broker, decision, request("approval"));
    await hook?.requireApproval?.onResolution?.(decision);
  }
  expect(await pending.entries()).toEqual([]);
  await expectAudit("outcome", ["approved", "denied", "timeout", "error"]);
});

it.each([false, true])("joins broker writes once (nonce dropped: %s)", async (dropNonce) => {
  const { broker, createBroker, pending, getItem } = setup();
  const release = Promise.withResolvers<void>();
  const register = pending.register.bind(pending);
  vi.spyOn(pending, "register").mockImplementationOnce(async (...args) => {
    await release.promise;
    await register(...args);
  });
  const approved = await prepareGet(broker, "delayed", "approval");
  const resolution = approved.hook?.requireApproval?.onResolution?.("allow-once");
  const executor = createBroker();
  const results = Promise.all([
    approved.execute(executor, dropNonce),
    approved.execute(executor, dropNonce),
  ]);
  try {
    await before(broker, "unrelated", request("automatic"));
    expect(getItem).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await resolution;
  }
  expect((await results).map((result) => result.details)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ok: true, slug: "approval" }),
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: unauthorized }),
      }),
    ]),
  );
  expect(getItem).toHaveBeenCalledTimes(1);
});

it("settles matching writes after a failure without retaining failed authorization", async () => {
  const { broker, createBroker, pending, expectRows, getItem } = setup();
  const failed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const register = pending.register.bind(pending);
  vi.spyOn(pending, "register")
    .mockImplementationOnce(async () => await failed.promise)
    .mockImplementationOnce(async (...args) => {
      await release.promise;
      await register(...args);
    });
  const params = request("approval");
  const first = await before(broker, "matching", params);
  const second = await before(broker, "matching", params);
  const resolutions = Promise.allSettled([
    first?.requireApproval?.onResolution?.("allow-once"),
    second?.requireApproval?.onResolution?.("allow-once"),
  ]);
  const tool = createOnePasswordTool(createBroker(), invocation);
  let completed = false;
  const execution = tool.execute("matching", params).then((result) => {
    completed = true;
    return result;
  });
  failed.reject(new Error("synthetic pending write failure"));
  try {
    await before(broker, "unrelated", request("automatic"));
    expect((await pending.entries()).map(({ value }) => value.toolCallId)).toEqual(["unrelated"]);
    expect(completed).toBe(false);
    expect(getItem).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await resolutions;
  }
  expect((await execution).details).toMatchObject({
    ok: false,
    error: { message: "synthetic pending write failure" },
  });
  await expectRows({ toolCallId: "matching", outcome: "error" });
  expect((await tool.execute("matching", { ...params, ...second?.params })).details).toMatchObject({
    ok: true,
    slug: "approval",
  });
  await expectToolError(tool.execute("matching", { ...params, ...first?.params }), unauthorized);
  expect(getItem).toHaveBeenCalledTimes(1);
});

it("reports a settled approval-write failure and audits a later denied execution", async () => {
  const { broker, createBroker, pending, expectRows, getItem } = setup();
  vi.spyOn(pending, "register").mockRejectedValueOnce(new Error("synthetic pending write failure"));
  const approved = await prepareGet(broker, "settled-failure", "approval");
  await expect(approved.hook?.requireApproval?.onResolution?.("allow-once")).rejects.toThrow(
    "synthetic pending write failure",
  );
  await expectToolError(approved.execute(createBroker()), unauthorized);
  await expectRows({ toolCallId: "settled-failure", outcome: "error", errorCode: unauthorized });
  expect(await pending.entries()).toEqual([]);
  expect(getItem).not.toHaveBeenCalled();
});

it("rechecks live policy after awaiting pending consumption", async () => {
  const { broker, pending, getItem, setConfig } = setup();
  const approved = await prepareGet(broker, "revoke", "automatic");
  const consumed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const consume = pending.consume.bind(pending);
  vi.spyOn(pending, "consume").mockImplementationOnce(async (key) => {
    const value = await consume(key);
    consumed.resolve();
    await release.promise;
    return value;
  });
  const execution = approved.execute();
  await consumed.promise;
  setConfig(undefined);
  release.resolve();
  await expectToolError(execution, "POLICY_CHANGED");
  expect(getItem).not.toHaveBeenCalled();
});

it("correlates reused call ids across sessions despite asymmetric execution context", async () => {
  const { broker, expectRows } = setup();
  const first = await prepareGet(broker, "call_x|fc_y", "automatic", "first");
  const other = { agentId: "b", sessionKey: "b", sessionId: "b" };
  const second = await prepareGet(broker, "call_x|fc_y", "automatic", "second", other);
  expect(first.hook?.requireApproval).toBeUndefined();
  await expect(first.get({ agentId: "a", sessionKey: "a" })).resolves.toMatchObject({
    slug: "automatic",
    value: "secret",
  });
  await expect(second.get()).resolves.toMatchObject({ slug: "automatic" });
  await expectRows(
    { reason: "first", sessionKey: "a", outcome: "auto" },
    { reason: "second", sessionKey: "b", outcome: "cache-hit" },
  );
});

it("never grants access from a forged nonce without hook authorization", async () => {
  const { broker } = setup();
  const params = request("automatic");
  const get = (id: string, nonce: string | undefined) => broker.get(id, params, invocation, nonce);
  await expect(get("call-forged", "attacker-nonce")).rejects.toMatchObject({ code: unauthorized });

  // A supplied nonce must not fall back to matching caller identity.
  const result = await before(broker, "call-1", {
    ...params,
    [AUTHORIZATION_NONCE_PARAM]: "attacker-nonce",
  });
  const issuedNonce = nonceOf(result);
  expect(issuedNonce).toBeDefined();
  expect(issuedNonce).not.toBe("attacker-nonce");
  await expect(get("call-1", "attacker-nonce")).rejects.toMatchObject({ code: unauthorized });
  await expect(get("call-1", issuedNonce)).resolves.toMatchObject({ slug: "automatic" });
});

it("fails closed when a dropped nonce is ambiguous across pending entries", async () => {
  const { broker } = setup();
  for (let round = 0; round < 2; round += 1) {
    await before(broker, "ambiguous-1", request("automatic"));
  }
  await expect(
    broker.get("ambiguous-1", request("automatic"), invocation, undefined),
  ).rejects.toMatchObject({ code: unauthorized });
});

it("rejects a different caller replacing a fallback candidate before consumption", async () => {
  const { broker, pending, getItem } = setup();
  const approved = await prepareGet(broker, "replaced", "automatic");
  const nonce = nonceOf(approved.hook);
  assert(nonce, "missing pending nonce");
  const entries = pending.entries.bind(pending);
  vi.spyOn(pending, "entries").mockImplementationOnce(async () => {
    const snapshot = await entries();
    const original = await pending.lookup(nonce);
    assert(original, "missing pending fixture");
    await pending.register(nonce, { ...original, agentId: "other-agent" });
    return snapshot;
  });
  await expectToolError(approved.execute(broker, true), unauthorized);
  expect(getItem).not.toHaveBeenCalled();
});

it.each([false, true])("expires pending authorization (dropped nonce: %s)", async (dropNonce) => {
  const { broker, advance, getItem } = setup();
  const approved = await prepareGet(broker, "expired", "automatic");
  advance(600_000);
  await expectToolError(approved.execute(broker, dropNonce), unauthorized);
  expect(getItem).not.toHaveBeenCalled();
});

it.each([300, 7200])("rechecks grant expiry with cache TTL %s", async (cacheTtlSeconds) => {
  const configured = { ...config(), cacheTtlSeconds, grantTtlHours: 0.1 };
  const { broker, expectAudit, grants, getItem, advance } = setup(configured);
  await grant(broker, "grant-1");
  expect((await grants.entries()).map((entry) => entry.value.agentId)).toEqual(["a"]);

  advance(300_001);
  const second = await prepareGet(broker, "grant-2", "approval");
  expect(second.hook?.requireApproval).toBeUndefined();
  await second.get();
  const reads = cacheTtlSeconds === 300 ? 2 : 1;
  expect(getItem).toHaveBeenCalledTimes(reads);

  const authorized = await prepareGet(broker, "grant-expiring", "approval");
  advance(60_000);
  await expect(authorized.get()).rejects.toMatchObject({ code: "GRANT_EXPIRED" });
  expect(getItem).toHaveBeenCalledTimes(reads);
  const expired = await before(broker, "grant-3", request("approval"));
  expect(expired?.requireApproval).toBeDefined();
  await expectAudit("outcome", ["approved", reads === 2 ? "grant" : "cache-hit", "error"]);
  await expectAudit("errorCode", [undefined, undefined, "GRANT_EXPIRED"]);
});

it.each(["agent", "target"])("does not reuse grants across a changed %s", async (changed) => {
  const configured = config();
  const { broker } = setup(configured);
  await grant(broker, "grant");
  if (changed === "target") {
    configured.items.approval.item = "Replacement target";
  }
  const context = changed === "agent" ? { ...invocation, agentId: "b" } : invocation;
  const hook = await before(broker, "changed", request("approval"), context);
  expect(hook?.requireApproval).toBeDefined();
});

it("does not offer a durable grant without an agent identity", async () => {
  const { broker } = setup();
  const result = await before(broker, "unknown-agent", request("approval"), {});
  expect(result?.requireApproval?.allowedDecisions).toEqual(["allow-once", "deny"]);
});

it.each(["deny", "retarget"])("rechecks cached access after live %s", async (change) => {
  const configured = config();
  const { broker, getItem, setConfig, expectRows } = setup(configured);
  const primed = await prepareGet(broker, "live-target-1", "automatic");
  await primed.get();

  const authorized = await prepareGet(broker, "live-target-2", "automatic");
  const reloaded = structuredClone(configured);
  if (change === "deny") {
    reloaded.items.automatic.policy = "deny";
  } else {
    reloaded.items.automatic.item = "Replacement target";
  }
  setConfig(reloaded);
  await expect(authorized.get()).rejects.toMatchObject({ code: "POLICY_CHANGED" });
  await expectRows({ outcome: "auto" }, { outcome: change === "deny" ? "policy-denied" : "error" });
  expect(getItem).toHaveBeenCalledTimes(1);
  if (change === "retarget") {
    const replacement = await prepareGet(broker, "live-target-3", "automatic");
    await replacement.get();
    expect(getItem).toHaveBeenCalledTimes(2);
    expect(getItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ item: "Replacement target" }),
    );
  }
});

it("prunes grants for removed slugs before persisting a replacement", async () => {
  const { broker, grants } = setup();
  for (const slug of ["removed-a", "removed-b"]) {
    await grants.register(slug, {
      agentId: "agent-a",
      slug,
      grantedAtMs: 900,
      expiresAtMs: 10_000,
      targetFingerprint: "removed-target",
    });
  }
  await grant(broker, "grant-prune-1");
  expect((await grants.entries()).map((entry) => entry.value.slug)).toEqual(["approval"]);
});
