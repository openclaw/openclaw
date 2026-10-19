import type {
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/types";
import { expect, it, vi } from "vitest";
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

const invocation = {
  agentId: "agent-a",
  sessionKey: "session-a",
  sessionId: "conversation-a",
} as const;

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

function setup(nowValue = 1_000, configured: OnePasswordConfig = config()) {
  let now = nowValue;
  let currentConfig: OnePasswordConfig | undefined = configured;
  const audit = new MemoryKeyedStore<AuditRow>(() => now);
  const grants = new MemoryKeyedStore<StandingGrant>(() => now);
  const pending = new MemoryKeyedStore<PendingAuthorization>(() => now);
  const stores = { audit, grants, pending };
  const getItem = vi.fn(async () => ({
    value: ["fixture", "value"].join("-"),
    itemTitle: "Item title",
    fieldLabel: "credential",
  }));
  const createBroker = () =>
    new OnePasswordBroker({
      resolveConfig: () => currentConfig,
      opClient: { getItem },
      stores,
      now: () => now,
    });
  const broker = createBroker();
  return {
    broker,
    createBroker,
    audit,
    grants,
    pending,
    getItem,
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
  return { hook, get: (caller = context) => broker.get(toolCallId, input, caller, nonceOf(hook)) };
}

async function grant(broker: OnePasswordBroker, id: string) {
  const access = await prepareGet(broker, id, "approval");
  await access.hook?.requireApproval?.onResolution?.("allow-always");
  await access.get();
}

function expectToolError(result: { details?: unknown }, code: string) {
  expect(result.details).toMatchObject({ ok: false, error: { code } });
}

it("requires a non-empty bounded reason before policy evaluation", async () => {
  const { broker, audit, getItem } = setup();
  const missing = await before(broker, "call-1", { action: "get", slug: "blocked" });
  const empty = await before(broker, "call-2", request("blocked", "   "));
  const long = await before(broker, "call-3", request("blocked", "x".repeat(301)));
  expect(missing).toMatchObject({ block: true });
  expect(empty).toMatchObject({ block: true });
  expect(long).toMatchObject({ block: true });
  expect(getItem).not.toHaveBeenCalled();
  expect((await audit.entries()).map((entry) => entry.value.errorCode)).toEqual([
    "INVALID_REASON",
    "INVALID_REASON",
    "INVALID_REASON",
  ]);
});

it("rejects invalid and unknown slugs", async () => {
  const { broker, audit } = setup();
  expect(await before(broker, "call-1", request("Bad"))).toMatchObject({ block: true });
  expect(await before(broker, "call-2", request("unknown"))).toMatchObject({ block: true });
  expect(await before(broker, "call-3", request("constructor"))).toMatchObject({ block: true });
  expect((await audit.entries()).map((entry) => entry.value.errorCode)).toEqual([
    "INVALID_SLUG",
    "UNKNOWN_SLUG",
    "UNKNOWN_SLUG",
  ]);
});

it("allows auto, blocks deny, and audits one row per attempt", async () => {
  const { broker, audit, getItem } = setup();
  const automatic = await prepareGet(broker, "auto-1", "automatic");
  expect(automatic.hook?.requireApproval).toBeUndefined();
  await expect(automatic.get()).resolves.toMatchObject({ value: ["fixture", "value"].join("-") });
  expect(await before(broker, "deny-1", request("blocked"))).toMatchObject({ block: true });
  expect(getItem).toHaveBeenCalledTimes(1);
  expect((await audit.entries()).map((entry) => entry.value.outcome)).toEqual([
    "auto",
    "policy-denied",
  ]);
});

it("handles allow-once, deny, timeout, and cancellation decisions", async () => {
  const { broker, audit, pending, getItem } = setup();
  const approved = await prepareGet(broker, "approve-1", "approval", "one use");
  expect(approved.hook?.requireApproval).toMatchObject({
    title: "1Password: approval",
    description: "Agent agent-a requests approval. Reason: one use",
    severity: "warning",
    timeoutMs: 600_000,
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  });
  await approved.hook?.requireApproval?.onResolution?.("allow-once");
  await approved.get();

  const denied = await before(broker, "approve-2", request("approval"));
  await denied?.requireApproval?.onResolution?.("deny");
  const timedOut = await before(broker, "approve-3", request("approval"));
  await timedOut?.requireApproval?.onResolution?.("timeout");

  const cancelled = await before(broker, "approve-4", request("approval"));
  await cancelled?.requireApproval?.onResolution?.("cancelled");

  expect(getItem).toHaveBeenCalledTimes(1);
  expect(await pending.entries()).toEqual([]);
  expect((await audit.entries()).map((entry) => entry.value.outcome)).toEqual([
    "approved",
    "denied",
    "timeout",
    "error",
  ]);
});

it("authorizes when hook and execute contexts disagree on session fields", async () => {
  // Core can supply different session fields to the hook and execution.
  const { broker, audit } = setup();
  const prepared = await prepareGet(broker, "call_x|fc_y", "automatic", "asymmetric contexts", {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "hook-run-uuid",
  });
  await expect(
    prepared.get({ agentId: "main", sessionKey: "agent:main:main" }),
  ).resolves.toMatchObject({ slug: "automatic" });
  const rows = await audit.entries();
  expect(rows.map((entry) => entry.value.outcome)).toEqual(["auto"]);
});

it.each([false, true])(
  "joins approval writes across brokers and consumes once (dropped nonce: %s)",
  async (dropNonce) => {
    const { broker, createBroker, pending, getItem } = setup();
    const release = Promise.withResolvers<void>();
    const register = pending.register.bind(pending);
    vi.spyOn(pending, "register").mockImplementationOnce(async (...args) => {
      await release.promise;
      await register(...args);
    });
    const params = request("approval");
    const approved = await before(broker, "delayed", params);
    const resolution = approved?.requireApproval?.onResolution?.("allow-once");
    const tool = createOnePasswordTool(createBroker(), invocation);
    const executedParams = dropNonce ? params : { ...params, ...approved?.params };
    const results = Promise.all([
      tool.execute("delayed", executedParams),
      tool.execute("delayed", executedParams),
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
          error: expect.objectContaining({ code: "POLICY_NOT_EVALUATED" }),
        }),
      ]),
    );
    expect(getItem).toHaveBeenCalledTimes(1);
  },
);

