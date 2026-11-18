import assert from "node:assert/strict";
import fs from "node:fs";
import { createHarness } from "./gateway.mjs";

const harness = await createHarness();
const requests = () =>
  fs.readFileSync(process.env.MUSE_REQUEST_LOG, "utf8").trim().split("\n").filter(Boolean);
// Consent means unrestricted: Muse must not prompt for approval it cannot route.
const lastApprovalMode = () =>
  requests()
    .map((line) => JSON.parse(line))
    .findLast((request) => request.method === "session/start")?.params.approvalMode;
try {
  await harness.start();
  // Remembered setup consent under a tool policy Muse cannot enforce: an owner's unset-mode
  // chat dispatches, while a non-owner and a removed consent are refused before Muse I/O.
  await harness.stop();
  harness.config.tools = { allow: ["message"], exec: { security: "full", ask: "on-miss" } };
  harness.config.agents.entries = { main: { nativeRuntimeConsent: ["muse"] } };
  harness.saveConfig();
  await harness.start();
  const owned = await harness.turn("hello owner", { key: "agent:main:consent-owner" });
  assert.match(owned.text, /^started: /);
  assert.equal(lastApprovalMode(), "allowAll");
  console.log("PASS owner turn with unset modes dispatches in full mode under remembered consent");
  const guest = await harness.connect(["operator.read", "operator.write"]);
  try {
    const count = requests().length;
    // Admission rejects the send itself, so no run starts.
    await assert.rejects(
      harness.turn("hello guest", { via: guest, key: "agent:main:consent-guest" }),
      (error) => error.details?.code === "AGENT_RUNTIME_RESTRICTED",
    );
    assert.equal(requests().length, count, "a non-owner turn must not reach Muse");
    console.log("PASS non-owner turn refused before Muse I/O");
    // Stored explicit Full access keeps its existing meaning for any sender.
    await harness.client.request("sessions.patch", {
      key: "agent:main:consent-full",
      permissionMode: "full",
      sandboxMode: "off",
    });
    const full = await harness.turn("hello full", { via: guest, key: "agent:main:consent-full" });
    assert.match(full.text, /^started: /);
    console.log("PASS explicit Full access chat keeps remembered consent");
  } finally {
    guest.stop();
  }
  await harness.stop();
  harness.config.agents.entries.main.nativeRuntimeConsent = [];
  harness.saveConfig();
  await harness.start();
  const count = requests().length;
  await assert.rejects(
    harness.turn("hello revoked", { key: "agent:main:consent-owner" }),
    (error) => error.details?.code === "AGENT_RUNTIME_RESTRICTED",
  );
  assert.equal(requests().length, count, "removed consent must not reach Muse");
  console.log("PASS removed consent refused before Muse I/O");
  console.log("Muse remembered-consent Docker E2E passed");
} finally {
  await harness.stop();
}
