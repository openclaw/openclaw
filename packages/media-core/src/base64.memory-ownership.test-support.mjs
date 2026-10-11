import { fullGC } from "bun:jsc";
import assert from "node:assert/strict";
import { measureBase64Memory } from "./base64.memory.test-support.ts";

// JSC can defer charging existing string backing until the next collection.
// Keep a collected heap plus an uncollected predecessor alive in this VM only.
const retained = {};
globalThis.base64MemoryPredecessor = retained;
retained.ballast = Buffer.alloc(128 * 1024 * 1024, 0x42).toString("latin1");
fullGC();
retained.predecessor = Buffer.alloc(48 * 1024 * 1024, 0x50).toString("latin1");
const pending = measureBase64Memory("shredded");
fullGC();
const measured = await pending;
assert.equal(retained.ballast.length, 128 * 1024 * 1024);
assert.equal(retained.predecessor.length, 48 * 1024 * 1024);
assert.ok(
  measured.vmDelta < 64 * 1024 * 1024,
  "Another VM's collection was charged to the decoder",
);
