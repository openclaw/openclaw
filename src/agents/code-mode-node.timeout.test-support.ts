import assert from "node:assert/strict";
import { BroadcastChannel, getEnvironmentData } from "node:worker_threads";
import { CodeModeNodeProgress } from "./code-mode-node-progress.js";

const name: unknown = getEnvironmentData("openclaw.codeModeTimeoutOutputTest");
assert.ok(typeof name === "string", "The timeout fixture requires its output notification channel");
const channel = new BroadcastChannel(name);
channel.unref();

// The host advances the watchdog only after output publication, regardless of setup time.
const now = performance.now();
Object.defineProperty(performance, "now", { value: () => now });
// oxlint-disable-next-line typescript/unbound-method -- The intercepted instance is supplied below with .call.
const append = CodeModeNodeProgress.prototype.append;
let count = 0;
CodeModeNodeProgress.prototype.append = function (json) {
  append.call(this, json);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node BroadcastChannel has no targetOrigin.
  channel.postMessage(++count);
};

await import("./code-mode-node.worker.js");
