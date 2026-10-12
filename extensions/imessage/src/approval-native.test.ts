import {
  createNativeApprovalTestFixture,
  createLocalApprovalPromptTestFixture,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import {
  imessageApprovalCapability,
  shouldSuppressLocalIMessageExecApprovalPrompt,
} from "./approval-native.js";

const fixture = createNativeApprovalTestFixture({
  channel: "imessage",
  capability: imessageApprovalCapability,
  buildConfig: ({ channel, approvals } = {}) => ({
    channels: { imessage: { enabled: true, ...channel } },
    approvals,
  }),
});
const {
  buildConfig,
  buildExecRequest,
  buildPluginRequest,
  buildTargetModeConfig,
  resolveExecOrigin,
  checks,
} = fixture;
const { suppressLocalSessionPrompt, checks: localChecks } = createLocalApprovalPromptTestFixture({
  channel: "imessage",
  buildConfig,
  suppress: shouldSuppressLocalIMessageExecApprovalPrompt,
});

const DEFAULT_ACCOUNT_ID = "default";
const DIRECT_TARGET = "+15551230000";
const GROUP_TARGET = "chat_guid:iMessage;+;chat42";

describe("imessage approval capability", () => {
  it("uses target-mode config for requestless availability without native runtime handling", () =>
    checks.targetMode());

  it("renders thumbs-only reaction hints in plugin approval prompts and respects allowed decisions", () => {
    const payload = imessageApprovalCapability.render?.plugin?.buildPendingPayload?.({
      cfg: buildConfig(),
      request: buildPluginRequest(DIRECT_TARGET, {
        allowedDecisions: ["allow-once", "deny"],
      }),
      target: { channel: "imessage", to: DIRECT_TARGET, source: "target" },
      nowMs: 0,
    });

    expect(payload?.text).toContain("👍 Allow Once");
    expect(payload?.text).toContain("👎 Deny");
    expect(payload?.text).not.toContain("Allow Always");
  });

  it("renders target-mode exec prompts with concrete thumbs-only reaction choices", () => {
    const cfg = buildTargetModeConfig("exec", [{ channel: "imessage", to: DIRECT_TARGET }]);
    const request = buildExecRequest(DIRECT_TARGET, {
      ask: "always",
      cwd: "/tmp/work",
      host: "gateway",
    });

    const payload = imessageApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg,
      request,
      target: { channel: "imessage", to: DIRECT_TARGET, source: "target" },
      nowMs: 0,
    });
    const text = payload?.text ?? "";

    expect(text).toContain("/approve exec-1 allow-once");
    expect(text).toContain("React with:");
    expect(text).toContain("👍 Allow Once");
    expect(text).toContain("👎 Deny");
    expect(text).not.toContain("<id>");
    expect(text).not.toContain("1️⃣ Allow Once");
    expect(text).not.toContain("2️⃣ Allow Always");
    expect(text).not.toContain("3️⃣ Deny");
    expect(text.indexOf("React with:")).toBeLessThan(text.indexOf("/approve exec-1 allow-once"));
  });

  it("allows group-origin tapback approvals only after exec forwarding and approvers are configured", () => {
    const request = buildExecRequest(GROUP_TARGET);
    const withoutApprovers = buildConfig({ approvals: { exec: { enabled: true } } });
    const withApprovers = buildConfig({
      channel: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });

    expect(resolveExecOrigin(withoutApprovers, request)).toBeNull();
    expect(resolveExecOrigin(withApprovers, request)).toEqual({
      to: GROUP_TARGET,
      accountId: DEFAULT_ACCOUNT_ID,
    });
  });
});

describe("shouldSuppressLocalIMessageExecApprovalPrompt", () => {
  it(
    "keeps local prompts for disabled, target-only, inactive, or non-exec cases",
    localChecks.inactiveRoutes,
  );

  it("suppresses direct same-chat iMessage prompts without explicit approvers", () => {
    const cfg = buildConfig({
      approvals: { exec: { enabled: true } },
    });

    for (const [sessionKey, accountId] of [
      ["agent:main:imessage:+15551230000", undefined],
      ["agent:main:imessage:direct:+15551230000", DEFAULT_ACCOUNT_ID],
      ["agent:main:imessage:default:direct:+15551230000", DEFAULT_ACCOUNT_ID],
    ] as const) {
      expect(suppressLocalSessionPrompt(cfg, sessionKey, { accountId })).toBe(true);
    }
  });

  it("keeps no-approver local prompts for ambiguous or group iMessage sessions", () => {
    const cfg = buildConfig({
      approvals: { exec: { enabled: true } },
    });

    for (const [sessionKey, accountId] of [
      ["agent:main:imessage:group:test-group", undefined],
      ["agent:main:imessage:chat_guid:iMessage;+;chat42", undefined],
      ["agent:main:slack:C123", undefined],
      ["agent:main:imessage:default:direct:+15551230000", "work"],
    ] as const) {
      expect(suppressLocalSessionPrompt(cfg, sessionKey, { accountId })).toBe(false);
    }
  });

  it(
    "applies top-level approval filters with agent fallback from session key",
    localChecks.sessionFilters,
  );
});
