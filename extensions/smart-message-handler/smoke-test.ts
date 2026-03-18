import assert from "node:assert/strict";
import { buildExecutionSignal, classifyExecutionIntent, classifyMessage } from "./index.ts";
import { DEFAULT_CONFIG } from "./src/types.ts";

const config = { ...DEFAULT_CONFIG };

// ---- Test: multi-agent message classification ----
const intent = classifyExecutionIntent(
  "真实执行一个多 agent 调研：\n1. 一个子 agent 查 issues；\n2. 一个子 agent 查 discussions；\n3. 主 agent 验收汇总。",
  config,
);

assert.equal(intent.execution_expected, true);
// After R1 stripping, requires_policy_gate and requires_delegation no longer exist
assert.equal("requires_policy_gate" in intent, false, "requires_policy_gate should be removed");
assert.equal("requires_delegation" in intent, false, "requires_delegation should be removed");

const signal = buildExecutionSignal(intent);
assert.notEqual(signal, null, "expected non-null signal for execution intent");
assert.match(signal!, /<kind>/);
assert.match(signal!, /<classifier_version>/);
// Signal should NOT contain policy/delegation XML anymore
assert.doesNotMatch(signal!, /policy_required/);
assert.doesNotMatch(signal!, /delegation_preferred/);

console.log("[PASS] multi-agent message classification (no policy gate)");

// ---- Test: "帮我找一下这个 bug？" -> debug (not search) ----
const bugIntent = classifyExecutionIntent("帮我找一下这个 bug？", config);
assert.equal(
  bugIntent.execution_kind,
  "debug",
  `Expected "debug" but got "${bugIntent.execution_kind}"`,
);

console.log("[PASS] bug classification -> debug");

// ---- Test: "你好" -> chat ----
const helloIntent = classifyExecutionIntent("你好", config);
assert.equal(
  helloIntent.execution_kind,
  "chat",
  `Expected "chat" but got "${helloIntent.execution_kind}"`,
);

console.log("[PASS] greeting -> chat");

// ---- Test: "帮我翻译一下这段代码。" -> NOT chat ----
const translateIntent = classifyExecutionIntent("帮我翻译一下这段代码。", config);
assert.notEqual(
  translateIntent.execution_kind,
  "chat",
  `"帮我翻译一下这段代码。" should not be chat`,
);

console.log("[PASS] translate code -> not chat");

// ---- Test: chat kind returns null signal ----
const chatSignal = buildExecutionSignal(helloIntent);
assert.equal(chatSignal, null, "chat intent should produce null signal");

console.log("[PASS] chat intent -> null signal");

// ---- Test: signal XML structure ----
const debugIntent = classifyExecutionIntent("帮我 debug 这个 error。", config);
const debugSignal = buildExecutionSignal(debugIntent);
assert.notEqual(debugSignal, null);
assert.match(debugSignal!, /<message_classification>/);
assert.match(debugSignal!, /<kind>debug<\/kind>/);
assert.match(debugSignal!, /<input_finalized>true<\/input_finalized>/);
assert.match(debugSignal!, /<execution_expected>true<\/execution_expected>/);
assert.match(debugSignal!, /<classifier_version>2\.0-weighted<\/classifier_version>/);

console.log("[PASS] signal XML structure");

// ---- Test: classifyMessage returns MessageClassification ----
const mc = classifyMessage("帮我 debug 这个 error。", config);
assert.equal(mc.kind, "debug", `Expected kind "debug" but got "${mc.kind}"`);
assert.ok(
  ["high", "medium", "low"].includes(mc.confidence),
  `Invalid confidence: ${mc.confidence}`,
);
assert.equal(mc.input_finalized, true);
assert.equal(mc.execution_expected, true);
assert.equal(mc.suggested_tier, "premium", `debug should map to premium tier`);
assert.equal(mc.classifier_version, "2.0-weighted");
assert.ok(typeof mc.score === "number", "score should be a number");

console.log("[PASS] classifyMessage returns MessageClassification");

// ---- Test: signal XML includes new fields (confidence, suggested_tier, score) ----
const mcSignal = buildExecutionSignal(mc);
assert.notEqual(mcSignal, null);
assert.match(mcSignal!, /<confidence>/);
assert.match(mcSignal!, /<suggested_tier>premium<\/suggested_tier>/);
assert.match(mcSignal!, /<score>/);

console.log("[PASS] signal XML includes confidence/suggested_tier/score");

// ---- Test: chat classifyMessage returns low confidence ----
const chatMc = classifyMessage("你好", config);
assert.equal(chatMc.kind, "chat");
assert.equal(chatMc.suggested_tier, "fast");

console.log("[PASS] chat classifyMessage -> fast tier");

console.log("\nAll smart-message-handler smoke tests passed");
