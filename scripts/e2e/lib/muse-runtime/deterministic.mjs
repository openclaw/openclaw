import assert from "node:assert/strict";
import fs from "node:fs";
import { createHarness } from "./gateway.mjs";

const harness = await createHarness();
const requests = () =>
  fs
    .readFileSync(process.env.MUSE_REQUEST_LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
const methods = (method) => requests().filter((row) => row.method === method);
try {
  await harness.start();
  assert.match((await harness.turn("hello")).text, /started: hello/);
  assert.equal(methods("initialize").length, 1);
  const first = methods("session/start");
  assert.equal(first.length, 1);
  assert.deepEqual(
    Object.fromEntries(
      ["providerId", "workspaceRoot", "modelId", "approvalMode"].map((key) => [
        key,
        first[0].params[key],
      ]),
    ),
    {
      providerId: "meta",
      workspaceRoot: harness.workspace,
      modelId: "muse-spark-1.3",
      approvalMode: "promptUnmatched",
    },
  );
  const sessionId = methods("turn/start")[0].params.sessionId;
  assert.match((await harness.turn("hello again")).text, /started: hello/);
  assert.equal(methods("session/start").length, 1);
  assert.equal(methods("turn/start").at(-1).params.sessionId, sessionId);
  console.log("PASS fresh session and cached native session reuse");
  await harness.start();
  assert.match((await harness.turn("hello after restart")).text, /resumed: hello/);
  assert.equal(methods("session/resume").at(-1).params.sessionId, sessionId);
  console.log("PASS durable native session resume after Gateway restart");
  const allowed = await harness.turn("fixture:approval", { decision: "allow-once" });
  // A failed first attempt is retried by the Gateway with a fresh session; the
  // approval must succeed on the original native session without an interrupt.
  assert.equal(methods("session/start").length, 1);
  assert.equal(methods("turn/interrupt").length, 0);
  assert.equal(allowed.approvals.length, 1);
  assert.equal(methods("approval/decide").at(-1).params.choiceId, "server-allow-id");
  const denied = await harness.turn("fixture:approval", { decision: "deny", expectError: true });
  assert.equal(denied.approvals.length, 1);
  assert.equal(methods("approval/decide").at(-1).params.choiceId, "server-deny-id");
  assert.notEqual(denied.wait.status, "ok");
  console.log("PASS native approval allow and deny choice IDs");
  await harness.client.request("sessions.reset", { key: harness.sessionKey });
  assert.match((await harness.turn("hello reset")).text, /started: hello/);
  assert.equal(methods("session/start").length, 2);
  assert.notEqual(methods("turn/start").at(-1).params.sessionId, sessionId);
  console.log("PASS session reset creates fresh native session");
  await harness.stop();
  harness.config.tools.exec.security = "allowlist";
  harness.saveConfig();
  const before = requests().length;
  await harness.start();
  const refused = await harness.turn("hello refused", { expectError: true });
  assert.notEqual(refused.wait.status, "ok");
  assert.match(`${refused.text} ${JSON.stringify(refused.wait)}`, /allowlist/i);
  assert.equal(requests().length, before, "refusal must not start or contact a Muse process");
  console.log("PASS exec allowlist refusal before spawning Muse");
  console.log("Muse runtime Docker E2E passed");
} finally {
  await harness.stop();
}
