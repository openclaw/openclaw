import type { PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { slackApprovalCapability as capability } from "./approval-native.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

type SlackConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;
type SlackPolicy = NonNullable<NonNullable<OpenClawConfig["approvals"]>["plugin"]>["slack"];
const reviewer = "team:T11111111:user:U11111111";
const installations: Array<ReturnType<typeof registerSlackInstallationState>> = [];

afterEach(() => {
  for (const installation of installations.splice(0)) {
    installation.release();
  }
});

function install(accountId = "default", teamId = "T11111111") {
  const installation = registerSlackInstallationState(accountId, "workspace", teamId);
  installations.push(installation);
  return installation;
}

function config(policy: SlackPolicy, slack: Partial<SlackConfig> = {}): OpenClawConfig {
  return {
    channels: { slack: { botToken: "xoxb-test", appToken: "xapp-test", ...slack } },
    approvals: { plugin: { slack: policy } },
  };
}

function pending(overrides: Partial<PluginApprovalRequest["request"]> = {}): PluginApprovalRequest {
  return {
    id: "plugin:req-1",
    request: {
      title: "Plugin approval",
      description: "Allow access",
      turnSourceChannel: "slack",
      turnSourceTo: "team:T11111111:channel:C11111111",
      policySubject: { pluginKey: "diffs", tool: "view" },
      ...overrides,
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

function route(cfg: OpenClawConfig, request = pending(), accountId = "default") {
  return { cfg, request, accountId, approvalKind: "plugin" as const };
}

function canApprove(params: ReturnType<typeof route>, senderId = reviewer) {
  return capability.authorizeActorAction?.({ ...params, senderId, action: "approve" }).authorized;
}

describe("Slack plugin reviewer routing", () => {
  it.each([reviewer, "U11111111"])(
    "delivers tool-selected reviewer %s only to their DM",
    async (id) => {
      install();
      const cfg = config({
        approvers: [],
        plugins: { diffs: { approvers: ["U22222222"], tools: { view: { approvers: [id] } } } },
      });
      const params = route(cfg);
      expect(capability.nativeRuntime?.availability.isConfigured(params)).toBe(true);
      expect(capability.nativeRuntime?.availability.shouldHandle(params)).toBe(true);
      expect(await capability.native?.resolveApproverDmTargets?.(params)).toEqual([
        { to: reviewer },
      ]);
      expect(canApprove(params)).toBe(true);
      expect(canApprove(params, "team:T11111111:user:U22222222")).toBe(false);
      expect(capability.native?.describeDeliveryCapabilities(params)).toMatchObject({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsApproverDmSurface: true,
        notifyOriginWhenDmOnly: true,
      });
      expect(
        capability.native?.describeDeliveryCapabilities({
          ...params,
          approvalKind: "exec",
          request: { ...params.request, approvalKind: "exec", request: { command: "echo hi" } },
        }).enabled,
      ).toBe(false);
    },
  );

  it.each<{
    name: string;
    policy: SlackPolicy;
    request?: Partial<PluginApprovalRequest["request"]>;
    slack?: Partial<SlackConfig>;
  }>([
    {
      name: "empty default",
      policy: { approvers: [] },
      slack: { execApprovals: { enabled: true } },
    },
    {
      name: "unmatched tool",
      policy: { approvers: [], plugins: { diffs: { tools: { edit: { approvers: [reviewer] } } } } },
    },
    {
      name: "missing tool identity",
      policy: {
        plugins: { diffs: { approvers: [reviewer], tools: { view: { approvers: [reviewer] } } } },
      },
      request: { policySubject: { pluginKey: "diffs" } },
    },
    {
      name: "missing plugin identity",
      policy: { plugins: { diffs: { approvers: [reviewer] } } },
      request: { policySubject: undefined },
    },
    {
      name: "wrong workspace",
      policy: { approvers: [reviewer] },
      request: { turnSourceTo: "team:T22222222:channel:C22222222" },
    },
    { name: "missing bot token", policy: { approvers: [reviewer] }, slack: { botToken: "" } },
  ])("has no route for $name", async ({ policy, request, slack }) => {
    install();
    const params = route(config(policy, slack), pending(request));
    expect(capability.nativeRuntime?.availability.shouldHandle(params)).toBe(false);
    expect(await capability.native?.resolveApproverDmTargets?.(params)).toEqual([]);
    expect(capability.getActionAvailabilityState?.({ ...params, action: "approve" })).toEqual({
      kind: "disabled",
    });
  });

  it("uses the default reviewer list without a selected plugin identity", async () => {
    install();
    const params = route(config({ approvers: [reviewer] }), pending({ policySubject: undefined }));
    expect(await capability.native?.resolveApproverDmTargets?.(params)).toEqual([{ to: reviewer }]);
    expect(canApprove(params)).toBe(true);
  });

  it("keeps an unmatched plugin's legacy command route without enabling native delivery", () => {
    const params = route(
      config(
        { plugins: { calendar: { approvers: [reviewer] } } },
        {
          allowFrom: ["U11111111"],
          execApprovals: { enabled: false, approvers: ["U11111111"], target: "dm" },
        },
      ),
    );
    expect(capability.getActionAvailabilityState?.({ ...params, action: "approve" })).toEqual({
      kind: "enabled",
    });
    expect(capability.nativeRuntime?.availability.shouldHandle(params)).toBe(false);
  });

  it("keeps selected reviewers on DMs when generic forwarding selects the session", () => {
    install();
    const cfg = config(
      { approvers: [reviewer] },
      { execApprovals: { enabled: false, target: "channel" } },
    );
    cfg.approvals!.plugin = { ...cfg.approvals!.plugin, enabled: true, mode: "session" };
    const params = route(
      cfg,
      pending({ turnSourceAccountId: "default", sessionKey: "slack:channel:C11111111:test-run" }),
    );
    expect(capability.native?.describeDeliveryCapabilities(params)).toMatchObject({
      enabled: true,
      preferredSurface: "approver-dm",
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });

  it.each<{
    name: string;
    policy: SlackPolicy;
    request?: Partial<PluginApprovalRequest["request"]>;
    blocked: boolean;
  }>([
    { name: "selected list", policy: { approvers: [reviewer] }, blocked: true },
    { name: "empty list", policy: { approvers: [] }, blocked: true },
    { name: "selected plugin", policy: { plugins: { diffs: { approvers: [] } } }, blocked: true },
    {
      name: "unmatched plugin",
      policy: { plugins: { calendar: { approvers: [] } } },
      blocked: false,
    },
    {
      name: "unknown owner",
      policy: { plugins: { diffs: { approvers: [reviewer] } } },
      request: { policySubject: undefined },
      blocked: true,
    },
  ])(
    "blocks generic forwarding for $name according to the selected policy",
    ({ policy, request, blocked }) => {
      expect(
        capability.delivery?.shouldBlockForwardingFallback?.({
          ...route(config(policy), pending(request)),
          target: { channel: "slack", to: "user:U99999999", accountId: "default" },
        }),
      ).toBe(blocked);
    },
  );
});

describe("Slack plugin reviewer account custody", () => {
  it.each([
    { name: "ambiguous", otherTeam: "T11111111", otherEnabled: true, expected: false },
    { name: "other workspace", otherTeam: "T22222222", otherEnabled: true, expected: true },
    { name: "disabled", otherTeam: "T11111111", otherEnabled: false, expected: true },
  ])(
    "selects the eligible account when its sibling is $name",
    async ({ otherTeam, otherEnabled, expected }) => {
      install();
      install("ops", otherTeam);
      const cfg = config(
        { approvers: [reviewer, "team:T22222222:user:U22222222"] },
        {
          accounts: {
            default: { botToken: "xoxb-default", appToken: "xapp-default" },
            ops: { enabled: otherEnabled, botToken: "xoxb-ops", appToken: "xapp-ops" },
          },
        },
      );
      const params = route(cfg);
      expect(capability.nativeRuntime?.availability.shouldHandle(params)).toBe(expected);
      expect(await capability.native?.resolveApproverDmTargets?.(params)).toEqual(
        expected ? [{ to: reviewer }] : [],
      );
      expect(canApprove(params)).toBe(expected);
      const sibling = { ...params, accountId: "ops" };
      expect(capability.nativeRuntime?.availability.shouldHandle(sibling)).toBe(false);
      expect(await capability.native?.resolveApproverDmTargets?.(sibling)).toEqual([]);
      expect(canApprove(sibling)).toBe(false);

      if (!expected) {
        const bound = route(cfg, pending({ turnSourceAccountId: "ops" }), "ops");
        expect(capability.nativeRuntime?.availability.shouldHandle(bound)).toBe(true);
        expect(await capability.native?.resolveApproverDmTargets?.(bound)).toEqual([
          { to: reviewer },
        ]);
        expect(
          capability.nativeRuntime?.availability.shouldHandle({ ...bound, accountId: "default" }),
        ).toBe(false);
      }
    },
  );

  it("requires the current authenticated installation for routing and decisions", async () => {
    const params = route(
      config({ approvers: [reviewer] }),
      pending({ turnSourceTo: "channel:C11111111" }),
    );
    const state = async () => ({
      route: capability.nativeRuntime?.availability.shouldHandle(params),
      delivery: capability.native?.describeDeliveryCapabilities(params).enabled,
      targets: await capability.native?.resolveApproverDmTargets?.(params),
      authorized: canApprove(params),
    });
    const unavailable = { route: false, delivery: false, targets: [], authorized: false };
    expect(await state()).toEqual(unavailable);
    const degraded = registerSlackInstallationState("default", "degraded");
    installations.push(degraded);
    expect(await state()).toEqual(unavailable);
    degraded.release();
    const installation = install();
    expect(await state()).toEqual({
      route: true,
      delivery: true,
      targets: [{ to: reviewer }],
      authorized: true,
    });
    installation.update("workspace", "T22222222");
    expect(await state()).toEqual(unavailable);
    installation.release();
    expect(await state()).toEqual(unavailable);
  });
});
