// Real behavior proof: a rejecting typing keepalive tick is caught and routed
// through onError instead of becoming an unhandled rejection.

import { createTypingKeepaliveLoop } from "../../src/channels/typing-lifecycle.js";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
  console.error("UNHANDLED_REJECTION:", String(reason));
};
process.on("unhandledRejection", onUnhandled);

const error = new Error("simulated typing tick failure");
const errors: unknown[] = [];

const loop = createTypingKeepaliveLoop({
  intervalMs: 10,
  onTick: async () => {
    throw error;
  },
  onError: (err) => {
    errors.push(err);
    console.log("Caught tick error:", String(err));
  },
});

loop.start();

setTimeout(() => {
  loop.stop();
  process.off("unhandledRejection", onUnhandled);

  if (unhandled.length > 0) {
    console.log("\nFAIL: unhandled rejections were leaked.");
    process.exitCode = 1;
    return;
  }
  if (errors.length === 0) {
    console.log("\nFAIL: onError was not called for the rejected tick.");
    process.exitCode = 1;
    return;
  }
  console.log("\nPASS: rejected tick was caught and reported via onError with no unhandled rejection.");
}, 100);
