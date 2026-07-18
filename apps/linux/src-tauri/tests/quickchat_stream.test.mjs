import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const quickchatSource = readFileSync(new URL("../../ui/quickchat.js", import.meta.url), "utf8");
const browserBindingsStart = quickchatSource.indexOf("const tauri = window");
assert.notEqual(browserBindingsStart, -1, "quickchat pure-helper boundary");

const context = {};
vm.runInNewContext(
  `${quickchatSource.slice(0, browserBindingsStart)}\nthis.helpers = { assembleChatDelta };`,
  context,
);
const { assembleChatDelta } = context.helpers;

test("replace deltas are authoritative", () => {
  assert.equal(
    assembleChatDelta("stale", {
      deltaText: "replacement",
      replace: true,
      message: { content: [{ text: "ignored snapshot" }] },
    }),
    "replacement",
  );
});

test("the first delta seeds from its message snapshot", () => {
  assert.equal(
    assembleChatDelta(null, {
      deltaText: "lo",
      message: { content: [{ text: "Hello" }] },
    }),
    "Hello",
  );
  assert.equal(assembleChatDelta(null, { deltaText: "Hi" }), "Hi");
});

test("matching deltas append and mismatched snapshots self-heal", () => {
  assert.equal(
    assembleChatDelta("Hello", {
      deltaText: "!",
      message: { content: [{ text: "Hello!" }] },
    }),
    "Hello!",
  );
  assert.equal(
    assembleChatDelta("Hellx", {
      deltaText: "!",
      message: { content: [{ text: "Hello!" }] },
    }),
    "Hello!",
  );
});

test("snapshot-only terminal frames replace the assembled text", () => {
  assert.equal(
    assembleChatDelta("partial", { message: { content: [{ text: "complete" }] } }),
    "complete",
  );
});
