// Slack tests cover typed command-owner fallback for native exec approvals.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it } from "vitest";
import { slackApprovalCapability } from "./approval-native.js";
import { buildConfig, createExecApprovalRequest } from "./approval-native.test-support.js";

it("lets only the current typed Slack owner approve owner-derived exec requests", async () => {
  const cfg = {
    ...buildConfig({
      execApprovals: { enabled: "auto", target: "dm" },
      accounts: {
        ops: {
          botToken: "xoxb-ops",
          appToken: "xapp-ops",
          execApprovals: { enabled: "auto", approvers: ["U0777OTHER"], target: "dm" },
        },
      },
    }),
    commands: { ownerAllowFrom: ["slack:user:U0123ABCD"] },
  } as OpenClawConfig;
  const authorize = async (
    senderId: string,
    options: { cfg?: OpenClawConfig; accountId?: string } = {},
  ) =>
    (
      await slackApprovalCapability.authorizeActorActionAsync?.({
        cfg: options.cfg ?? cfg,
        accountId: options.accountId ?? "default",
        senderId,
        action: "approve",
        approvalKind: "exec",
      })
    )?.authorized;

  expect(
    await slackApprovalCapability.nativeAsync?.resolveApproverDmTargets?.({
      cfg,
      accountId: "default",
      approvalKind: "exec",
      request: createExecApprovalRequest(),
    }),
  ).toEqual([{ to: "user:U0123ABCD" }]);
  expect(await authorize("U0123ABCD")).toBe(true);
  expect(await authorize("U0666NOPE")).toBe(false);
  // Explicit account approvers still replace the global owner fallback.
  expect(await authorize("U0123ABCD", { accountId: "ops" })).toBe(false);
  // Authority is read from the config current at decision time.
  expect(
    await authorize("U0123ABCD", {
      cfg: { ...cfg, commands: { ownerAllowFrom: ["slack:user:U0888NEXT"] } },
    }),
  ).toBe(false);
});
