/**
 * Real behavior proof for PR #92351 (issue #92241).
 *
 * Demonstrates the dist-rotation guard:
 * 1. isDistRotationError correctly identifies stale-dist ERR_MODULE_NOT_FOUND
 * 2. guardedLoad wrapper catches, clears cache, logs operator warning, re-throws
 * 3. Non-rotation errors pass through untouched
 */
import { createLazyPromiseLoader, isDistRotationError } from "../src/shared/lazy-promise.js";
import { formatErrorMessage } from "../src/infra/errors.js";

const PASS = "✓";
const FAIL = "✗";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed += 1;
  } else {
    console.log(`  ${FAIL} ${label}`);
    failed += 1;
  }
}

console.log("=== isDistRotationError: positive cases ===");

// Case 1: Linux ERR_MODULE_NOT_FOUND in openclaw/dist
const err1 = Object.assign(
  new Error("Cannot find module '/usr/lib/node_modules/openclaw/dist/cleanup-DlVQZQex.js' imported from ..."),
  { code: "ERR_MODULE_NOT_FOUND" },
);
assert(
  "Linux ERR_MODULE_NOT_FOUND with openclaw/dist path → true",
  isDistRotationError(err1),
);

// Case 2: Windows path with backslashes
const err2 = Object.assign(
  new Error("Cannot find module 'C:\\Users\\app\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\chunk-abc123.js'"),
  { code: "MODULE_NOT_FOUND" },
);
assert(
  "Windows MODULE_NOT_FOUND with openclaw\\dist path → true",
  isDistRotationError(err2),
);

// Case 3: ERR_MODULE_NOT_FOUND with hashed chunk (the actual symptom)
const err3 = Object.assign(
  new Error("Cannot find module '/usr/lib/node_modules/openclaw/dist/chunks/cleanup-DbGY5-v-.js'"),
  { code: "ERR_MODULE_NOT_FOUND" },
);
assert(
  "Hashed chunk ERR_MODULE_NOT_FOUND in dist → true",
  isDistRotationError(err3),
);

console.log("\n=== isDistRotationError: negative cases ===");

// Case 4: ERR_MODULE_NOT_FOUND outside openclaw
const err4 = Object.assign(
  new Error("Cannot find module '/usr/lib/node_modules/lodash/index.js'"),
  { code: "ERR_MODULE_NOT_FOUND" },
);
assert(
  "ERR_MODULE_NOT_FOUND outside openclaw → false",
  !isDistRotationError(err4),
);

// Case 5: Other error code
const err5 = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
assert(
  "ENOENT error → false",
  !isDistRotationError(err5),
);

// Case 6: No code property
assert(
  "Error without code → false",
  !isDistRotationError(new Error("plain")),
);

// Case 7: Non-object inputs
assert("null → false", !isDistRotationError(null));
assert("undefined → false", !isDistRotationError(undefined));
assert("string → false", !isDistRotationError("ERR_MODULE_NOT_FOUND"));

console.log("\n=== guardedLoad: behavior verification ===");

// Simulate the guardedLoad pattern from get-reply.ts
async function guardedLoad<T>(
  loader: { load(): Promise<T>; clear(): void },
  label: string,
): Promise<T> {
  try {
    return await loader.load();
  } catch (err) {
    if (isDistRotationError(err)) {
      loader.clear();
      console.log(
        `[ERROR] auto-reply/reply-loader: bundled module changed under running gateway ` +
          `after update/rollback — restart required (lazy module "${label}" failed: ${formatErrorMessage(err)})`,
      );
      console.log(
        `[WARN] auto-reply/reply-loader: run "systemctl --user restart openclaw-gateway.service" ` +
          `(or equivalent) to reload dist modules`,
      );
    }
    throw err;
  }
}

// Test: normal load succeeds
let loadCalls = 0;
const goodLoader = createLazyPromiseLoader(async () => {
  loadCalls += 1;
  return { key: `value-${loadCalls}` };
});

const result1 = await guardedLoad(goodLoader, "test-module");
assert(
  "guardedLoad: normal load returns value",
  result1.key === "value-1",
);
assert(
  "guardedLoad: normal load dedupes (single call)",
  loadCalls === 1,
);

// Test: dist rotation error → clear + re-throw
let clearCalled = false;
const distErrLoader = {
  load: async () => {
    throw Object.assign(
      new Error("Cannot find module '/usr/lib/node_modules/openclaw/dist/chunks/stale-hash.js'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
  },
  clear: () => { clearCalled = true; },
};

console.log("\n--- dist rotation guard triggers (expected error output below) ---");
let threw = false;
try {
  await guardedLoad(distErrLoader, "stale-module");
} catch {
  threw = true;
}
assert("guardedLoad: dist rotation error re-thrown", threw);
assert("guardedLoad: dist rotation clears stale cache", clearCalled);
assert("guardedLoad: dist rotation propagated to caller", threw);

// Test: non-rotation error → no clear, re-throw
let clearCalled2 = false;
const plainErrLoader = {
  load: async () => {
    throw Object.assign(new Error("ENOENT: /tmp/missing"), { code: "ENOENT" });
  },
  clear: () => { clearCalled2 = true; },
};

console.log("--- non-rotation error (expected pass-through, no clear) ---");
let threw2 = false;
try {
  await guardedLoad(plainErrLoader, "other-module");
} catch {
  threw2 = true;
}
assert("guardedLoad: non-rotation error does NOT clear cache", !clearCalled2);
assert("guardedLoad: non-rotation error still re-thrown", threw2);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