it("settles matching writes after a failure without retaining failed authorization", async () => {
  const { broker, createBroker, pending, audit, getItem } = setup();
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
  expect((await audit.entries()).map(({ value }) => [value.toolCallId, value.outcome])).toEqual([
    ["matching", "error"],
  ]);
  expect((await tool.execute("matching", { ...params, ...second?.params })).details).toMatchObject({
    ok: true,
    slug: "approval",
  });
  expectToolError(
    await tool.execute("matching", { ...params, ...first?.params }),
    "POLICY_NOT_EVALUATED",
  );
  expect(getItem).toHaveBeenCalledTimes(1);
});

it("reports a settled approval-write failure and audits a later denied execution", async () => {
  const { broker, createBroker, pending, audit, getItem } = setup();
  vi.spyOn(pending, "register").mockRejectedValueOnce(new Error("synthetic pending write failure"));
  const params = request("approval");
  const approved = await before(broker, "settled-failure", params);
  await expect(approved?.requireApproval?.onResolution?.("allow-once")).rejects.toThrow(
    "synthetic pending write failure",
  );
  const result = await createOnePasswordTool(createBroker(), invocation).execute(
    "settled-failure",
    { ...params, ...approved?.params },
  );
  expectToolError(result, "POLICY_NOT_EVALUATED");
  expect((await audit.entries()).map(({ value }) => value)).toEqual([
    expect.objectContaining({
      toolCallId: "settled-failure",
      outcome: "error",
      errorCode: "POLICY_NOT_EVALUATED",
    }),
  ]);
  expect(await pending.entries()).toEqual([]);
  expect(getItem).not.toHaveBeenCalled();
});

it("rechecks live policy after awaiting pending consumption", async () => {
  const { broker, pending, getItem, setConfig } = setup();
  const params = request("automatic");
  const approved = await before(broker, "revoke", params);
  const consumed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const consume = pending.consume.bind(pending);
  vi.spyOn(pending, "consume").mockImplementationOnce(async (key) => {
    const value = await consume(key);
    consumed.resolve();
    await release.promise;
    return value;
  });
  const execution = createOnePasswordTool(broker, invocation).execute("revoke", {
    ...params,
    ...approved?.params,
  });
  await consumed.promise;
  setConfig(undefined);
  release.resolve();
  expectToolError(await execution, "POLICY_CHANGED");
  expect(getItem).not.toHaveBeenCalled();
});

