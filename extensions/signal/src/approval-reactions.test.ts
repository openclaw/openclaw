import { addApprovalReactionHintToText } from "openclaw/plugin-sdk/approval-reaction-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSignalApprovalReactionHintToStructuredPayload,
  clearSignalApprovalReactionTargetsForTest,
  maybeResolveSignalApprovalReaction,
  registerSignalApprovalReactionTargetForDeliveredPayload,
  registerSignalApprovalReactionTarget,
  resolveSignalApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import * as signalRuntime from "./runtime.js";

const resolverMocks = vi.hoisted(() => ({
  resolveSignalApproval: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolverMocks.resolveSignalApproval,
}));
vi.mock("openclaw/plugin-sdk/error-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/error-runtime")>(
    "openclaw/plugin-sdk/error-runtime",
  );
  return {
    ...actual,
    isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
  };
});

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

function registerTarget(
  overrides: Partial<Parameters<typeof registerSignalApprovalReactionTarget>[0]>,
) {
  return registerSignalApprovalReactionTarget({
    accountId: "default",
    conversationKey: "+15551230000",
    messageId: "1700000000000",
    approvalId: "exec-1",
    approvalKind: "exec",
    allowedDecisions: ["allow-once", "deny"],
    targetAuthorKeys: ["+15550009999"],
    route: approvalRoute,
    routeAllowed: true,
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
    clearSignalApprovalReactionTargetsForTest();
    resolverMocks.resolveSignalApproval.mockReset();
    resolverMocks.resolveSignalApproval.mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once" },
    });
    resolverMocks.isApprovalNotFoundError.mockReset();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
  });

  it("does not register metadata-only approval payloads without visible reaction hints", async () => {
    const cfg = targetConfig;
    const payload = execPayload("exec-hidden-reaction");

    expect(
      await registerSignalApprovalReactionTargetForDeliveredPayload({
        cfg,
        target: deliveryTarget,
        payload,
        results: [
          {
            channel: "signal",
            messageId: "1700000000015",
          },
        ],
        targetAuthor: "+15550009999",
      }),
    ).toBe(false);

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        ...lookupIdentity,
        messageId: "1700000000015",
      }),
    ).resolves.toBeNull();
  });

  it("rejects persisted targets containing an invalid approval decision", async () => {
    const runtime = vi.spyOn(signalRuntime, "getOptionalSignalRuntime").mockReturnValue({
      state: {
        openKeyedStore: () => ({
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
      clearSignalApprovalReactionTargetsForTest();
      await expect(
        resolveSignalApprovalReactionTargetWithPersistence({
          ...lookupIdentity,
          messageId: "corrupt-message",
        }),
      ).resolves.toBeNull();
    } finally {
      clearSignalApprovalReactionTargetsForTest();
      runtime.mockRestore();
    }
  });

  it("registers only delivered chunks that contain visible reaction hints", async () => {
    const cfg = targetConfig;
    const payload = execPayload("exec-chunked-reaction");
    const deliveredPayload = addSignalApprovalReactionHintToStructuredPayload({
      cfg,
      accountId: "default",
      to: "+15551230000",
      payload,
      targetAuthor: "+15550009999",
    });

    expect(
      await registerSignalApprovalReactionTargetForDeliveredPayload({
        cfg,
        target: deliveryTarget,
        payload: deliveredPayload!,
        results: [
          {
            channel: "signal",
            messageId: "1700000000016",
            meta: {
              signalVisibleText: "Exec approval required\n\nReact with:\n\n👍 Allow Once\n👎 Deny",
            },
          },
          {
            channel: "signal",
            messageId: "1700000000017",
            meta: {
              signalVisibleText: "Continuation chunk without controls",
            },
          },
        ],
        targetAuthor: "+15550009999",
      }),
    ).toBe(true);

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        ...lookupIdentity,
        messageId: "1700000000016",
      }),
    ).resolves.toEqual({
      approvalId: "exec-chunked-reaction",
      approvalKind: "exec",
      decision: "allow-once",
      route: {
        deliveryMode: "target",
        to: "+15551230000",
        accountId: "default",
        agentId: "main",
        sessionKey: "agent:main:signal:direct:+15551230000",
      },
    });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        ...lookupIdentity,
        messageId: "1700000000017",
      }),
    ).resolves.toBeNull();
  });

  it("registers alias-configured delivered prompts under the canonical target", async () => {
    const cfg = {
      channels: {
        signal: {
          allowFrom: ["+15551230000"],
          aliases: {
            me: "+15551230000",
          },
        },
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
    const deliveredPayload = addSignalApprovalReactionHintToStructuredPayload({
      cfg,
      accountId: "default",
      to: "+15551230000",
      payload,
      targetAuthor: "+15550009999",
    });

    expect(deliveredPayload?.text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");
    expect(
      await registerSignalApprovalReactionTargetForDeliveredPayload({
        cfg,
        target: deliveryTarget,
        payload: deliveredPayload!,
        results: [
          {
            channel: "signal",
            messageId: "1700000000010",
          },
        ],
        targetAuthor: "+15550009999",
      }),
    ).toBe(true);

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        ...lookupIdentity,
        messageId: "1700000000010",
      }),
    ).resolves.toMatchObject({
      approvalId: "plugin:abc",
      approvalKind: "plugin",
      decision: "allow-once",
      route: {
        deliveryMode: "target",
        to: "+15551230000",
        accountId: "default",
      },
    });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        ...lookupIdentity,
        conversationKey: "me",
        messageId: "1700000000010",
      }),
    ).resolves.toBeNull();
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
      await registerSignalApprovalReactionTargetForDeliveredPayload({
        cfg: { ...targetConfig, channels: { signal: {} } },
        target: deliveryTarget,
        payload: deliveredPayload,
        results: [
          {
            channel: "signal",
            messageId: "1700000000014",
          },
        ],
        targetAuthor: "+15550009999",
      }),
    ).toBe(false);
  });

  it("rejects reaction registration without a valid explicit approval kind", async () => {
    expect(
      await registerTarget({
        messageId: "1700000000099",
        approvalId: "approval-without-owner",
        approvalKind: undefined as never,
        allowedDecisions: ["deny"],
      }),
    ).toBeNull();
  });

  it("does not match timestamp-only bindings when the inbound conversation id differs", async () => {
    await registerTarget({
      conversationKey: "username:kevin",
      messageId: "1700000000001",
      allowedDecisions: ["allow-once", "deny"],
    });

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        ...lookupIdentity,
        messageId: "1700000000001",
      }),
    ).resolves.toBeNull();
  });

  it("normalizes UUID target-author casing before matching", async () => {
    await registerTarget({
      messageId: "1700000000001",
      allowedDecisions: ["allow-once"],
      targetAuthorKeys: ["uuid:ABCDEF12-3456-7890-ABCD-EF1234567890"],
    });

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000001",
        reactionKey: "👍",
        targetAuthorUuid: "abcdef12-3456-7890-abcd-ef1234567890",
      }),
    ).resolves.toEqual({
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      route: approvalRoute,
    });
  });

  it("requires the reaction target author to match the outbound bot identity", async () => {
    await registerTarget({
      messageId: "1700000000006",
      allowedDecisions: ["allow-once"],
    });

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000006",
        reactionKey: "👍",
        targetAuthor: "+15550008888",
      }),
    ).resolves.toBeNull();

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        ...lookupIdentity,
        messageId: "1700000000006",
      }),
    ).resolves.toEqual({
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      route: approvalRoute,
    });
  });

  it("authorizes reactions using Signal approval approvers", async () => {
    await registerTarget({
      conversationKey: "group:g1",
      messageId: "1700000000003",
      approvalId: "plugin:abc",
      approvalKind: "plugin",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    const cfg = {
      ...sessionConfig,
      approvals: { plugin: { enabled: true, mode: "session" as const } },
    };

    const handled = await maybeResolveSignalApprovalReaction({
      ...lookupIdentity,
      cfg,
      conversationKey: "group:g1",
      messageId: "1700000000003",
      actorId: "+15551230000",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveSignalApproval).toHaveBeenCalledWith({
      cfg,
      approvalId: "plugin:abc",
      approvalKind: "plugin",
      decision: "allow-once",
      channel: "signal",
      accountId: "default",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("consumes a losing surface and logs the canonical winning decision", async () => {
    await registerTarget({
      messageId: "1700000000019",
      approvalId: "exec-losing-surface",
      allowedDecisions: ["allow-once", "deny"],
    });
    resolverMocks.resolveSignalApproval.mockResolvedValueOnce({
      applied: false,
      approval: { status: "denied", decision: "deny" },
    });
    const logVerboseMessage = vi.fn();

    await expect(
      maybeResolveSignalApprovalReaction({
        ...lookupIdentity,
        cfg: sessionConfig,
        messageId: "1700000000019",
        actorId: "+15551230000",
        logVerboseMessage,
      }),
    ).resolves.toBe(true);

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
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        ...lookupIdentity,
        messageId: "1700000000019",
      }),
    ).resolves.toBeNull();
  });

  it("requires explicit approvers for approval reactions", async () => {
    await registerTarget({
      messageId: "1700000000004",
      allowedDecisions: ["allow-once"],
    });

    const handled = await maybeResolveSignalApprovalReaction({
      ...lookupIdentity,
      cfg: { ...sessionConfig, channels: { signal: {} } },
      messageId: "1700000000004",
      actorId: "+15551230000",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveSignalApproval).not.toHaveBeenCalled();
  });

  it("re-checks the top-level approval route before resolving reactions", async () => {
    await registerTarget({
      messageId: "1700000000007",
      allowedDecisions: ["allow-once"],
    });

    const handled = await maybeResolveSignalApprovalReaction({
      ...lookupIdentity,
      cfg: {
        ...sessionConfig,
        approvals: { exec: { ...sessionConfig.approvals.exec, agentFilter: ["other-agent"] } },
      },
      messageId: "1700000000007",
      actorId: "+15551230000",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveSignalApproval).not.toHaveBeenCalled();
  });
});
