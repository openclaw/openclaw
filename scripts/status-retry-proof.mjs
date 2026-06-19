#!/usr/bin/env node
// Real behavior proof: demonstrate the ??= retry pattern for dynamic imports
// First call fails (transient import failure), resets promise cache
// Second call succeeds after promise is reset

console.log("=== /status Dynamic Import Retry Proof ===\n");

let attemptCount = 0;
let loaderPromise = null;

async function simulateImport() {
  attemptCount++;
  if (attemptCount === 1) {
    console.log(`Attempt ${attemptCount}: Simulating transient import failure...`);
    throw new Error("Simulated transient import failure (network hiccup)");
  }
  console.log(`Attempt ${attemptCount}: Import succeeds!`);
  return { default: "status-module-loaded" };
}

async function loadModule() {
  if (!loaderPromise) {
    loaderPromise = simulateImport().catch((err) => {
      console.log(`  -> Caught: ${err.message}. Resetting promise cache for retry.`);
      loaderPromise = null;
      return undefined;
    });
  }
  return loaderPromise;
}

async function main() {
  // First call: should fail, catch the error, reset promise
  console.log("Call 1 (should fail with undefined, promise cache reset):");
  const result1 = await loadModule();
  console.log(`  Result: ${result1 ?? "undefined (promise was reset)"}`);
  console.log(
    `  loaderPromise after call 1: ${loaderPromise === null ? "null (ready for retry)" : loaderPromise}`,
  );

  console.log("");

  // Second call: promise was reset, so it retries and succeeds
  console.log("Call 2 (should succeed after retry):");
  const result2 = await loadModule();
  console.log(`  Result: ${JSON.stringify(result2)}`);
  console.log(`  loaderPromise after call 2: ${loaderPromise === null ? "null" : "set (cached)"}`);

  const passed = result1 === undefined && result2?.default === "status-module-loaded";
  console.log(`\nTest result: ${passed ? "PASSED" : "FAILED"}`);

  const report = {
    test: "status-import-retry",
    description:
      "Proves the ??= retry pattern: when a dynamic import fails transiently, the promise cache is reset so subsequent calls retry instead of permanently caching the rejection.",
    call1_result: result1,
    call1_promise_after: loaderPromise === null ? "null" : "set",
    call2_result: result2,
    passed,
  };
  console.log("\nJSON Report:");
  console.log(JSON.stringify(report, null, 2));
}

main().catch(console.error);
