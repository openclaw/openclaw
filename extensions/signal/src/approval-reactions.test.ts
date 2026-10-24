import { addApprovalReactionHintToText } from "openclaw/plugin-sdk/approval-reaction-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSignalApprovalReactionHintToStructuredPayload,
  maybeResolveSignalApprovalReaction,
  registerSignalApprovalReactionTargetForDeliveredPayload,
  registerSignalApprovalReactionTarget,
  resolveSignalApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import * as signalRuntime from "./runtime.js";

const reactionStores = vi.hoisted(() => new Set<{ clearForTest(): void }>());

vi.mock("openclaw/plugin-sdk/approval-reaction-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/approval-reaction-runtime")>();
  return {
    ...actual,
    createApprovalReactionTargetStore: <TTarget>(
      params: Parameters<typeof actual.createApprovalReactionTargetStore<TTarget>>[0],
    ) => {
      const store = actual.createApprovalReactionTargetStore<TTarget>(params);
      if (params.namespace === "signal.approval-reactions.v2") {
        reactionStores.add(store);
      }
      return store;
    },
  };
});

const resolverMocks = vi.hoisted(() => ({
  resolveSignalApproval: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolverMocks.resolveSignalApproval,
}));

const approvalRoute = {
  deliveryMode: "session" as const,
  agentId: "main",
  sessionKey: "agent:main:signal:direct:+15551230000",
};

const sessionConfig = {
  channels: { signal: { allowFrom: ["+15551230000"] } },
  approvals: { exec: { enabled: true, mode: "session" as const } },
};
const targetConfig = {
  ...sessionConfig,
  approvals: {
    exec: {
      enabled: true,
      mode: "targets" as const,
      targets: [{ channel: "signal", to: "+15551230000" }],
    },
  },
};
const lookupIdentity = {
  accountId: "default",
  conversationKey: "+15551230000",
  reactionKey: "👍",
  targetAuthor: "+15550009999",
};
const deliveryTarget = { channel: "signal", to: "+15551230000", accountId: "default" };
const reactionHint = "React with:\n\n👍 Allow Once\n👎 Deny";

function delivered(messageId: string, signalVisibleText?: string): Delivery["results"][number] {
  return {
    channel: "signal",
    messageId,
    ...(signalVisibleText === undefined ? {} : { meta: { signalVisibleText } }),
  };
}

function lookup(
  messageId: string,
  overrides: Partial<Parameters<typeof resolveSignalApprovalReactionTargetWithPersistence>[0]> = {},
) {
  return resolveSignalApprovalReactionTargetWithPersistence({
    ...lookupIdentity,
    messageId,
    ...overrides,
  });
}

type Delivery = Parameters<typeof registerSignalApprovalReactionTargetForDeliveredPayload>[0];
function registerDelivery(
  payload: Delivery["payload"],
  results: Delivery["results"],
  cfg: Delivery["cfg"] = targetConfig,
) {
  return registerSignalApprovalReactionTargetForDeliveredPayload({
    cfg,
    target: deliveryTarget,
    payload,
    results,
    targetAuthor: lookupIdentity.targetAuthor,
  });
}

function withHint(payload: Delivery["payload"], cfg: Delivery["cfg"] = targetConfig) {
  return addSignalApprovalReactionHintToStructuredPayload({
    cfg,
    accountId: deliveryTarget.accountId,
    to: deliveryTarget.to,
    payload,
    targetAuthor: lookupIdentity.targetAuthor,
  });
}

function react(
  messageId: string,
  overrides: Partial<Parameters<typeof maybeResolveSignalApprovalReaction>[0]> = {},
) {
  return maybeResolveSignalApprovalReaction({
    ...lookupIdentity,
    cfg: sessionConfig,
    actorId: deliveryTarget.to,
    messageId,
    ...overrides,
  });
}

