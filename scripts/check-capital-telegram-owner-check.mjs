import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCapitalTelegramOwnerCheck,
  readCapitalTelegramOwnerCheck,
  writeCapitalTelegramOwnerCheck,
} from "./openclaw-capital-telegram-owner-check.mjs";

const repoRoot = process.cwd();

const ready = buildCapitalTelegramOwnerCheck({
  ready: true,
  telegramPoller: {
    available: true,
    pollingEnabled: false,
    pollingOwner: "openclaw_gateway",
    pollState: "disabled_by_owner_gate",
    duplicatePollerDetected: false,
    summary: "send-only:openclaw_gateway",
  },
});
assert.equal(ready.schema, "openclaw.capital.telegram-owner-check.v1");
assert.equal(ready.status, "ready_single_owner");
assert.equal(ready.ready, true);
assert.equal(ready.receiver, "openclaw_gateway");
assert.equal(ready.capitalMode, "send-only");
assert.equal(ready.secondPoller, "無");
assert.equal(ready.blockerCode, "");
assert.match(ready.replyLine, /OpenClaw Telegram 自檢/u);
assert.match(ready.replyLine, /收訊入口=OpenClaw Gateway/u);
assert.match(ready.replyLine, /CapitalHftService=send-only/u);
assert.match(ready.replyLine, /第二個poller=無/u);
assert.match(ready.replyLine, /真單=封鎖/u);

const capitalPolling = buildCapitalTelegramOwnerCheck({
  telegramPoller: {
    available: true,
    pollingEnabled: true,
    pollingOwner: "capital_hft_service",
    pollState: "running",
    duplicatePollerDetected: false,
    summary: "衝突:capital_polling_enabled:capital_hft_service",
  },
});
assert.equal(capitalPolling.status, "blocked_capital_polling_enabled");
assert.equal(capitalPolling.ready, false);
assert.equal(capitalPolling.blockerCode, "capital_telegram_polling_enabled");
assert.equal(capitalPolling.secondPoller, "風險");
assert.match(capitalPolling.replyLine, /用不帶 --telegram-polling/u);

const duplicate = buildCapitalTelegramOwnerCheck({
  telegramPoller: {
    available: true,
    pollingEnabled: false,
    pollingOwner: "openclaw_gateway",
    pollState: "duplicate_poller_detected",
    duplicatePollerDetected: true,
    summary: "衝突:duplicate_poller_detected",
  },
});
assert.equal(duplicate.status, "blocked_duplicate_poller");
assert.equal(duplicate.blockerCode, "duplicate_poller_detected");
assert.equal(duplicate.secondPoller, "有");

const live = await readCapitalTelegramOwnerCheck({ repoRoot });
assert.equal(live.readOnly, true);
assert.equal(live.liveTradingEnabled, false);
assert.equal(live.writeTradingEnabled, false);
assert.match(live.replyLine, /OpenClaw Telegram 自檢/u);
if (live.poller.available) {
  assert.equal(live.poller.pollingEnabled, false);
  assert.equal(live.poller.pollingOwner, "openclaw_gateway");
  assert.equal(live.poller.duplicatePollerDetected, false);
}

const outputs = await writeCapitalTelegramOwnerCheck(live, { repoRoot });
await fs.access(outputs.panelPath);
await fs.access(`${outputs.panelPath}.sha256`);
await fs.access(outputs.reportPath);
await fs.access(`${outputs.reportPath}.sha256`);

const panel = JSON.parse(await fs.readFile(outputs.panelPath, "utf8"));
assert.equal(panel.schema, live.schema);
assert.equal(panel.replyLine, live.replyLine);
if (!path.resolve(outputs.panelPath).includes(`${path.sep}.openclaw${path.sep}quote${path.sep}`)) {
  throw new Error(`owner panel path is not under .openclaw/quote: ${outputs.panelPath}`);
}

const missingCapitalRoot = path.join(os.tmpdir(), "openclaw-capital-telegram-owner-missing");
const ownerCli = path.join(repoRoot, "scripts", "openclaw-capital-telegram-owner-check.mjs");
const blockedCli = spawnSync(
  process.execPath,
  [ownerCli, "--repo-root", repoRoot, "--capital-root", missingCapitalRoot, "--json"],
  { cwd: repoRoot, encoding: "utf8" },
);
assert.equal(blockedCli.status, 0, blockedCli.stderr || blockedCli.stdout);
assert.match(blockedCli.stdout, /"status": "degraded_missing_telegram_status"/u);

const strictBlockedCli = spawnSync(
  process.execPath,
  [
    ownerCli,
    "--repo-root",
    repoRoot,
    "--capital-root",
    missingCapitalRoot,
    "--json",
    "--strict-exit",
  ],
  { cwd: repoRoot, encoding: "utf8" },
);
assert.equal(strictBlockedCli.status, 2, strictBlockedCli.stderr || strictBlockedCli.stdout);
assert.match(strictBlockedCli.stdout, /"status": "degraded_missing_telegram_status"/u);

process.stdout.write("capital telegram owner check PASS\n");
