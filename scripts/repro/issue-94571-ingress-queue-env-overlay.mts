#!/usr/bin/env node
/**
 * Live repro for issue #94571: Telegram isolated ingress copies large process.env
 * in the queue hot path.
 *
 * Verifies that createChannelIngressQueue with a custom stateDir does not
 * enumerate and copy the full process environment on every queue operation.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChannelIngressQueue } from "../../src/channels/message/ingress-queue.js";

let readCount = 0;
const originalEnv = process.env;
// Proxy every env read so we can detect enumeration/copies.
const instrumentedEnv = new Proxy(originalEnv, {
  get(target, prop) {
    if (typeof prop === "string") {
      readCount++;
    }
    return Reflect.get(target, prop);
  },
});

process.env = instrumentedEnv;

async function main() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repro-94571-"));
  const calls = 1000;

  const queue = createChannelIngressQueue<{ index: number }>({
    channelId: "telegram",
    accountId: "default",
    stateDir,
    now: () => Date.now(),
  });

  readCount = 0;
  for (let i = 0; i < calls; i++) {
    await queue.listPending();
  }

  await fs.rm(stateDir, { recursive: true, force: true });

  console.log("=== Reproduction for issue #94571 ===");
  console.log(`Queue operations: ${calls}`);
  console.log(`Total env reads: ${readCount}`);
  console.log(`Reads per operation: ${(readCount / calls).toFixed(2)}`);

  // With the old `{ ...process.env }` implementation each operation copied every
  // key. With the overlay implementation only the handful of keys used for path
  // resolution are read.
  if (readCount > calls * 5) {
    console.error("FAIL: the queue appears to copy or enumerate process.env on each call.");
    process.exitCode = 1;
  } else {
    console.log("PASS: queue operations do not enumerate the full process environment.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