function registerTarget(
  messageId: string,
  overrides: Partial<Parameters<typeof registerSignalApprovalReactionTarget>[0]> = {},
) {
  return registerSignalApprovalReactionTarget({
    accountId: "default",
    conversationKey: "+15551230000",
    messageId,
    approvalId: "exec-1",
    approvalKind: "exec",
    allowedDecisions: ["allow-once", "deny"],
    targetAuthorKeys: ["+15550009999"],
    route: approvalRoute,
    ...overrides,
  });
}

function execPayload(approvalId: string) {
  return buildExecApprovalPendingReplyPayload({
    approvalId,
    approvalSlug: approvalId,
    allowedDecisions: ["allow-once", "deny"],
    command: "printf test",
    host: "gateway",
    agentId: "main",
    sessionKey: approvalRoute.sessionKey,
  });
}

describe("Signal approval reactions", () => {
  beforeEach(() => {
    reactionStores.forEach((store) => store.clearForTest());
    resolverMocks.resolveSignalApproval.mockReset().mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once" },
    });
  });

  it("does not register metadata-only approval payloads without visible reaction hints", async () => {
    const payload = execPayload("exec-hidden-reaction");
    expect(await registerDelivery(payload, [delivered("1700000000015")])).toBe(false);
    await expect(lookup("1700000000015")).resolves.toBeNull();
  });

  it("rejects persisted targets containing an invalid approval decision", async () => {
    const runtime = vi.spyOn(signalRuntime, "getOptionalSignalRuntime").mockReturnValue({
      state: {
        openKeyedStoreV2: () => ({
          register: async () => {},
          lookup: async () => ({
            version: 1,
            target: {
              approvalId: "exec-corrupt",
              approvalKind: "exec",
              allowedDecisions: ["allow-once", "invalid"],
              targetAuthorKeys: ["+15550009999"],
              route: { deliveryMode: "session" },
            },
          }),
          delete: async () => false,
        }),
      },
    } as never);
    try {
      reactionStores.forEach((store) => store.clearForTest());
      await expect(lookup("corrupt-message")).resolves.toBeNull();
    } finally {
      reactionStores.forEach((store) => store.clearForTest());
      runtime.mockRestore();
    }
  });

  it("registers only delivered chunks that contain visible reaction hints", async () => {
    const deliveredPayload = withHint(execPayload("exec-chunked-reaction"));

    expect(
      await registerDelivery(deliveredPayload!, [
        delivered("1700000000016", `Exec approval required\n\n${reactionHint}`),
        delivered("1700000000017", "Continuation chunk without controls"),
      ]),
    ).toBe(true);

    await expect(lookup("1700000000016")).resolves.toEqual({
      approvalId: "exec-chunked-reaction",
      approvalKind: "exec",
      decision: "allow-once",
      route: {
        ...approvalRoute,
        deliveryMode: "target",
        to: deliveryTarget.to,
        accountId: "default",
      },
    });
    await expect(lookup("1700000000017")).resolves.toBeNull();
  });

  it("registers alias-configured delivered prompts under the canonical target", async () => {
    const cfg = {
      channels: {
        signal: { ...sessionConfig.channels.signal, aliases: { me: deliveryTarget.to } },
      },
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "signal", to: "signal:me" }],
        },
      },
    };
    const payload = buildPluginApprovalPendingReplyPayload({
      request: {
        id: "plugin:abc",
        request: {
          title: "Sensitive plugin action",
          description: "Needs approval",
          allowedDecisions: ["allow-once", "deny"],
          pluginId: "demo",
          toolName: "dangerousTool",
          agentId: "main",
          sessionKey: "agent:main:signal:direct:+15551230000",
        },
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      },
      nowMs: 1_000,
    });
    const deliveredPayload = withHint(payload, cfg);

    expect(deliveredPayload?.text).toContain(reactionHint);
    expect(await registerDelivery(deliveredPayload!, [delivered("1700000000010")], cfg)).toBe(true);

    await expect(lookup("1700000000010")).resolves.toMatchObject({
      approvalId: "plugin:abc",
      approvalKind: "plugin",
      decision: "allow-once",
      route: { deliveryMode: "target", to: deliveryTarget.to, accountId: "default" },
    });
    await expect(lookup("1700000000010", { conversationKey: "me" })).resolves.toBeNull();
  });

  it("does not register delivered structured approval payloads without explicit approvers", async () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-no-approvers",
      approvalSlug: "exec-no",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf test",
      host: "gateway",
    });
    const deliveredPayload = {
      ...payload,
      text: addApprovalReactionHintToText({
        text: payload.text ?? "",
        allowedDecisions: ["allow-once", "deny"],
      }),
    };

    expect(
      await registerDelivery(deliveredPayload, [delivered("1700000000014")], {
        ...targetConfig,
        channels: { signal: {} },
      }),
    ).toBe(false);
  });

  it("rejects reaction registration with an undefined approval kind", async () => {
    expect(
      await registerTarget("1700000000099", {
        approvalId: "approval-without-owner",
        approvalKind: undefined as never,
        allowedDecisions: ["deny"],
      }),
    ).toBeNull();
  });

  it("does not match timestamp-only bindings when the inbound conversation id differs", async () => {
    await registerTarget("1700000000001", { conversationKey: "username:kevin" });

    await expect(lookup("1700000000001")).resolves.toBeNull();
  });

  it("requires the reaction target author to match the outbound bot identity", async () => {
    await registerTarget("1700000000006", { allowedDecisions: ["allow-once"] });

    await expect(lookup("1700000000006", { targetAuthor: "+15550008888" })).resolves.toBeNull();

    await expect(lookup("1700000000006")).resolves.toEqual({
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      route: approvalRoute,
    });
  });

  it("authorizes system-agent reactions using Signal approval approvers", async () => {
    const approvalKind = "system-agent";
    const approvalId = "system-agent:abc";
    await registerTarget("1700000000003", {
      conversationKey: "group:g1",
      approvalId,
      approvalKind,
    });

    const reaction = { conversationKey: "group:g1" };

    await expect(react("1700000000003", { ...reaction, actorId: "+15551239999" })).resolves.toBe(
      true,
    );
    expect(resolverMocks.resolveSignalApproval).not.toHaveBeenCalled();

    await expect(react("1700000000003", reaction)).resolves.toBe(true);
    expect(resolverMocks.resolveSignalApproval).toHaveBeenCalledExactlyOnceWith({
      cfg: sessionConfig,
      approvalId,
      approvalKind,
      decision: "allow-once",
      channel: "signal",
      accountId: "default",
      senderId: "+15551230000",
    });
  });

  it("consumes a losing surface and logs the canonical winning decision", async () => {
    await registerTarget("1700000000019", { approvalId: "exec-losing-surface" });
    resolverMocks.resolveSignalApproval.mockResolvedValueOnce({
      applied: false,
      approval: { status: "denied", decision: "deny" },
    });
    const logVerboseMessage = vi.fn();

    await expect(react("1700000000019", { logVerboseMessage })).resolves.toBe(true);

    expect(resolverMocks.resolveSignalApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "exec-losing-surface",
        approvalKind: "exec",
        decision: "allow-once",
      }),
    );
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "signal: approval reaction already resolved id=exec-losing-surface " +
        "sender=+15551230000 status=denied decision=deny",
    );
    expect(logVerboseMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("decision=allow-once"),
    );
    await expect(lookup("1700000000019")).resolves.toBeNull();
  });

  it.each([
    { name: "explicit approvers", cfg: { ...sessionConfig, channels: { signal: {} } } },
    {
      name: "the current top-level approval route",
      cfg: {
        ...sessionConfig,
        approvals: { exec: { ...sessionConfig.approvals.exec, agentFilter: ["other-agent"] } },
      },
    },
  ])("requires $name before resolving reactions", async ({ cfg }) => {
    await registerTarget("1700000000004", { allowedDecisions: ["allow-once"] });
    await expect(react("1700000000004", { cfg })).resolves.toBe(true);
    expect(resolverMocks.resolveSignalApproval).not.toHaveBeenCalled();
  });
});
