// Real native stdout, independent of browser/automation scheduling.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.argv[2];
assert(root, "producer requires its exclusively owned artifact directory");
const chunks = 512;
const chunkBytes = 4096;
const intervalMs = 20;
const deadline = Date.now() + 120_000;
const waitFor = async (name) => {
  while (!existsSync(path.join(root, name))) {
    assert(Date.now() < deadline, `producer timed out waiting for ${name}`);
    await delay(5);
  }
};
writeFileSync(path.join(root, "producer-ready"), "ready\n");
await waitFor("producer-start");
const receipts = [];
const hash = createHash("sha256");
const start = process.hrtime.bigint();
for (let index = 0; index < chunks; index++) {
  const plannedMs = index * intervalMs;
  const remaining = plannedMs - Number(process.hrtime.bigint() - start) / 1e6;
  if (remaining > 0) {
    await delay(remaining);
  }
  const marker = `output-${String(index).padStart(6, "0")}:`;
  const row = `${marker}${"x".repeat(79 - marker.length)}\n`;
  const text = `${row.repeat(50)}${"x".repeat(chunkBytes - 4000 - marker.length - 1)}${marker}\n`;
  assert.equal(Buffer.byteLength(text), chunkBytes);
  hash.update(text);
  const beforeNs = process.hrtime.bigint().toString();
  await new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
  receipts.push({ index, plannedMs, beforeNs, afterNs: process.hrtime.bigint().toString() });
}
writeFileSync(
  path.join(root, "producer-receipt.json"),
  JSON.stringify({
    chunks,
    chunkBytes,
    intervalMs,
    startNs: start.toString(),
    sha256: hash.digest("hex"),
    receipts,
  }),
);
// Hold completion so the running preview can be checked independently of final reconciliation.
await waitFor("producer-finish");
