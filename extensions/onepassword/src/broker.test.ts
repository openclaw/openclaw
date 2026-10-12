import type { PluginHookBeforeToolCallResult } from "openclaw/plugin-sdk/types";
import { describe, expect, it, vi } from "vitest";
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

function config(): OnePasswordConfig {
  return {
    vault: "Automation",
    defaultPolicy: "approve",
    cacheTtlSeconds: 300,
    grantTtlHours: 1,
    opTimeoutMs: 15_000,
    items: {
      automatic: {
        item: "Automatic",
        vault: "Automation",
        field: "credential",
        policy: "auto",
        description: "Automatic item",
      },
      approval: {
        item: "Approval",
        vault: "Automation",
        field: "credential",
        policy: "approve",
      },
      blocked: {
        item: "Blocked",
        vault: "Automation",
        field: "credential",
        policy: "deny",
      },
    },
  };
}

function configuredItem(configured: OnePasswordConfig, slug: string): OnePasswordItemConfig {
  const item = configured.items[slug];
  if (!item) {
    throw new Error(`Missing test config item: ${slug}`);
  }
  return item;
}

function setup(nowValue = 1_000, configured = config()) {
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

async function before(
  broker: OnePasswordBroker,
  toolCallId: string,
  params: Record<string, unknown>,
): Promise<PluginHookBeforeToolCallResult | void> {
  return broker.beforeToolCall(
    { toolName: "onepassword", params, toolCallId },
    { toolName: "onepassword", toolCallId, ...invocation },
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
  reason: string,
) {
  const input = { action: "get", slug, reason } satisfies Parameters<OnePasswordBroker["get"]>[1];
  const hook = await before(broker, toolCallId, input);
  return { hook, get: () => broker.get(toolCallId, input, invocation, nonceOf(hook)) };
}

describe("OnePasswordBroker validation and policy", () => {
  it("lists only registry metadata and active grant state", async () => {
    const { broker, getItem } = setup();
    const approval = await prepareGet(broker, "list-grant", "approval", "create listing fixture");
    await approval.hook?.requireApproval?.onResolution?.("allow-always");
    await approval.get();
    getItem.mockClear();

    const items = await broker.list(invocation);
    expect(items).toEqual([
      {
        slug: "approval",
        description: "",
        policy: "approve",
        standingGrantActive: true,
      },
      {
        slug: "automatic",
        description: "Automatic item",
        policy: "auto",
        standingGrantActive: false,
      },
      {
        slug: "blocked",
        description: "",
        policy: "deny",
        standingGrantActive: false,
      },
    ]);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("requires a non-empty bounded reason before policy evaluation", async () => {
    const { broker, audit, getItem } = setup();
    const missing = await before(broker, "call-1", { action: "get", slug: "blocked" });
    const empty = await before(broker, "call-2", {
      action: "get",
      slug: "blocked",
      reason: "   ",
    });
    const long = await before(broker, "call-3", {
      action: "get",
      slug: "blocked",
      reason: "x".repeat(301),
    });
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
    expect(
      await before(broker, "call-1", { action: "get", slug: "Bad", reason: "test" }),
    ).toMatchObject({ block: true });
    expect(
      await before(broker, "call-2", { action: "get", slug: "unknown", reason: "test" }),
    ).toMatchObject({ block: true });
    expect(
      await before(broker, "call-3", { action: "get", slug: "constructor", reason: "test" }),
    ).toMatchObject({ block: true });
    expect((await audit.entries()).map((entry) => entry.value.errorCode)).toEqual([
      "INVALID_SLUG",
      "UNKNOWN_SLUG",
      "UNKNOWN_SLUG",
    ]);
  });

  it("allows auto, blocks deny, and audits one row per attempt", async () => {
    const { broker, audit, getItem } = setup();
    const automatic = await prepareGet(broker, "auto-1", "automatic", "test");
    expect(automatic.hook?.requireApproval).toBeUndefined();
    await expect(automatic.get()).resolves.toMatchObject({ value: ["fixture", "value"].join("-") });
    expect(
      await before(broker, "deny-1", { action: "get", slug: "blocked", reason: "test" }),
    ).toMatchObject({ block: true });
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

    const denied = await before(broker, "approve-2", {
      action: "get",
      slug: "approval",
      reason: "deny",
    });
    await denied?.requireApproval?.onResolution?.("deny");
    const timedOut = await before(broker, "approve-3", {
      action: "get",
      slug: "approval",
      reason: "timeout",
    });
    await timedOut?.requireApproval?.onResolution?.("timeout");

    const cancelled = await before(broker, "approve-4", {
      action: "get",
      slug: "approval",
      reason: "cancel",
    });
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
    // Production regression: the hook's PluginHookToolContext and the tool
    // execute invocation context are sourced independently by core and can
    // carry different session fields for the same call. Correlation is
    // nonce-based so those differences cannot cause POLICY_NOT_EVALUATED.
    const { broker, audit } = setup();
    const result = await broker.beforeToolCall(
      {
        toolName: "onepassword",
        params: { action: "get", slug: "automatic", reason: "asymmetric contexts" },
        toolCallId: "call_x|fc_y",
      },
      {
        toolName: "onepassword",
        toolCallId: "call_x|fc_y",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "hook-run-uuid",
      },
    );
    await expect(
      broker.get(
        "call_x|fc_y",
        { action: "get", slug: "automatic", reason: "asymmetric contexts" },
        { agentId: "main", sessionKey: "agent:main:main" },
        nonceOf(result),
      ),
    ).resolves.toMatchObject({ slug: "automatic" });
    const rows = await audit.entries();
    expect(rows.map((entry) => entry.value.outcome)).toEqual(["auto"]);
  });

  it("shares pending authorizations across broker instances", async () => {
    const { broker: hookBroker, createBroker } = setup();
    const executeBroker = createBroker();
    const issued = await before(hookBroker, "duplicate-instance-1", {
      action: "get",
      slug: "automatic",
      reason: "cross-instance authorization",
    });

    await expect(
      executeBroker.get(
        "duplicate-instance-1",
        { action: "get", slug: "automatic", reason: "cross-instance authorization" },
        invocation,
        nonceOf(issued),
      ),
    ).resolves.toMatchObject({ slug: "automatic" });
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
      const params = { action: "get", slug: "approval", reason: "delayed approval" };
      const approved = await before(broker, "delayed", params);
      const resolution = approved?.requireApproval?.onResolution?.("allow-once");
      const tool = createOnePasswordTool(createBroker(), invocation);
      const executedParams = dropNonce ? params : { ...params, ...approved?.params };
      const results = Promise.all([
        tool.execute("delayed", executedParams),
        tool.execute("delayed", executedParams),
      ]);
      try {
        await before(broker, "unrelated", {
          action: "get",
          slug: "automatic",
          reason: "independent authorization still progresses",
        });
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
    const params = { action: "get", slug: "approval", reason: "matching approvals" };
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
      await before(broker, "unrelated", {
        action: "get",
        slug: "automatic",
        reason: "independent work",
      });
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
    expect(
      (await tool.execute("matching", { ...params, ...second?.params })).details,
    ).toMatchObject({
      ok: true,
      slug: "approval",
    });
    expect((await tool.execute("matching", { ...params, ...first?.params })).details).toMatchObject(
      {
        ok: false,
        error: { code: "POLICY_NOT_EVALUATED" },
      },
    );
    expect(getItem).toHaveBeenCalledTimes(1);
  });

  it("reports a settled approval-write failure and audits a later denied execution", async () => {
    const { broker, createBroker, pending, audit, getItem } = setup();
    vi.spyOn(pending, "register").mockRejectedValueOnce(
      new Error("synthetic pending write failure"),
    );
    const params = { action: "get", slug: "approval", reason: "failed before execution" };
    const approved = await before(broker, "settled-failure", params);
    await expect(approved?.requireApproval?.onResolution?.("allow-once")).rejects.toThrow(
      "synthetic pending write failure",
    );
    const result = await createOnePasswordTool(createBroker(), invocation).execute(
      "settled-failure",
      { ...params, ...approved?.params },
    );
    expect(result.details).toMatchObject({
      ok: false,
      error: { code: "POLICY_NOT_EVALUATED" },
    });
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
    const params = { action: "get", slug: "automatic", reason: "revoke while consuming" };
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
    expect((await execution).details).toMatchObject({
      ok: false,
      error: { code: "POLICY_CHANGED" },
    });
    expect(getItem).not.toHaveBeenCalled();
  });

  it("isolates concurrent sessions that reuse a provider tool call id", async () => {
    const { broker, audit } = setup();
    const firstInvocation = {
      agentId: "agent-a",
      sessionKey: "session-a",
      sessionId: "conversation-a",
    };
    const secondInvocation = {
      agentId: "agent-b",
      sessionKey: "session-b",
      sessionId: "conversation-b",
    };
    const first = await broker.beforeToolCall(
      {
        toolName: "onepassword",
        toolCallId: "call-1",
        params: { action: "get", slug: "automatic", reason: "first session" },
      },
      { toolName: "onepassword", toolCallId: "call-1", ...firstInvocation },
    );
    const second = await broker.beforeToolCall(
      {
        toolName: "onepassword",
        toolCallId: "call-1",
        params: { action: "get", slug: "automatic", reason: "second session" },
      },
      { toolName: "onepassword", toolCallId: "call-1", ...secondInvocation },
    );

    await expect(
      broker.get(
        "call-1",
        { action: "get", slug: "automatic", reason: "first session" },
        firstInvocation,
        nonceOf(first),
      ),
    ).resolves.toMatchObject({ slug: "automatic" });
    await expect(
      broker.get(
        "call-1",
        { action: "get", slug: "automatic", reason: "second session" },
        secondInvocation,
        nonceOf(second),
      ),
    ).resolves.toMatchObject({ slug: "automatic" });
    expect(
      (await audit.entries())
        .map((entry) => ({
          reason: entry.value.reason,
          sessionKey: entry.value.sessionKey,
        }))
        .toSorted((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
    ).toEqual([
      { reason: "first session", sessionKey: "session-a" },
      { reason: "second session", sessionKey: "session-b" },
    ]);
  });

  it("never grants access from a forged nonce without hook authorization", async () => {
    const { broker } = setup();
    // No before_tool_call ran for this call: a fabricated nonce finds nothing
    // and the identity fallback has no pending entry to match.
    await expect(
      broker.get(
        "call-forged",
        { action: "get", slug: "automatic", reason: "reject forged correlation" },
        invocation,
        "attacker-nonce",
      ),
    ).rejects.toMatchObject({ code: "POLICY_NOT_EVALUATED" });

    // The hook always overwrites a model-supplied nonce with its own, and a
    // present-but-unknown nonce never falls back to the identity match.
    const result = await before(broker, "call-1", {
      action: "get",
      slug: "automatic",
      reason: "reject forged correlation",
      [AUTHORIZATION_NONCE_PARAM]: "attacker-nonce",
    });
    const issuedNonce = nonceOf(result);
    expect(issuedNonce).toBeDefined();
    expect(issuedNonce).not.toBe("attacker-nonce");
    await expect(
      broker.get(
        "call-1",
        { action: "get", slug: "automatic", reason: "reject forged correlation" },
        invocation,
        "attacker-nonce",
      ),
    ).rejects.toMatchObject({ code: "POLICY_NOT_EVALUATED" });
    await expect(
      broker.get(
        "call-1",
        { action: "get", slug: "automatic", reason: "reject forged correlation" },
        invocation,
        issuedNonce,
      ),
    ).resolves.toMatchObject({ slug: "automatic" });
  });

  it("authorizes via unique pending match when another hook drops the nonce param", async () => {
    // before_tool_call results merge last-writer-wins across plugins, so a
    // later params-returning hook can strip the nonce from the executed params.
    const { broker } = setup();
    await before(broker, "dropped-1", {
      action: "get",
      slug: "automatic",
      reason: "nonce dropped by another hook",
    });
    await expect(
      broker.get(
        "dropped-1",
        { action: "get", slug: "automatic", reason: "nonce dropped by another hook" },
        invocation,
        undefined,
      ),
    ).resolves.toMatchObject({ slug: "automatic" });
  });

  it("fails closed when a dropped nonce is ambiguous across pending entries", async () => {
    const { broker } = setup();
    for (let round = 0; round < 2; round += 1) {
      await before(broker, "ambiguous-1", {
        action: "get",
        slug: "automatic",
        reason: "same identity twice",
      });
    }
    await expect(
      broker.get(
        "ambiguous-1",
        { action: "get", slug: "automatic", reason: "same identity twice" },
        invocation,
        undefined,
      ),
    ).rejects.toMatchObject({ code: "POLICY_NOT_EVALUATED" });
  });

  it("rejects a different caller replacing a fallback candidate before consumption", async () => {
    const { broker, pending, getItem } = setup();
    const params = { action: "get", slug: "automatic", reason: "fallback replacement" };
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
    expect(
      (await createOnePasswordTool(broker, invocation).execute("replaced", params)).details,
    ).toMatchObject({
      ok: false,
      error: { code: "POLICY_NOT_EVALUATED" },
    });
    expect(getItem).not.toHaveBeenCalled();
  });

  it.each([false, true])("expires pending authorization (dropped nonce: %s)", async (dropNonce) => {
    const { broker, advance, getItem } = setup();
    const params = { action: "get", slug: "automatic", reason: "expired pending" };
    const approved = await before(broker, "expired", params);
    advance(600_000);
    const executedParams = dropNonce ? params : { ...params, ...approved?.params };
    expect(
      (await createOnePasswordTool(broker, invocation).execute("expired", executedParams)).details,
    ).toMatchObject({
      ok: false,
      error: { code: "POLICY_NOT_EVALUATED" },
    });
    expect(getItem).not.toHaveBeenCalled();
  });

  it("persists allow-always grants and expires them", async () => {
    const { broker, audit, grants, getItem, advance } = setup();
    const first = await prepareGet(broker, "grant-1", "approval", "standing access");
    await first.hook?.requireApproval?.onResolution?.("allow-always");
    await first.get();
    expect((await grants.entries()).map((entry) => entry.value.agentId)).toEqual(["agent-a"]);

    advance(300_001);
    const second = await prepareGet(broker, "grant-2", "approval", "second access");
    expect(second.hook?.requireApproval).toBeUndefined();
    await second.get();
    expect(getItem).toHaveBeenCalledTimes(2);

    advance(60 * 60 * 1000 + 1);
    const expired = await before(broker, "grant-3", {
      action: "get",
      slug: "approval",
      reason: "expired access",
    });
    expect(expired?.requireApproval).toBeDefined();
    expect((await audit.entries()).map((entry) => entry.value.outcome)).toEqual([
      "approved",
      "grant",
    ]);
  });

  it("scopes standing grants and list state to the approved agent", async () => {
    const { broker } = setup();
    const approved = await prepareGet(broker, "agent-grant-1", "approval", "agent a access");
    await approved.hook?.requireApproval?.onResolution?.("allow-always");
    await approved.get();

    const otherAgent = {
      agentId: "agent-b",
      sessionKey: "session-b",
      sessionId: "conversation-b",
    };
    const otherRequest = await broker.beforeToolCall(
      {
        toolName: "onepassword",
        toolCallId: "agent-grant-2",
        params: { action: "get", slug: "approval", reason: "agent b access" },
      },
      { toolName: "onepassword", toolCallId: "agent-grant-2", ...otherAgent },
    );
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
      {
        toolName: "onepassword",
        toolCallId: "unknown-agent",
        params: { action: "get", slug: "approval", reason: "one call only" },
      },
      { toolName: "onepassword", toolCallId: "unknown-agent" },
    );
    expect(result?.requireApproval?.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("invalidates a standing grant when its configured target changes", async () => {
    const configured = config();
    const { broker } = setup(1_000, configured);
    const first = await prepareGet(broker, "grant-remap-1", "approval", "approve original target");
    await first.hook?.requireApproval?.onResolution?.("allow-always");
    await first.get();

    configuredItem(configured, "approval").item = "Replacement target";
    const remapped = await before(broker, "grant-remap-2", {
      action: "get",
      slug: "approval",
      reason: "request remapped target",
    });
    expect(remapped?.requireApproval).toBeDefined();
  });

  it("fails closed when live policy changes after authorization", async () => {
    const configured = config();
    const { broker, audit, getItem, setConfig } = setup(1_000, configured);
    const authorized = await prepareGet(
      broker,
      "live-deny-1",
      "automatic",
      "authorized before reload",
    );
    const reloaded = structuredClone(configured);
    configuredItem(reloaded, "automatic").policy = "deny";
    setConfig(reloaded);

    await expect(authorized.get()).rejects.toMatchObject({ code: "POLICY_CHANGED" });
    expect(getItem).not.toHaveBeenCalled();
    expect((await audit.entries()).at(-1)?.value).toMatchObject({
      outcome: "policy-denied",
    });
  });

  it("rejects a retargeted authorization and never reuses its cached value", async () => {
    const configured = config();
    const { broker, getItem, setConfig } = setup(1_000, configured);
    const primed = await prepareGet(broker, "live-target-1", "automatic", "prime original target");
    await primed.get();

    const authorized = await prepareGet(
      broker,
      "live-target-2",
      "automatic",
      "authorized before retarget",
    );
    const reloaded = structuredClone(configured);
    configuredItem(reloaded, "automatic").item = "Replacement target";
    setConfig(reloaded);
    await expect(authorized.get()).rejects.toMatchObject({ code: "POLICY_CHANGED" });

    const replacement = await prepareGet(
      broker,
      "live-target-3",
      "automatic",
      "authorize replacement target",
    );
    await replacement.get();
    expect(getItem).toHaveBeenCalledTimes(2);
    expect(getItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ item: "Replacement target" }),
    );
  });

  it("blocks access after live plugin config removal", async () => {
    const { broker, audit, getItem, setConfig } = setup();
    setConfig(undefined);
    await expect(
      before(broker, "live-remove-1", {
        action: "get",
        slug: "automatic",
        reason: "after removal",
      }),
    ).resolves.toMatchObject({ block: true });
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
    const approval = await prepareGet(
      broker,
      "grant-prune-1",
      "approval",
      "replace removed grants",
    );
    await approval.hook?.requireApproval?.onResolution?.("allow-always");
    await approval.get();
    expect((await grants.entries()).map((entry) => entry.value.slug)).toEqual(["approval"]);
  });

  it("rechecks a standing grant before serving a cached value", async () => {
    const configured = config();
    configured.grantTtlHours = 0.001;
    const { broker, audit, getItem, advance } = setup(1_000, configured);
    const first = await prepareGet(broker, "grant-cache-1", "approval", "create grant");
    await first.hook?.requireApproval?.onResolution?.("allow-always");
    await first.get();

    const second = await prepareGet(broker, "grant-cache-2", "approval", "use grant");
    expect(second.hook?.requireApproval).toBeUndefined();
    advance(3_601);
    await expect(second.get()).rejects.toMatchObject({ code: "GRANT_EXPIRED" });
    expect(getItem).toHaveBeenCalledTimes(1);
    expect((await audit.entries()).at(-1)?.value).toMatchObject({
      outcome: "error",
      errorCode: "GRANT_EXPIRED",
    });
  });
});

describe("OnePasswordBroker cache and audit", () => {
  it("honors cache TTL, audits hits, and refetches after expiry", async () => {
    const { broker, audit, getItem, advance } = setup();
    for (const [id, reason] of [
      ["cache-1", "first"],
      ["cache-2", "second"],
    ] as const) {
      const request = await prepareGet(broker, id, "automatic", reason);
      await request.get();
    }
    expect(getItem).toHaveBeenCalledTimes(1);
    advance(300_001);
    const third = await prepareGet(broker, "cache-3", "automatic", "third");
    await third.get();
    expect(getItem).toHaveBeenCalledTimes(2);
    expect((await audit.entries()).map((entry) => entry.value.outcome)).toEqual([
      "auto",
      "cache-hit",
      "auto",
    ]);
  });
});
