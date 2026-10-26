import type { PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { slackApprovalCapability as capability } from "./approval-native.js";
import { buildPluginRequest, useSlackInstallations } from "./approval-native.test-support.js";

type SlackConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;
type SlackPolicy = NonNullable<NonNullable<OpenClawConfig["approvals"]>["plugin"]>["slack"];
const reviewer = "team:T11111111:user:U11111111";
const selected = { approvers: [reviewer] };
const native = capability.nativeAsync!;
const availability = capability.nativeRuntimeAsync!.availability;
const delivery = native.describeDeliveryCapabilities;
const actionState = capability.getActionAvailabilityStateAsync!;
const reviewerDelivery = {
  enabled: true,
  preferredSurface: "approver-dm",
  supportsApproverDmSurface: true,
  notifyOriginWhenDmOnly: true,
};
const register = useSlackInstallations();
const install = (accountId = "default", teamId = "T11111111") =>
  register(accountId, "workspace", teamId);
function config(policy: SlackPolicy = selected, slack: Partial<SlackConfig> = {}): OpenClawConfig {
  return {
    channels: { slack: { botToken: "xoxb-test", appToken: "xapp-test", ...slack } },
    approvals: { plugin: { slack: policy } },
  };
}
function pending(overrides: Partial<PluginApprovalRequest["request"]> = {}): PluginApprovalRequest {
  return buildPluginRequest({
    turnSourceChannel: "slack",
    turnSourceTo: "team:T11111111:channel:C11111111",
    policySubject: { pluginKey: "diffs", tool: "view" },
    ...overrides,
  });
}
function route(cfg = config(), request = pending(), accountId = "default") {
  return { cfg, request, accountId, approvalKind: "plugin" as const };
}
async function canApprove(params: ReturnType<typeof route>, senderId = reviewer) {
  return (await capability.authorizeActorActionAsync!({ ...params, senderId, action: "approve" }))
    .authorized;
}
async function expectRouting(params: ReturnType<typeof route>, enabled: boolean) {
  expect(await availability.shouldHandle(params)).toBe(enabled);
  expect(await native.resolveApproverDmTargets!(params)).toEqual(enabled ? [{ to: reviewer }] : []);
  expect(await canApprove(params)).toBe(enabled);
}

describe("Slack plugin reviewer routing", () => {
  it("delivers only to the selected tool reviewer", async () => {
    install();
    const params = route(
      config({
        approvers: [],
        plugins: {
          diffs: { approvers: ["U22222222"], tools: { view: { approvers: ["U11111111"] } } },
        },
      }),
    );
    expect(await availability.isConfigured(params)).toBe(true);
    await expectRouting(params, true);
    expect(await canApprove(params, "team:T11111111:user:U22222222")).toBe(false);
    expect(await delivery(params)).toMatchObject(reviewerDelivery);
    const exec = {
      ...params,
      approvalKind: "exec" as const,
      request: {
        ...params.request,
        approvalKind: "exec" as const,
        request: { command: "echo hi" },
      },
    };
    expect((await delivery(exec)).enabled).toBe(false);
  });

  it.each<[string, SlackPolicy, Partial<PluginApprovalRequest["request"]>, Partial<SlackConfig>]>([
    [
      "missing tool identity",
      { plugins: { diffs: { ...selected, tools: { view: selected } } } },
      { policySubject: { pluginKey: "diffs" } },
      {},
    ],
    ["missing plugin identity", { plugins: { diffs: selected } }, { policySubject: undefined }, {}],
    ["wrong workspace", selected, { turnSourceTo: "team:T22222222:channel:C22222222" }, {}],
    ["missing bot token", selected, {}, { botToken: "" }],
  ])("has no route for %s", async (_name, policy, request, slack) => {
    install();
    const params = route(config(policy, slack), pending(request));
    expect(await availability.shouldHandle(params)).toBe(false);
    expect(await native.resolveApproverDmTargets!(params)).toEqual([]);
    expect(await actionState({ ...params, action: "approve" })).toEqual({ kind: "disabled" });
  });

  it("keeps unmatched legacy commands without native delivery", async () => {
    const params = route(
      config(
        { plugins: { calendar: selected } },
        {
          allowFrom: ["U11111111"],
          execApprovals: { enabled: false, approvers: ["U11111111"], target: "dm" },
        },
      ),
    );
    expect(await actionState({ ...params, action: "approve" })).toEqual({ kind: "enabled" });
    expect(await availability.shouldHandle(params)).toBe(false);
  });

  it("keeps reviewer DMs when generic forwarding selects the session", async () => {
    install();
    const cfg = config(selected, { execApprovals: { enabled: false, target: "channel" } });
    cfg.approvals!.plugin = { ...cfg.approvals!.plugin, enabled: true, mode: "session" };
    const params = route(
      cfg,
      pending({
        turnSourceAccountId: "default",
        sessionKey: "slack:channel:C11111111:test-run",
      }),
    );
    expect(await delivery(params)).toMatchObject(reviewerDelivery);
  });

  it("blocks generic forwarding for the selected plugin", () => {
    expect(
      capability.delivery!.shouldBlockForwardingFallback!({
        ...route(config({ plugins: { diffs: { approvers: [] } } })),
        target: { channel: "slack", to: "user:U99999999", accountId: "default" },
      }),
    ).toBe(true);
  });
});

describe("Slack plugin reviewer account custody", () => {
  it.each([
    ["ambiguous", "T11111111", true, false],
    ["other workspace", "T22222222", true, true],
    ["disabled", "T11111111", false, true],
  ] as const)(
    "selects the account when its sibling is %s",
    async (_name, otherTeam, enabled, expected) => {
      install();
      install("ops", otherTeam);
      const cfg = config(
        { approvers: [reviewer, "team:T22222222:user:U22222222"] },
        {
          accounts: {
            default: { botToken: "xoxb-default", appToken: "xapp-default" },
            ops: { enabled, botToken: "xoxb-ops", appToken: "xapp-ops" },
          },
        },
      );
      const params = route(cfg);
      await expectRouting(params, expected);
      await expectRouting({ ...params, accountId: "ops" }, false);
      if (!expected) {
        const bound = route(cfg, pending({ turnSourceAccountId: "ops" }), "ops");
        expect(await availability.shouldHandle(bound)).toBe(true);
        expect(await native.resolveApproverDmTargets!(bound)).toEqual([{ to: reviewer }]);
        expect(await availability.shouldHandle({ ...bound, accountId: "default" })).toBe(false);
      }
    },
  );

  it("requires the current authenticated installation", async () => {
    const params = route(config(), pending({ turnSourceTo: "channel:C11111111" }));
    const state = async () => [
      await availability.shouldHandle(params),
      (await delivery(params)).enabled,
      await native.resolveApproverDmTargets!(params),
      await canApprove(params),
    ];
    const unavailable = [false, false, [], false];
    expect(await state()).toEqual(unavailable);
    const degraded = register("default", "degraded");
    expect(await state()).toEqual(unavailable);
    degraded.release();
    const installation = install();
    expect(await state()).toEqual([true, true, [{ to: reviewer }], true]);
    installation.update("workspace", "T22222222");
    expect(await state()).toEqual(unavailable);
    installation.release();
    expect(await state()).toEqual(unavailable);
  });
});
