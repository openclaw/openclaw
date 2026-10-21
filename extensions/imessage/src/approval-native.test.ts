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

const DEFAULT_ACCOUNT_ID = "default";
const DIRECT_TARGET = "+15551230000";
const execConfig = (allowFrom?: string[]) =>
  approval.buildConfig({
    approvals: { exec: { enabled: true } },
    channel: { allowFrom },
  });
const target = { channel: "imessage", to: DIRECT_TARGET, source: "target" } as const;

it("uses target-mode config for requestless availability without native runtime handling", () =>
  approval.checks.targetMode());

it("renders thumbs-only reaction hints in plugin approval prompts and respects allowed decisions", () => {
  const payload = imessageApprovalCapability.render?.plugin?.buildPendingPayload?.({
    cfg: approval.buildConfig(),
    request: approval.buildPluginRequest(DIRECT_TARGET, {
      allowedDecisions: ["allow-once", "deny"],
    }),
    target,
    nowMs: 0,
  });

  expect(payload?.text).toContain("👍 Allow Once");
  expect(payload?.text).toContain("👎 Deny");
  expect(payload?.text).not.toContain("Allow Always");
});

it("renders target-mode exec prompts with concrete thumbs-only reaction choices", () => {
  const text =
    imessageApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg: approval.buildTargetModeConfig("exec", [target]),
      request: approval.buildExecRequest(DIRECT_TARGET, {
        ask: "always",
        cwd: "/tmp/work",
        host: "gateway",
      }),
      target,
      nowMs: 0,
    })?.text ?? "";

  for (const hint of ["/approve exec-1 allow-once", "React with:", "👍 Allow Once", "👎 Deny"]) {
    expect(text).toContain(hint);
  }
  for (const obsolete of ["<id>", "1️⃣ Allow Once", "2️⃣ Allow Always", "3️⃣ Deny"]) {
    expect(text).not.toContain(obsolete);
  }
  expect(text.indexOf("React with:")).toBeLessThan(text.indexOf("/approve exec-1 allow-once"));
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
    accountId: DEFAULT_ACCOUNT_ID,
  });
});
it(
  "keeps local prompts for disabled, target-only, inactive, or non-exec cases",
  local.checks.inactiveRoutes,
);

it.each([
  ["imessage:+15551230000", undefined, true],
  ["imessage:direct:+15551230000", DEFAULT_ACCOUNT_ID, true],
  ["imessage:default:direct:+15551230000", DEFAULT_ACCOUNT_ID, true],
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

it(
  "applies top-level approval filters with agent fallback from session key",
  local.checks.sessionFilters,
);
