import assert from "node:assert/strict";
import { buildCapitalHftCompatibility } from "./openclaw-capital-brokerdesk-compatibility.mjs";

const report = await buildCapitalHftCompatibility();

assert.equal(report.schema, "openclaw.capital.capital-hft-compatibility.v1");
assert.equal(report.status, "passed");
assert.equal(report.policy.preferredPrefix, "capital:*");
assert.equal(report.policy.legacyPrefix, "capital-hft:*");
assert.equal(report.policy.capitalHftPolicy, "compatibility_alias_only");
assert.equal(report.policy.keepLegacyAliases, true);
assert.equal(report.policy.removeLegacyAliases, false);
assert.ok(report.summary.capitalHftScriptCount > 0);
assert.equal(report.summary.requiredAliasCount, report.aliases.length);
assert.equal(report.summary.mismatchCount, 0);
assert.equal(report.summary.passedAliasCount, report.summary.requiredAliasCount);
assert.deepEqual(report.failures, []);
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.sentOrder, false);

process.stdout.write(
  [
    "CAPITAL_HFT_COMPATIBILITY_CHECK=OK",
    `capitalHftScriptCount=${report.summary.capitalHftScriptCount}`,
    `requiredAliasCount=${report.summary.requiredAliasCount}`,
    `preferred=${report.policy.preferredPrefix}`,
    `legacy=${report.policy.legacyPrefix}`,
  ].join("\n") + "\n",
);
