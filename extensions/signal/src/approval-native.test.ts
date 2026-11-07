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
  buildConfig: (options = {}) => {
    const { channel, approvals } = options;
    return {
      channels: { signal: { enabled: true, ...channel } },
      approvals,
    };
  },
});
const { buildConfig, buildExecRequest, buildTargetModeConfig, describeDelivery, checks } = fixture;
const { suppressLocalSessionPrompt } = createLocalApprovalPromptTestFixture({
  channel: "signal",
  buildConfig,
  suppress: shouldSuppressLocalSignalExecApprovalPrompt,
});
const approvers = { allowFrom: ["+15551230000"] };
const targetConfig = () =>
  buildTargetModeConfig("exec", [{ channel: "signal", to: "+15551230000" }], {
    channel: approvers,
  });

describe("signal approval capability", () => {
  it("requires explicit approvers before delivering group-origin approvals", async () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("group:g1");
    expect((await describeDelivery(cfg, request))?.enabled).toBe(false);
    const withApprover = buildConfig({
      channel: approvers,
      approvals: { exec: { enabled: true } },
    });
    expect((await describeDelivery(withApprover, request))?.enabled).toBe(true);
  });

  it("uses target-mode config for requestless availability without native runtime handling", async () => {
    await checks.targetMode(targetConfig());
  });

  it("renders target-mode exec prompts without unbound reaction choices", () => {
    const cfg = targetConfig();
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
    expect(text).not.toMatch(
      /React with:|👍 Allow Once|👎 Deny|<id>|1️⃣ Allow Once|2️⃣ Allow Always|3️⃣ Deny/,
    );
  });
});

describe("shouldSuppressLocalSignalExecApprovalPrompt", () => {
  it("keeps no-approver local prompts for ambiguous or group Signal sessions", () => {
    const cfg = buildConfig({
      approvals: { exec: { enabled: true } },
    });

    expect(suppressLocalSessionPrompt(cfg, "agent:main:signal:group:test-group")).toBe(false);
    expect(suppressLocalSessionPrompt(cfg, "agent:main:slack:C123")).toBe(false);
  });
});
