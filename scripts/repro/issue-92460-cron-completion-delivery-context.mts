// Standalone reproduction for issue #92460.
//
// Verifies that a resolved cron delivery target is written back to the isolated
// cron session entry's deliveryContext, so completion-announce paths can recover
// an explicit delivery.channel without falling back to a channel-less main session.

import type { SessionEntry } from "../../src/config/sessions.js";
import { setCronSessionDeliveryContextFromResolvedDelivery } from "../../src/cron/isolated-agent/run-session-state.js";

const entry: SessionEntry = {
  sessionId: "repro-run",
  updatedAt: Date.now(),
  systemSent: true,
};

setCronSessionDeliveryContextFromResolvedDelivery(entry, {
  ok: true,
  channel: "webchat",
  to: "controller",
  accountId: "default",
  threadId: "thread-42",
  mode: "explicit",
});

console.log("=== Reproduction for issue #92460 ===");
console.log(
  "Isolated cron session deliveryContext:",
  JSON.stringify(entry.deliveryContext, null, 2),
);

const ok =
  entry.deliveryContext?.channel === "webchat" &&
  entry.deliveryContext?.to === "controller" &&
  entry.deliveryContext?.accountId === "default" &&
  entry.deliveryContext?.threadId === "thread-42";

if (ok) {
  console.log("PASS: explicit delivery.channel survives to the session entry deliveryContext");
  process.exitCode = 0;
} else {
  console.error(
    "FAIL: expected deliveryContext { channel: webchat, to: controller, accountId: default, threadId: thread-42 }",
  );
  process.exitCode = 1;
}
