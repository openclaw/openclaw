/**
 * Runtime proof for PR (issue #106570 + sibling #106568).
 * Repo builds with tsgo/oxc, not esbuild, so real src modules can't be tsx'd
 * here. This mirrors the exact guarded serialization at
 * packages/ai/src/providers/openai-completions.ts:565 and google-shared.ts:469.
 * Run: node scripts/proof-stream-error-serialize.mjs
 */

// Exact guard from the committed fix.
function serializeStreamError(error) {
  return error instanceof Error
    ? error.message
    : (() => {
        try {
          return JSON.stringify(error);
        } catch {
          return String(error);
        }
      })();
}

function makeCircular() {
  const e = { code: "ECONNRESET", message: "socket hang up" };
  e.self = e; // circular reference -> JSON.stringify throws
  return e;
}

function run() {
  // OLD: JSON.stringify(circular) throws TypeError -> handler crash
  let oldThrew = false;
  try {
    JSON.stringify(makeCircular());
  } catch {
    oldThrew = true;
  }

  // NEW: guarded -> returns String(error), no throw
  const result = serializeStreamError(makeCircular());
  const newOk = typeof result === "string" && result.length > 0;

  console.log(`OLD JSON.stringify(circular) throws? ${oldThrew}`);
  console.log(`NEW guarded serialize returns: ${JSON.stringify(result).slice(0, 80)}`);
  console.log(`NEW did not throw? ${newOk}`);

  const fixed = oldThrew && newOk;
  console.log(`\nRESULT: ${fixed ? "PASS — circular error no longer crashes the stream error handler" : "FAIL"}`);
  if (!fixed) process.exit(1);
}

run();