it("isolates concurrent sessions that reuse a provider tool call id", async () => {
  const { broker, audit } = setup();
  const firstInvocation = invocation;
  const secondInvocation = {
    agentId: "agent-b",
    sessionKey: "session-b",
    sessionId: "conversation-b",
  };
  const first = await prepareGet(broker, "call-1", "automatic", "first session", firstInvocation);
  const second = await prepareGet(
    broker,
    "call-1",
    "automatic",
    "second session",
    secondInvocation,
  );
  await expect(first.get()).resolves.toMatchObject({ slug: "automatic" });
  await expect(second.get()).resolves.toMatchObject({ slug: "automatic" });
  expect(
    (await audit.entries())
      .map((entry) => ({ reason: entry.value.reason, sessionKey: entry.value.sessionKey }))
      .toSorted((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
  ).toEqual([
    { reason: "first session", sessionKey: "session-a" },
    { reason: "second session", sessionKey: "session-b" },
  ]);
});

it("never grants access from a forged nonce without hook authorization", async () => {
  const { broker } = setup();
  const params = request("automatic");
  const get = (id: string, nonce: string | undefined) => broker.get(id, params, invocation, nonce);
  await expect(get("call-forged", "attacker-nonce")).rejects.toMatchObject({
    code: "POLICY_NOT_EVALUATED",
  });

  // A supplied nonce must not fall back to matching caller identity.
  const result = await before(broker, "call-1", {
    ...params,
    [AUTHORIZATION_NONCE_PARAM]: "attacker-nonce",
  });
  const issuedNonce = nonceOf(result);
  expect(issuedNonce).toBeDefined();
  expect(issuedNonce).not.toBe("attacker-nonce");
  await expect(get("call-1", "attacker-nonce")).rejects.toMatchObject({
    code: "POLICY_NOT_EVALUATED",
  });
  await expect(get("call-1", issuedNonce)).resolves.toMatchObject({ slug: "automatic" });
});

it("fails closed when a dropped nonce is ambiguous across pending entries", async () => {
  const { broker } = setup();
  for (let round = 0; round < 2; round += 1) {
    await before(broker, "ambiguous-1", request("automatic"));
  }
  await expect(
    broker.get("ambiguous-1", request("automatic"), invocation, undefined),
  ).rejects.toMatchObject({ code: "POLICY_NOT_EVALUATED" });
});

it("rejects a different caller replacing a fallback candidate before consumption", async () => {
  const { broker, pending, getItem } = setup();
  const params = request("automatic");
  const approved = await before(broker, "replaced", params);
  const nonce = nonceOf(approved);
  if (!nonce) {
    throw new Error("missing pending nonce");
  }
  const entries = pending.entries.bind(pending);
  vi.spyOn(pending, "entries").mockImplementationOnce(async () => {
    const snapshot = await entries();
    const original = await pending.lookup(nonce);
    if (!original) {
      throw new Error("missing pending fixture");
    }
    await pending.register(nonce, { ...original, agentId: "other-agent" });
    return snapshot;
  });
  expectToolError(
    await createOnePasswordTool(broker, invocation).execute("replaced", params),
    "POLICY_NOT_EVALUATED",
  );
  expect(getItem).not.toHaveBeenCalled();
});

it.each([false, true])("expires pending authorization (dropped nonce: %s)", async (dropNonce) => {
  const { broker, advance, getItem } = setup();
  const params = request("automatic");
  const approved = await before(broker, "expired", params);
  advance(600_000);
  const executedParams = dropNonce ? params : { ...params, ...approved?.params };
  expectToolError(
    await createOnePasswordTool(broker, invocation).execute("expired", executedParams),
    "POLICY_NOT_EVALUATED",
  );
  expect(getItem).not.toHaveBeenCalled();
});

it("persists allow-always grants and expires them", async () => {
  const { broker, audit, grants, getItem, advance } = setup();
  await grant(broker, "grant-1");
  expect((await grants.entries()).map((entry) => entry.value.agentId)).toEqual(["agent-a"]);

  advance(300_001);
  const second = await prepareGet(broker, "grant-2", "approval");
  expect(second.hook?.requireApproval).toBeUndefined();
  await second.get();
  expect(getItem).toHaveBeenCalledTimes(2);

  advance(60 * 60 * 1000 + 1);
  const expired = await before(broker, "grant-3", request("approval"));
  expect(expired?.requireApproval).toBeDefined();
  expect((await audit.entries()).map((entry) => entry.value.outcome)).toEqual([
    "approved",
    "grant",
  ]);
});

it("scopes standing grants and list state to the approved agent", async () => {
  const { broker } = setup();
  await grant(broker, "agent-grant-1");

  const otherAgent = { agentId: "agent-b", sessionKey: "session-b", sessionId: "conversation-b" };
  const otherRequest = await before(broker, "agent-grant-2", request("approval"), otherAgent);
  expect(otherRequest?.requireApproval).toBeDefined();
  expect((await broker.list(invocation)).find((item) => item.slug === "approval")).toMatchObject({
    standingGrantActive: true,
  });
  expect((await broker.list(otherAgent)).find((item) => item.slug === "approval")).toMatchObject({
    standingGrantActive: false,
  });
});

it("does not offer a durable grant without an agent identity", async () => {
  const { broker } = setup();
  const result = await broker.beforeToolCall(
    { toolName: "onepassword", toolCallId: "unknown-agent", params: request("approval") },
    { toolName: "onepassword", toolCallId: "unknown-agent" },
  );
  expect(result?.requireApproval?.allowedDecisions).toEqual(["allow-once", "deny"]);
});

it("invalidates a standing grant when its configured target changes", async () => {
  const configured = config();
  const { broker } = setup(1_000, configured);
  await grant(broker, "grant-remap-1");

  configured.items.approval.item = "Replacement target";
  const remapped = await before(broker, "grant-remap-2", request("approval"));
  expect(remapped?.requireApproval).toBeDefined();
});

it("fails closed when live policy changes after authorization", async () => {
  const configured = config();
  const { broker, audit, getItem, setConfig } = setup(1_000, configured);
  const authorized = await prepareGet(broker, "live-deny-1", "automatic");
  const reloaded = structuredClone(configured);
  reloaded.items.automatic.policy = "deny";
  setConfig(reloaded);

  await expect(authorized.get()).rejects.toMatchObject({ code: "POLICY_CHANGED" });
  expect(getItem).not.toHaveBeenCalled();
  expect((await audit.entries()).at(-1)?.value).toMatchObject({ outcome: "policy-denied" });
});

it("rejects a retargeted authorization and never reuses its cached value", async () => {
  const configured = config();
  const { broker, getItem, setConfig } = setup(1_000, configured);
  const primed = await prepareGet(broker, "live-target-1", "automatic");
  await primed.get();

  const authorized = await prepareGet(broker, "live-target-2", "automatic");
  const reloaded = structuredClone(configured);
  reloaded.items.automatic.item = "Replacement target";
  setConfig(reloaded);
  await expect(authorized.get()).rejects.toMatchObject({ code: "POLICY_CHANGED" });

  const replacement = await prepareGet(broker, "live-target-3", "automatic");
  await replacement.get();
  expect(getItem).toHaveBeenCalledTimes(2);
  expect(getItem).toHaveBeenLastCalledWith(expect.objectContaining({ item: "Replacement target" }));
});

it("blocks access after live plugin config removal", async () => {
  const { broker, audit, getItem, setConfig } = setup();
  setConfig(undefined);
  await expect(before(broker, "live-remove-1", request("automatic"))).resolves.toMatchObject({
    block: true,
  });
  expect(getItem).not.toHaveBeenCalled();
  expect((await audit.entries()).at(-1)?.value).toMatchObject({
    outcome: "error",
    errorCode: "POLICY_CHANGED",
  });
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

it("rechecks a standing grant before serving a cached value", async () => {
  const configured = config();
  configured.grantTtlHours = 0.001;
  const { broker, audit, getItem, advance } = setup(1_000, configured);
  await grant(broker, "grant-cache-1");

  const second = await prepareGet(broker, "grant-cache-2", "approval");
  expect(second.hook?.requireApproval).toBeUndefined();
  advance(3_601);
  await expect(second.get()).rejects.toMatchObject({ code: "GRANT_EXPIRED" });
  expect(getItem).toHaveBeenCalledTimes(1);
  expect((await audit.entries()).at(-1)?.value).toMatchObject({
    outcome: "error",
    errorCode: "GRANT_EXPIRED",
  });
});
