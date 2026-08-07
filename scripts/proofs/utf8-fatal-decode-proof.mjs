#!/usr/bin/env node
/**
 * Real behavior proof for PR #111810
 * fix(zai,amazon-bedrock-mantle): reject invalid UTF-8 in extension API response JSON
 *
 * Usage: node scripts/proofs/utf8-fatal-decode-proof.mjs
 */

// ── 1. Raw TextDecoder behavior: forgiving vs fatal ──

console.log("=== PR #111810: reject invalid UTF-8 in extension API response JSON ===\n");

const body = new Uint8Array([
  ...new TextEncoder().encode('{"code":"1211","msg":"'),
  0xff,
  ...new TextEncoder().encode('some message"}'),
]);

console.log("── 1a. OLD forgiving decoder (default TextDecoder()) ──");
const forgivingDecoder = new TextDecoder();
try {
  const forgivingText = forgivingDecoder.decode(body);
  console.log(`  Decoded text: ${forgivingText}`);
  const forgivingJson = JSON.parse(forgivingText);
  console.log(`  JSON.parse: ✅ succeeded`);
  console.log(`  errorCode extracted: "${forgivingJson.code}"`);
  console.log("  ❌ 0xFF silently became U+FFFD — the corrupted error code");
  console.log("     is accepted as genuine, leading the probe to misclassify");
  console.log("     the error and potentially skip fallback routing.");
} catch (err) {
  console.log(`  Error: ${err.message}`);
}

console.log("\n── 1b. NEW fatal decoder (TextDecoder('utf-8', { fatal: true })) ──");
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
try {
  const fatalText = fatalDecoder.decode(body);
  console.log(`  Decoded text: ${fatalText}`);
} catch (err) {
  console.log(`  Decode threw: ${err.constructor.name}: ${err.message}`);
  console.log("  ✅ 0xFF causes immediate TypeError — corrupt data is REJECTED");
  console.log("     before any JSON parsing or error-code extraction.");
}

// ── 2. Simulated Mantle model discovery behavior ──

console.log("\n── 2. Mantle model discovery: corrupted response body ──");

const mantleBody = new Uint8Array([
  ...new TextEncoder().encode('{"data":[{"id":"anthropic.claude-'),
  0xff,
  ...new TextEncoder().encode('","object":"model"}]}'),
]);

console.log("   Body bytes (hex, last 12):", Buffer.from(mantleBody.slice(-12)).toString("hex"));

console.log("\n── 2a. OLD path (forgiving decode → corrupt model user sees) ──");
const mantleForgiving = new TextDecoder();
try {
  const mantleForgivingText = mantleForgiving.decode(mantleBody);
  const mantleJson = JSON.parse(mantleForgivingText);
  const model = mantleJson.data?.[0];
  const modelId = model?.id;
  console.log(`  Decoded model ID: "${modelId}"`);
  if (modelId && modelId.includes("�")) {
    console.log("  ❌ Model ID contains U+FFFD replacement character");
    console.log("     The corrupt model is silently accepted and would be");
    console.log("     presented to the user in the model picker.");
  }
} catch (err) {
  console.log(`  Error: ${err.message}`);
}

console.log("\n── 2b. NEW path (fatal decode → malformed JSON → empty models) ──");
const mantleFatal = new TextDecoder("utf-8", { fatal: true });
try {
  const mantleFatalText = mantleFatal.decode(mantleBody);
  const mantleJson = JSON.parse(mantleFatalText);
  console.log(`  Parsed: ${JSON.stringify(mantleJson)}`);
} catch (err) {
  console.log(`  Decode threw: ${err.constructor.name}`);
  // In production, this is caught by the try-catch in readMantleModelDiscoveryJson
  // which throws "Mantle model discovery response is malformed JSON",
  // then discoverMantleModels catches it and returns [].
  console.log("  ✅ The malformed JSON error is caught by discoverMantleModels");
  console.log("     → returns [] — no corrupt models reach the user.");
}

// ── 3. Source diff ──

console.log("\n=== PR diff summary ===");
console.log("extensions/zai/detect.ts:");
console.log("-  const json = JSON.parse(new TextDecoder().decode(bytes)) as {");
console.log("+  const json = JSON.parse(");
console.log('+    new TextDecoder("utf-8", { fatal: true }).decode(bytes),');
console.log("+  ) as {");
console.log("");
console.log("extensions/amazon-bedrock-mantle/discovery.ts:");
console.log("-  const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;");
console.log("+  let body: unknown;");
console.log("+  try {");
console.log("+    body = JSON.parse(");
console.log('+      new TextDecoder("utf-8", { fatal: true }).decode(bytes),');
console.log("+    );");
console.log("+  } catch (cause) {");
console.log(
  '+    throw new Error("Mantle model discovery response is malformed JSON", { cause });',
);
console.log("+  }");
console.log("");
console.log("extensions/zai/detect.test.ts (discriminating regression test):");
console.log("+  // 0xFF inside JSON string — old forgiving decoder silently replaces");
console.log("+  // it with U+FFFD, JSON.parse succeeds, errorCode '1211' is extracted,");
console.log("+  // causing the probe to trigger the glm-5.1 fallback → success.");
console.log("+  // With fatal:true, TextDecoder throws → errorCode stays undefined →");
console.log("+  // fallback skipped → null.");
console.log("+  //");
console.log("+  // This test FAILS with old decoder (returns endpoint) and PASSES");
console.log("+  // with fatal decoder (returns null).");

console.log("\n✅ Proof complete");
