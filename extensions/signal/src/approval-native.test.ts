import {
  createNativeApprovalTestFixture,
  createLocalApprovalPromptTestFixture,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import {
  signalApprovalCapability,
  shouldSuppressLocalSignalExecApprovalPrompt,
} from "./approval-native.js";

const fixture = createNativeApprovalTestFixture({
  channel: "signal",
  capability: signalApprovalCapability,
  buildConfig: ({ channel, approvals } = {}) => ({
    channels: { signal: { enabled: true, ...channel } },
    approvals,
  }),
});
const { buildConfig, buildExecRequest, buildTargetModeConfig, checks } = fixture;
const { suppressLocalSessionPrompt, checks: localChecks } = createLocalApprovalPromptTestFixture({
  channel: "signal",
  buildConfig,
  suppress: shouldSuppressLocalSignalExecApprovalPrompt,
});

describe("signal approval capability", () => {
  it("subscribes the native runtime to system-agent approval events", checks.systemAgentEvents);

  it(
    "does not enable exec or plugin native approvals from Signal readiness alone",
    checks.disabledByDefault,
  );

  it("allows session-mode exec delivery for matching Signal origins", checks.sessionDelivery);

  it("requires explicit approvers before delivering group-origin approvals", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("group:g1");

    expect(
      signalApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }).enabled,
    ).toBe(false);

    const withApprover = buildConfig({
      channel: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });
    expect(
      signalApprovalCapability.native?.describeDeliveryCapabilities({
        cfg: withApprover,
        accountId: "default",
        approvalKind: "exec",
        request,
      }).enabled,
    ).toBe(true);
  });

  it("keeps exec and plugin forwarding gates independent", checks.independentKinds);

  it("does not use session mode for non-Signal-origin requests", checks.foreignOrigin);

  it("uses target-mode config for requestless availability without native runtime handling", () => {
    checks.targetMode(
      buildTargetModeConfig("exec", [{ channel: "signal", to: "+15551230000" }], {
        channel: { allowFrom: ["+15551230000"] },
      }),
    );
  });

  it("renders target-mode exec prompts without unbound reaction choices", () => {
    const cfg = buildConfig({
      channel: { allowFrom: ["+15551230000"] },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    });
    const request = buildExecRequest("+15551230000", {
      ask: "always",
      cwd: "/tmp/work",
      host: "gateway",
    });

    const payload = signalApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg,
      request,
      target: { channel: "signal", to: "+15551230000", source: "target" },
      nowMs: 0,
    });
    const text = payload?.text ?? "";

    expect(text).toContain("/approve exec-1 allow-once");
    expect(text).not.toContain("React with:");
    expect(text).not.toContain("👍 Allow Once");
    expect(text).not.toContain("👎 Deny");
    expect(text).not.toContain("<id>");
    expect(text).not.toContain("1️⃣ Allow Once");
    expect(text).not.toContain("2️⃣ Allow Always");
    expect(text).not.toContain("3️⃣ Deny");
  });

  it("does not show reaction choices when Signal has no explicit approvers", () => {
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    });
    const request = buildExecRequest("+15551230000");

    const payload = signalApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg,
      request,
      target: { channel: "signal", to: "+15551230000", source: "target" },
      nowMs: 0,
    });
    const text = payload?.text ?? "";

    expect(text).toContain("/approve exec-1 allow-once");
    expect(text).not.toContain("React with:");
    expect(text).not.toContain("👍 Allow Once");
    expect(text).not.toContain("👎 Deny");
  });

  it("normalizes equivalent Signal UUID target forms without suppressing generic target delivery", () => {
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "uuid:ABCDEF12-3456-7890-ABCD-EF1234567890" }],
        },
      },
    });
    const request = buildExecRequest("abcdef12-3456-7890-abcd-ef1234567890", {
      turnSourceChannel: "slack",
      turnSourceTo: "C123",
      sessionKey: "agent:main:slack:channel:c123",
    });

    expect(
      signalApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        request,
        target: {
          channel: "signal",
          to: "abcdef12-3456-7890-abcd-ef1234567890",
          source: "target",
        },
      }),
    ).toBe(false);
  });
});

describe("shouldSuppressLocalSignalExecApprovalPrompt", () => {
  it("suppresses eligible session-mode exec approval prompts", localChecks.eligibleSession);

  it("keeps local prompts for disabled, ambiguous, or non-exec cases", localChecks.inactiveRoutes);

  it("suppresses direct same-chat Signal prompts without explicit approvers", () => {
    const cfg = buildConfig({
      approvals: { exec: { enabled: true } },
    });

    expect(suppressLocalSessionPrompt(cfg, "agent:main:signal:+15551230000")).toBe(true);
  });

  it("keeps no-approver local prompts for ambiguous or group Signal sessions", () => {
    const cfg = buildConfig({
      approvals: { exec: { enabled: true } },
    });

    expect(suppressLocalSessionPrompt(cfg, "agent:main:signal:group:test-group")).toBe(false);
    expect(suppressLocalSessionPrompt(cfg, "agent:main:slack:C123")).toBe(false);
  });

  it(
    "applies top-level approval filters with agent fallback from session key",
    localChecks.sessionFilters,
  );
});
