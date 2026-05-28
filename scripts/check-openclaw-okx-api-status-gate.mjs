import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildOkxApiStatusGate } from "./openclaw-okx-api-status-gate.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:api-status"],
  "node scripts/openclaw-okx-api-status-gate.mjs --write-state --json",
);
assert.equal(
  scripts["okx:api-status:check"],
  "node scripts/check-openclaw-okx-api-status-gate.mjs",
);

const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-api-status-gate-latest.json",
);
const report = await buildOkxApiStatusGate();

assert.equal(report.schema, "openclaw.okx.api-status-gate.v1");
assert.equal(report.provider, "okx");
assert.equal(report.language, "zh-TW");
assert.ok(
  [
    "read_only_live_and_demo_verified",
    "read_only_demo_verified_live_blocked",
    "blocked_or_degraded",
  ].includes(report.status),
);
assert.equal(report.cli.available, true);
assert.match(report.cli.version, /^\d+\.\d+\.\d+$/u);
assert.equal(report.config.checked, true);
assert.ok(report.config.configuredProfiles.includes("demo"));
assert.ok(
  report.config.configuredProfiles.some((profile) => profile === "main" || profile === "live"),
);
assert.equal(report.config.configMaskedOnly, true);
assert.ok(report.markers.includes(report.authentication.demo.code));
assert.ok(report.markers.includes(report.authentication.live.code));
assert.ok(report.markers.includes(report.quote.code));
assert.ok(report.markers.includes(report.openclawSkill.code));
assert.equal(report.openclawSkill.code, "openclaw_skill_ok");
assert.equal(report.openclawSkill.path, "skills/openclaw-okx-cex-status/SKILL.md");
assert.equal(report.openclawSkill.exists, true);
assert.equal(report.openclawSkill.readOnlyDeclared, true);
assert.equal(report.openclawSkill.localConfigOnlyDeclared, true);
assert.equal(report.openclawSkill.noOrderDeclared, true);
assert.equal(report.openclawSkill.noCodexGlobalRuntimeDeclared, true);
assert.equal(report.openclawSkill.commandsDeclared, true);
assert.ok(report.markers.includes("order_not_enabled"));
const hasChatSuppliedSecretMarker = report.markers.includes("chat_supplied_secret_must_rotate");
const hasWithdrawPermissionMarker = report.markers.includes("withdraw_permission_blocked");
const hasBlankIpMarker = report.markers.includes("blank_ip_with_trade_or_withdraw_blocked");
assert.equal(hasChatSuppliedSecretMarker, !report.credentialPolicy.chatPostedKeyRotated);
assert.equal(hasWithdrawPermissionMarker, !report.credentialPolicy.withdrawPermissionAbsent);
assert.equal(hasBlankIpMarker, !report.credentialPolicy.ipAllowlistSafe);
assert.ok(Array.isArray(report.blockers));
assert.match(report.authentication.demo.code, /^demo_(ok|401|missing|blocked)$/u);
assert.match(report.authentication.live.code, /^live_(ok|401|missing|blocked)$/u);
assert.equal(report.quote.code, "quote_ok");
assert.equal(report.quote.readOnly, true);
assert.equal(report.quote.symbol, "BTC-USDT");
assert.equal(report.quote.source, "okx_market_ticker");
assert.ok(Number(report.quote.last) > 0);
assert.equal(report.agentTradeKit.source, "official_okx_agent_trade_kit");
assert.equal(report.agentTradeKit.mcpCompatible, true);
assert.equal(report.agentTradeKit.cliCompatible, true);
assert.equal(report.agentTradeKit.requiredProfileForAuthenticatedCommands, true);
assert.equal(report.agentTradeKit.demoProfile, "demo");
assert.ok(report.agentTradeKit.officialDocs.includes("https://github.com/okx/agent-trade-kit"));
assert.equal(
  report.agentTradeKit.externalResearchReport,
  "reports/hermes-agent/state/openclaw-auto-trading-external-research-latest.md",
);
assert.equal(report.config.localConfigExists, true);
assert.ok(report.config.localConfigPathHint);
for (const profile of ["main", "demo"]) {
  const fields = report.config.profileFields[profile];
  assert.equal(fields?.apiKeyPresent, true);
  assert.equal(fields?.secretKeyPresent, true);
  assert.equal(fields?.passphrasePresent, true);
}
assert.equal(report.safety.orderPlacementEnabled, false);
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeTradingEnabled, false);
assert.equal(report.safety.withdrawalEnabled, false);
assert.equal(report.safety.submittedOrder, false);
assert.equal(report.safety.cancelOrderEnabled, false);
assert.equal(report.safety.amendOrderEnabled, false);
assert.equal(report.safety.readOnlyCommandsOnly, true);
assert.equal(report.safety.credentialEchoed, false);
assert.equal(report.safety.acceptsChatProvidedSecrets, false);
assert.equal(report.safety.storesSecretsInRepo, false);
assert.equal(report.safety.allowsWithdrawPermission, false);
assert.equal(report.safety.allowsBlankIpWithWritePermission, false);
assert.equal(report.credentialPolicy.passphraseRequired, true);
assert.equal(report.credentialPolicy.localConfigOnly, true);
assert.ok(
  ["reject_and_rotate", "rotated_local_only_verified"].includes(
    report.credentialPolicy.chatProvidedCredentialAction,
  ),
);
assert.deepEqual(report.credentialPolicy.allowedPermissionSetBeforePromotion, ["read"]);
assert.ok(report.credentialPolicy.blockedPermissionSetBeforePromotion.includes("withdraw"));
assert.equal(report.credentialPolicy.ipAllowlistRequiredForTradeOrWithdraw, true);
assert.equal(
  report.credentialPolicy.keyPostedInChatMustBeRevoked,
  !report.credentialPolicy.chatPostedKeyRotated,
);
assert.ok(
  [
    "rotation_receipt_missing",
    "rotation_receipt_invalid_json",
    "rotation_receipt_incomplete",
    "rotation_receipt_ok",
  ].includes(report.credentialPolicy.rotationReceipt.code),
);
assert.ok(report.commands.executed.every((command) => !/\b(place|cancel|amend)\b/u.test(command)));
assert.ok(report.commands.forbidden.some((command) => command === "okx spot place"));
assert.match(report.summary_zh_tw, /quote=quote_ok/u);
assert.match(report.summary_zh_tw, /skill=openclaw_skill_ok/u);
assert.match(report.summary_zh_tw, /order=order_not_enabled/u);
assert.match(report.summary_zh_tw, /policy=(secret_rotation_required|credential_policy_ok)/u);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-okx-rotation-"));
const tempReceiptPath = path.join(tempDir, "receipt.json");
await fs.writeFile(
  tempReceiptPath,
  `${JSON.stringify(
    {
      schema: "openclaw.okx.credential-rotation-receipt.v1",
      createdAt: new Date(0).toISOString(),
      revokedChatSuppliedKey: true,
      newKeyStoredLocalOnly: true,
      newKeyNeverPastedToChat: true,
      permissionSet: ["read"],
      tradePermission: false,
      withdrawPermission: false,
      ipAllowlistConfigured: false,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const previousReceiptPath = process.env.OPENCLAW_OKX_ROTATION_RECEIPT_PATH;
process.env.OPENCLAW_OKX_ROTATION_RECEIPT_PATH = tempReceiptPath;
try {
  const rotatedReport = await buildOkxApiStatusGate();
  assert.equal(
    rotatedReport.credentialPolicy.chatProvidedCredentialAction,
    "rotated_local_only_verified",
  );
  assert.equal(rotatedReport.credentialPolicy.keyPostedInChatMustBeRevoked, false);
  assert.equal(rotatedReport.credentialPolicy.chatPostedKeyRotated, true);
  assert.equal(rotatedReport.credentialPolicy.withdrawPermissionAbsent, true);
  assert.equal(rotatedReport.credentialPolicy.ipAllowlistSafe, true);
  assert.equal(rotatedReport.credentialPolicy.rotationReceipt.exists, true);
  assert.equal(rotatedReport.credentialPolicy.rotationReceipt.code, "rotation_receipt_ok");
  assert.equal(rotatedReport.markers.includes("chat_supplied_secret_must_rotate"), false);
  assert.equal(rotatedReport.markers.includes("withdraw_permission_blocked"), false);
  assert.equal(rotatedReport.markers.includes("blank_ip_with_trade_or_withdraw_blocked"), false);
  assert.match(rotatedReport.summary_zh_tw, /policy=credential_policy_ok/u);
} finally {
  if (previousReceiptPath === undefined) {
    delete process.env.OPENCLAW_OKX_ROTATION_RECEIPT_PATH;
  } else {
    process.env.OPENCLAW_OKX_ROTATION_RECEIPT_PATH = previousReceiptPath;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const payload = `${JSON.stringify(report, null, 2)}\n`;
await fs.writeFile(reportPath, payload, "utf8");
await fs.writeFile(
  `${reportPath}.sha256`,
  `${crypto.createHash("sha256").update(payload).digest("hex").toUpperCase()}\n`,
  "ascii",
);

process.stdout.write(
  [
    "OKX_API_STATUS_GATE_CHECK=OK",
    `status=${report.status}`,
    `markers=${report.markers.join("/")}`,
    `blockers=${report.blockers.join("/")}`,
    `summary=${report.summary_zh_tw}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
