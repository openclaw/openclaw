import {
  createNativeApprovalTestFixture,
  createLocalApprovalPromptTestFixture,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { expect, it } from "vitest";
import {
  imessageApprovalCapability,
  shouldSuppressLocalIMessageExecApprovalPrompt,
} from "./approval-native.js";

const approval = createNativeApprovalTestFixture({
  channel: "imessage",
  capability: imessageApprovalCapability,
  buildConfig: (options = {}) => {
    const { channel, approvals } = options;
    return {
      channels: { imessage: { enabled: true, ...channel } },
      approvals,
    };
  },
});
const local = createLocalApprovalPromptTestFixture({
  channel: "imessage",
  buildConfig: approval.buildConfig,
  suppress: shouldSuppressLocalIMessageExecApprovalPrompt,
});

const DIRECT_TARGET = "+15551230000";
const execConfig = (allowFrom?: string[]) =>
  approval.buildConfig({
    approvals: { exec: { enabled: true } },
    channel: { allowFrom },
  });
const target = { channel: "imessage", to: DIRECT_TARGET, source: "target" } as const;

it("uses target-mode config for requestless availability without native runtime handling", () =>
  approval.checks.targetMode());

it.each(["plugin", "exec"] as const)("renders %s prompts with allowed thumbs choices", (kind) => {
  const common = { target, nowMs: 0, cfg: approval.buildConfig() };
  const render = imessageApprovalCapability.render;
  const text =
    (kind === "plugin"
      ? render?.plugin?.buildPendingPayload?.({
          ...common,
          request: approval.buildPluginRequest(DIRECT_TARGET, {
            allowedDecisions: ["allow-once", "deny"],
          }),
        })
      : render?.exec?.buildPendingPayload?.({
          ...common,
          request: approval.buildExecRequest(DIRECT_TARGET, { ask: "always" }),
        })
    )?.text ?? "";
  expect(text).toContain("👍 Allow Once");
  expect(text).toContain("👎 Deny");
  if (kind === "plugin") {
    expect(text).not.toContain("Allow Always");
  } else {
    expect(text).toContain("/approve exec-1 allow-once");
    expect(text).toContain("React with:");
    expect(text).not.toMatch(/<id>|1️⃣ Allow Once|2️⃣ Allow Always|3️⃣ Deny/u);
    expect(text.indexOf("React with:")).toBeLessThan(text.indexOf("/approve exec-1 allow-once"));
  }
});

it.each([
  "chat_guid:iMessage;+;chat42",
  "chat_id:42",
  "chat_identifier:chat42",
  "chat_guid:iMessage;-;+15551230000",
])("requires explicit approvers for selector %s", async (to) => {
  const request = approval.buildExecRequest(to);
  expect(await approval.resolveExecOrigin(execConfig(), request)).toBeNull();
  expect(await approval.resolveExecOrigin(execConfig([DIRECT_TARGET]), request)).toEqual({
    to,
    accountId: "default",
  });
});
it("keeps local prompts on inactive routes", local.checks.inactiveRoutes);

it.each([
  ["imessage:+15551230000", undefined, true],
  ["imessage:direct:+15551230000", "default", true],
  ["imessage:default:direct:+15551230000", "default", true],
  ["imessage:group:test-group", undefined, false],
  ["imessage:chat_id:42", undefined, false],
  ["imessage:chat_guid:iMessage;+;chat42", undefined, false],
  ["imessage:chat_guid:iMessage;-;+15551230000", undefined, false],
  ["slack:C123", undefined, false],
  ["imessage:default:direct:+15551230000", "work", false],
] as const)("suppresses %s for account %s: %s", (route, accountId, suppressed) => {
  expect(local.suppressLocalSessionPrompt(execConfig(), `agent:main:${route}`, { accountId })).toBe(
    suppressed,
  );
});

it("filters local prompts by agent and session", local.checks.sessionFilters);
