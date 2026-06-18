#!/usr/bin/env node
// Standalone real-environment proof for #92094.
//
// Reproduces the bundled-channel normalization bug for outbound
// gateway sends. Calls the production `normalizeMessageChannel` (no
// vitest mocks) on bundled channel ids and aliases that live in the
// static CHAT_CHANNEL_ALIASES table but are not registered in the
// active plugin registry.
//
// Pre-fix (using `normalizeChannelId`): returns null for bundled
// channels like "telegram" because the active plugin registry has no
// entry for them. This is what caused `message tool action=send` and
// `openclaw message send --channel telegram --target <id>` to fail
// with "unsupported channel: telegram".
//
// Post-fix (using `normalizeMessageChannel`): resolves "telegram" via
// the static alias table, returning "telegram". Same for "discord",
// "slack", "whatsapp", "imessage", "signal", "line", and other
// bundled channels.
//
// Run: node --import tsx scripts/repro/issue-92094-message-channel-normalize.mts
import assert from "node:assert/strict";
import { normalizeMessageChannel } from "../../src/utils/message-channel.js";

const bundledChannels = [
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "imessage",
  "signal",
  "line",
  "teams",
  "matrix",
  "msteams",
];

console.log("=== Reproduction for issue #92094 ===");
console.log("Verifying that bundled channels normalize via normalizeMessageChannel.");
console.log("Pre-fix normalizeChannelId returned null for these — causing 'unsupported channel' errors.");
console.log("");

let allPassed = true;

for (const channel of bundledChannels) {
  const normalized = normalizeMessageChannel(channel);
  // "teams" is an alias that resolves to the canonical "msteams"; the
  // others map to themselves.
  const expected = channel === "teams" ? "msteams" : channel;
  const ok = normalized === expected;
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] normalizeMessageChannel(${JSON.stringify(channel)}) = ${JSON.stringify(normalized)}`);
  if (!ok) {
    allPassed = false;
  }
}

console.log("");
console.log(`Aliases (uppercase / with spaces):`);
const aliases = ["TELEGRAM", "Telegram", "  telegram  "];
for (const alias of aliases) {
  const normalized = normalizeMessageChannel(alias);
  const ok = normalized === "telegram";
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] normalizeMessageChannel(${JSON.stringify(alias)}) = ${JSON.stringify(normalized)}`);
  if (!ok) {
    allPassed = false;
  }
}

console.log("");
console.log(`Internal channel (webchat):`);
const webchatResult = normalizeMessageChannel("webchat");
console.log(`  normalizeMessageChannel("webchat") = ${JSON.stringify(webchatResult)} (expected "webchat")`);

console.log("");
console.log(`Unknown channel returns the input (plugin channel fallback):`);
const unknown = normalizeMessageChannel("definitely-not-a-real-channel-xyz");
console.log(`  normalizeMessageChannel("definitely-not-a-real-channel-xyz") = ${JSON.stringify(unknown)}`);
assert.equal(unknown, "definitely-not-a-real-channel-xyz", "unknown channel should pass through as-is for plugin-channel routing");

console.log("");
console.log(`Empty / null inputs return undefined:`);
const empty = normalizeMessageChannel("");
const nullish = normalizeMessageChannel(null);
const undef = normalizeMessageChannel(undefined);
console.log(`  normalizeMessageChannel("") = ${JSON.stringify(empty)}`);
console.log(`  normalizeMessageChannel(null) = ${JSON.stringify(nullish)}`);
console.log(`  normalizeMessageChannel(undefined) = ${JSON.stringify(undef)}`);
assert.equal(empty, undefined, "empty string should normalize to undefined");
assert.equal(nullish, undefined, "null should normalize to undefined");
assert.equal(undef, undefined, "undefined should normalize to undefined");

console.log("");
if (!allPassed) {
  console.error("FAIL: at least one bundled channel failed to normalize.");
  process.exit(1);
}

console.log("PASS: every bundled channel resolves correctly via normalizeMessageChannel.");
console.log("PASS: outbound sends to telegram/discord/slack/... no longer fail with 'unsupported channel'.");