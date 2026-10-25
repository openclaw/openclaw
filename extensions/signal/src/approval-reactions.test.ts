import { addApprovalReactionHintToText } from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyMetadata } from "openclaw/plugin-sdk/approval-reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSignalApprovalReactionHintToStructuredPayload,
  maybeResolveSignalApprovalReaction,
  registerSignalApprovalReactionTargetForDeliveredPayload,
  registerSignalApprovalReactionTarget,
  resolveSignalApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import * as signalRuntime from "./runtime.js";

const reactionStores = await vi.hoisted(() => import("./approval-reactions.test-support.js"));
const resolveApproval = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolveApproval,
}));

const sessionIdentity = {
  agentId: "main",
  sessionKey: "agent:main:signal:direct:+15551230000",
};
const approvalRoute = { deliveryMode: "session" as const, ...sessionIdentity };

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
const messageId = "1700000000001";

function delivered(id: string, signalVisibleText?: string): Delivery["results"][number] {
  return {
    channel: "signal",
    messageId: id,
    ...(signalVisibleText === undefined ? {} : { meta: { signalVisibleText } }),
  };
}

function lookup(
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
  results: Delivery["results"] = [delivered(messageId)],
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

function react(overrides: Partial<Parameters<typeof maybeResolveSignalApprovalReaction>[0]> = {}) {
  return maybeResolveSignalApprovalReaction({
    ...lookupIdentity,
    cfg: sessionConfig,
    actorId: deliveryTarget.to,
    messageId,
    ...overrides,
  });
}

function registerTarget(
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

function approvalPayload(approvalId: string, metadata: Partial<ExecApprovalReplyMetadata> = {}) {
  return {
    text: "Approval required.",
    channelData: {
      execApproval: {
        approvalId,
        approvalSlug: approvalId,
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
        ...metadata,
      },
    },
  };
}

describe("Signal approval reactions", () => {
  beforeEach(() => {
    reactionStores.clearSignalApprovalReactionStoresForTest();
    resolveApproval.mockReset().mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once" },
    });
  });

  it("does not register metadata-only approval payloads without visible reaction hints", async () => {
    const payload = approvalPayload("exec-hidden-reaction", sessionIdentity);
    expect(await registerDelivery(payload)).toBe(false);
    await expect(lookup()).resolves.toBeNull();
  });

  it("rejects persisted targets containing an invalid approval decision", async () => {
    await registerTarget();
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
      reactionStores.clearSignalApprovalReactionStoresForTest();
      await expect(lookup()).resolves.toBeNull();
    } finally {
      reactionStores.clearSignalApprovalReactionStoresForTest();
      runtime.mockRestore();
    }
  });

  it("registers only delivered chunks that contain visible reaction hints", async () => {
    const deliveredPayload = withHint(approvalPayload("exec-chunked-reaction", sessionIdentity));

    expect(
      await registerDelivery(deliveredPayload!, [
        delivered(messageId, `Exec approval required\n\n${reactionHint}`),
        delivered("1700000000017", "Continuation chunk without controls"),
      ]),
    ).toBe(true);

    await expect(lookup()).resolves.toEqual({
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
    await expect(lookup({ messageId: "1700000000017" })).resolves.toBeNull();
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
    const payload = approvalPayload("plugin:abc", { approvalKind: "plugin" });
    const deliveredPayload = withHint(payload, cfg);

    expect(deliveredPayload?.text).toContain(reactionHint);
    expect(await registerDelivery(deliveredPayload!, undefined, cfg)).toBe(true);

    await expect(lookup()).resolves.toMatchObject({
      approvalId: "plugin:abc",
      approvalKind: "plugin",
      decision: "allow-once",
      route: { deliveryMode: "target", to: deliveryTarget.to, accountId: "default" },
    });
    await expect(lookup({ conversationKey: "me" })).resolves.toBeNull();
  });

  it("does not register delivered structured approval payloads without explicit approvers", async () => {
    const payload = approvalPayload("exec-no-approvers", { approvalSlug: "exec-no" });
    const deliveredPayload = {
      ...payload,
      text: addApprovalReactionHintToText({
        text: payload.text ?? "",
        allowedDecisions: ["allow-once", "deny"],
      }),
    };

    expect(
      await registerDelivery(deliveredPayload, undefined, {
        ...targetConfig,
        channels: { signal: {} },
      }),
    ).toBe(false);
  });

  it("rejects reaction registration with an undefined approval kind", async () => {
    expect(
      await registerTarget({
        approvalId: "approval-without-owner",
        approvalKind: undefined as never,
        allowedDecisions: ["deny"],
      }),
    ).toBeNull();
  });

  it("does not match timestamp-only bindings when the inbound conversation id differs", async () => {
    await registerTarget({ conversationKey: "username:kevin" });

    await expect(lookup()).resolves.toBeNull();
  });

  it("requires the reaction target author to match the outbound bot identity", async () => {
    await registerTarget({ allowedDecisions: ["allow-once"] });

    await expect(lookup({ targetAuthor: "+15550008888" })).resolves.toBeNull();

    await expect(lookup()).resolves.toEqual({
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      route: approvalRoute,
    });
  });

  it("authorizes system-agent reactions using Signal approval approvers", async () => {
    const approvalKind = "system-agent";
    const approvalId = "system-agent:abc";
    await registerTarget({
      conversationKey: "group:g1",
      approvalId,
      approvalKind,
    });

    const reaction = { conversationKey: "group:g1" };

    await expect(react({ ...reaction, actorId: "+15551239999" })).resolves.toBe(true);
    expect(resolveApproval).not.toHaveBeenCalled();

    await expect(react(reaction)).resolves.toBe(true);
    expect(resolveApproval).toHaveBeenCalledExactlyOnceWith({
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
    await registerTarget({ approvalId: "exec-losing-surface" });
    resolveApproval.mockResolvedValueOnce({
      applied: false,
      approval: { status: "denied", decision: "deny" },
    });
    const logVerboseMessage = vi.fn();

    await expect(react({ logVerboseMessage })).resolves.toBe(true);

    expect(resolveApproval).toHaveBeenCalledWith(
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
    await expect(lookup()).resolves.toBeNull();
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
    await registerTarget({ allowedDecisions: ["allow-once"] });
    await expect(react({ cfg })).resolves.toBe(true);
    expect(resolveApproval).not.toHaveBeenCalled();
  });
});
