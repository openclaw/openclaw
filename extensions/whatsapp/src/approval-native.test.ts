import { createNativeApprovalTestFixture } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { whatsappApprovalCapability } from "./approval-native.js";

const fixture = createNativeApprovalTestFixture({
  channel: "whatsapp",
  capability: whatsappApprovalCapability,
  buildConfig: ({ channel, approvals } = {}) => ({
    channels: { whatsapp: { enabled: true, ...channel } },
    approvals,
  }),
});
const { buildConfig, buildExecRequest, buildPluginRequest, checks } = fixture;

describe("whatsapp approval capability", () => {
  it("subscribes the native runtime to system-agent approval events", checks.systemAgentEvents);

  it(
    "does not enable exec or plugin native approvals from WhatsApp account readiness alone",
    checks.disabledByDefault,
  );

  it("allows session-mode exec delivery for matching WhatsApp origins", checks.sessionDelivery);

  it("keeps exec and plugin forwarding gates independent", checks.independentKinds);

  it("does not use session mode for non-WhatsApp-origin requests", checks.foreignOrigin);

  it("uses target-mode config for requestless availability without native runtime handling", () =>
    checks.targetMode());

  it("renders target-mode exec prompts with concrete thumbs-only reaction choices", () => {
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "whatsapp", to: "+15551230000" }],
        },
      },
    });
    const request = buildExecRequest("+15551230000", {
      ask: "always",
      cwd: "/tmp/work",
      host: "gateway",
    });

    const payload = whatsappApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg,
      request,
      target: { channel: "whatsapp", to: "+15551230000", source: "target" },
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
    expect(payload?.presentation).toMatchObject({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              action: {
                type: "approval",
                approvalId: "exec-1",
                approvalKind: "exec",
                decision: "allow-once",
              },
            },
            {
              action: {
                type: "approval",
                approvalId: "exec-1",
                approvalKind: "exec",
                decision: "deny",
              },
            },
          ],
        },
      ],
    });
  });

  it("renders target-mode plugin prompts with concrete thumbs-only reaction choices", () => {
    const cfg = buildConfig({
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "whatsapp", to: "+15551230000" }],
        },
      },
    });
    const request = buildPluginRequest("+15551230000", {
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    const payload = whatsappApprovalCapability.render?.plugin?.buildPendingPayload?.({
      cfg,
      request,
      target: { channel: "whatsapp", to: "+15551230000", source: "target" },
      nowMs: 0,
    });

    expect(payload?.text).toContain("/approve plugin:approval-1 allow-once");
    expect(payload?.text).toContain(
      "Reply with: /approve plugin:approval-1 allow-once|allow-always|deny",
    );
    expect(payload?.text).toContain("React with:");
    expect(payload?.text).toContain("👍 Allow Once");
    expect(payload?.text).toContain("👎 Deny");
    expect(payload?.text).not.toContain("1️⃣ Allow Once");
    expect(payload?.text).not.toContain("2️⃣ Allow Always");
    expect(payload?.text).not.toContain("3️⃣ Deny");
    expect(payload?.text).not.toContain("<id>");
    expect(payload?.presentation).toMatchObject({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              action: {
                type: "approval",
                approvalId: "plugin:approval-1",
                approvalKind: "plugin",
                decision: "allow-once",
              },
            },
            {
              action: {
                type: "approval",
                approvalId: "plugin:approval-1",
                approvalKind: "plugin",
                decision: "allow-always",
              },
            },
            {
              action: {
                type: "approval",
                approvalId: "plugin:approval-1",
                approvalKind: "plugin",
                decision: "deny",
              },
            },
          ],
        },
      ],
    });
  });

  it(
    "does not report target-mode availability when no WhatsApp target matches",
    checks.noMatchingTarget,
  );

  it("applies agent and session filters to native handling", checks.requestFilters);

  it(
    "matches account-scoped top-level WhatsApp targets only for that account",
    checks.accountScopedTargets,
  );

  it(
    "suppresses forwarding fallback only when the exact session-origin native target matches",
    checks.exactSessionTarget,
  );

  it(
    "does not suppress target-only forwarding when native delivery cannot bind that target",
    checks.targetOnlyFallback,
  );

  it(
    "suppresses both-mode explicit targets that omit the origin account id",
    checks.unscopedBothTarget,
  );

  it(
    "suppresses both-mode unscoped targets through the configured default WhatsApp account",
    checks.defaultAccountBothTarget,
  );

  it("allows group-origin emoji approvals only after exec forwarding and approvers are configured", () => {
    const request = buildExecRequest("120363401234567890@g.us");
    const withoutApprovers = buildConfig({ approvals: { exec: { enabled: true } } });
    const withApprovers = buildConfig({
      channel: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });

    expect(
      whatsappApprovalCapability.native?.resolveOriginTarget?.({
        cfg: withoutApprovers,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toBeNull();
    expect(
      whatsappApprovalCapability.native?.resolveOriginTarget?.({
        cfg: withApprovers,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      to: "120363401234567890@g.us",
      accountId: "default",
    });
  });
});
