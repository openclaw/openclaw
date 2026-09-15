// Line tests cover the native approval capability routing contract.
import { isImplicitSameChatApprovalAuthorization } from "openclaw/plugin-sdk/approval-auth-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  createLocalApprovalPromptTestFixture,
  createNativeApprovalTestFixture,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import {
  lineApprovalCapability,
  shouldSuppressLocalLineExecApprovalPrompt,
} from "./approval-native.js";
import { linePlugin } from "./channel.js";

const APPROVER = "U0123456789abcdef0123456789abcdef";

const { buildConfig, buildExecRequest, checks } = createNativeApprovalTestFixture({
  channel: "line",
  capability: lineApprovalCapability,
  buildConfig: ({ channel, approvals } = {}) => ({
    channels: {
      line: { channelAccessToken: "test-token-placeholder", channelSecret: "secret", ...channel },
    },
    approvals,
  }),
});

const { suppressLocalSessionPrompt } = createLocalApprovalPromptTestFixture({
  channel: "line",
  buildConfig,
  suppress: shouldSuppressLocalLineExecApprovalPrompt,
});

const configured = buildConfig({
  channel: { allowFrom: [APPROVER] },
  approvals: { exec: { enabled: true } },
});

describe("line approval capability", () => {
  it("subscribes the native runtime to system-agent approval events", checks.systemAgentEvents);

  // LINE chats approved with typed `/approve` before cards existed. A `disabled` state
  // makes the Gateway expire a request no other client holds, so cards must never turn
  // that prompt off, whatever is configured. `checks.disabledByDefault` asserts the
  // opposite for channels that shipped cards from the start, so LINE does not run it.
  it("keeps same-chat /approve available whether or not cards are on", () => {
    const configs = [
      buildConfig(),
      buildConfig({ channel: { allowFrom: [APPROVER] } }),
      buildConfig({ approvals: { exec: { enabled: true } } }),
      configured,
    ];
    for (const cfg of configs) {
      for (const approvalKind of ["exec", "plugin", undefined] as const) {
        expect(
          lineApprovalCapability.getActionAvailabilityState?.({
            cfg,
            accountId: "default",
            action: "approve",
            ...(approvalKind ? { approvalKind } : {}),
          }),
        ).toEqual({ kind: "enabled" });
      }
    }
    // Without an exec-specific state, core reads exec availability from the state above.
    expect(lineApprovalCapability.getExecInitiatingSurfaceState).toBeUndefined();
  });

  // `allowFrom` is the DM allowlist first. Listing users there must not take `/approve`
  // away from command-authorized senders until cards are on for that approval kind.
  it("restricts decisions to listed approvers only for approval kinds whose cards are on", () => {
    const member = "U11111111111111111111111111111111";
    const authorize = (
      cfg: ReturnType<typeof buildConfig>,
      senderId: string,
      approvalKind: "exec" | "plugin",
    ) =>
      lineApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId,
        action: "approve",
        approvalKind,
      });
    const deferred = (authorization: ReturnType<typeof authorize>) =>
      authorization?.authorized === true && isImplicitSameChatApprovalAuthorization(authorization);

    // Cards on for exec: only the listed approver decides, explicitly.
    expect(authorize(configured, member, "exec")).toMatchObject({ authorized: false });
    const approverGrant = authorize(configured, APPROVER, "exec");
    expect(approverGrant).toEqual({ authorized: true });
    expect(isImplicitSameChatApprovalAuthorization(approverGrant)).toBe(false);

    // Cards off: plugin forwarding is off here, approvers alone turn nothing on,
    // forwarding without approvers draws no card, and a targets-only route sends text.
    expect(deferred(authorize(configured, member, "plugin"))).toBe(true);
    expect(
      deferred(authorize(buildConfig({ channel: { allowFrom: [APPROVER] } }), member, "exec")),
    ).toBe(true);
    expect(
      deferred(authorize(buildConfig({ approvals: { exec: { enabled: true } } }), member, "exec")),
    ).toBe(true);
    const targetsOnly = buildConfig({
      channel: { allowFrom: [APPROVER] },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "line", to: "line:group:C11111111111111111111111111111111" }],
        },
      },
    });
    expect(deferred(authorize(targetsOnly, member, "exec"))).toBe(true);
  });

  // A group postback carries no userId, so cards go to approver DMs and the chat that
  // raised the request has to be told where they went.
  it("delivers to approver DMs and notifies the originating chat", () => {
    const request = buildExecRequest("line:group:C0123456789abcdef0123456789abcdef");

    expect(
      lineApprovalCapability.native?.describeDeliveryCapabilities({
        cfg: configured,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toMatchObject({
      enabled: true,
      preferredSurface: "approver-dm",
      notifyOriginWhenDmOnly: true,
    });
  });

  // The route coordinator compares these keys to decide whether the originating chat
  // already has the card; a mismatch sends a "sent to DMs" notice into that same chat.
  it("treats a card sent to the approver who raised the request as delivered to its origin", async () => {
    const input = {
      cfg: configured,
      accountId: "default",
      approvalKind: "exec" as const,
      request: buildExecRequest(`line:${APPROVER}`),
    };
    const origin = await lineApprovalCapability.native?.resolveOriginTarget?.(input);
    const approverTargets = await lineApprovalCapability.native?.resolveApproverDmTargets?.(input);

    const originKey = origin ? buildChannelApprovalNativeTargetKey(origin) : undefined;

    expect(originKey).toBeDefined();
    expect(approverTargets?.map(buildChannelApprovalNativeTargetKey)).toEqual([originKey]);
  });

  // Forwarding without approvers draws no card, so neither the forwarded prompt nor the
  // local one may be dropped.
  it("keeps the text prompts when forwarding is on without approvers", () => {
    const forwardingOnly = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest(`line:${APPROVER}`);

    expect(
      lineApprovalCapability.native?.describeDeliveryCapabilities({
        cfg: forwardingOnly,
        accountId: "default",
        approvalKind: "exec",
        request,
      })?.enabled,
    ).toBe(false);
    expect(suppressLocalSessionPrompt(forwardingOnly, "agent:main:main")).toBe(false);
    expect(
      lineApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg: forwardingOnly,
        approvalKind: "exec",
        target: { channel: "line", to: `line:${APPROVER}`, source: "session" },
        request,
      }),
    ).toBe(false);
  });

  // Native delivery replaces the forwarded prompt only in the chats it reaches; a
  // configured operations group is not one of them and keeps its text prompt. Whether the
  // card handler is running is core's check, applied on top of this answer.
  it("drops forwarded prompts only for chats cards reach", () => {
    const opsGroup = "line:group:C11111111111111111111111111111111";
    const raisingGroup = "line:group:C0123456789abcdef0123456789abcdef";
    const cfg = buildConfig({
      channel: { allowFrom: [APPROVER] },
      approvals: {
        exec: { enabled: true, mode: "both", targets: [{ channel: "line", to: opsGroup }] },
      },
    });
    const suppressed = (to: string, source: "session" | "target", origin: string) =>
      lineApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "line", to, source },
        request: buildExecRequest(origin),
      });

    expect(
      lineApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: buildExecRequest(`line:${APPROVER}`),
      })?.enabled,
    ).toBe(true);
    expect(suppressed(opsGroup, "target", `line:${APPROVER}`)).toBe(false);
    expect(suppressed(`line:${APPROVER}`, "target", `line:${APPROVER}`)).toBe(true);
    expect(suppressed(`line:${APPROVER}`, "session", `line:${APPROVER}`)).toBe(true);
    // A group that raised the request gets the routed notice, not a second prompt, and the
    // approver's DM, reached here only as an approver and not as the origin, keeps just
    // the card.
    expect(suppressed(raisingGroup, "session", raisingGroup)).toBe(true);
    expect(suppressed(`line:${APPROVER}`, "target", raisingGroup)).toBe(true);
  });

  it("suppresses the local prompt when approvers receive the card", () => {
    expect(suppressLocalSessionPrompt(configured, "agent:main:main")).toBe(true);
  });

  it("sends the card to every listed approver", async () => {
    const second = "U11111111111111111111111111111111";
    const targets = await lineApprovalCapability.native?.resolveApproverDmTargets?.({
      cfg: buildConfig({
        channel: { allowFrom: [APPROVER, second] },
        approvals: { exec: { enabled: true } },
      }),
      accountId: "default",
      approvalKind: "exec",
      request: buildExecRequest("line:group:C0123456789abcdef0123456789abcdef"),
    });

    expect(targets?.map((target) => target.to)).toEqual([APPROVER, second]);
  });
});

// The capability and the local-prompt hook only matter once the plugin registers them.
describe("line plugin approval wiring", () => {
  it("registers the approval capability on the LINE plugin", () => {
    expect(linePlugin.approvalCapability).toBe(lineApprovalCapability);
  });

  it("suppresses the local prompt through the registered outbound hook", () => {
    const suppress = linePlugin.outbound?.shouldSuppressLocalPayloadPrompt;
    expect(suppress).toBeDefined();
    const { suppressLocalSessionPrompt: throughPlugin } = createLocalApprovalPromptTestFixture({
      channel: "line",
      buildConfig,
      suppress: (input) => suppress?.(input) ?? false,
    });

    expect(throughPlugin(configured, "agent:main:main")).toBe(true);
  });
});
