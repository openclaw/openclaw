#!/usr/bin/env node
/**
 * Real-behavior repro for issue #67136 / PR #67202.
 *
 * Goal: reproduce the exact behaviour the upstream pi-coding-agent write tool
 * exposed before this PR — "Successfully wrote N bytes" while the file does not
 * actually exist on disk — then show that the post-write verifier introduced by
 * this PR catches that case and converts it into a clear error.
 *
 * This script imports the SAME module that ships in this PR
 * (`src/agents/pi-tools.write-verification.ts`) directly, so the output below
 * is produced by running the actual changed code, not a mock of it. Node 22.6+
 * strips types natively (`--experimental-strip-types` on 22, default on 23.6+).
 *
 * Run from repo root:
 *
 *   node docs/proofs/67136/repro.mjs               # node 23.6+
 *   node --experimental-strip-types docs/proofs/67136/repro.mjs   # node 22
 *
 * The script is deterministic, writes only under os.tmpdir(), and cleans up
 * after itself.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  WriteVerificationError,
  isWriteVerificationError,
  verifyHostFile,
  verifyWrittenStat,
} from "../../../src/agents/pi-tools.write-verification.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function banner(title) {
  console.log("");
  console.log(`${BOLD}${CYAN}━━━ ${title} ━━━${RESET}`);
}

function logStep(text) {
  console.log(`${DIM}» ${text}${RESET}`);
}

function logSuccessLine(text) {
  console.log(`${GREEN}✓ ${text}${RESET}`);
}

function logFailureLine(text) {
  console.log(`${RED}✗ ${text}${RESET}`);
}

function logWarn(text) {
  console.log(`${YELLOW}! ${text}${RESET}`);
}

const summary = {
  scenarios: [],
  bugReproduced: false,
  fixCatches: { missing: false, wrongType: false, wrongSize: false, hostMissing: false },
};

function record(name, status, detail) {
  summary.scenarios.push({ name, status, detail });
}

/**
 * Scenario A — Pre-fix behaviour (no verifier).
 *
 * Reproduces the upstream contract that caused #67136: WriteOperations.writeFile
 * returns Promise<void>; if the injected implementation resolves without
 * actually persisting the file (e.g. the sandbox bridge silently dropped the
 * write, or a wrapping middleware swallowed the error), the agent reports
 * "Successfully wrote N bytes" while nothing landed on disk.
 *
 * We emulate the pre-fix host writeFile by deliberately NOT calling fs.writeFile,
 * exactly mirroring the upstream symptom. No verifier is invoked, so the caller
 * has no way to detect the silent failure.
 */
async function scenarioA_preFixSilentFailure() {
  banner("Scenario A: pre-fix behaviour — silent write success (the bug)");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-67136-A-"));
  const target = path.join(dir, "feature.md");
  const content = "# Feature spec\n\nHello from issue 67136.\n";

  logStep(`tmpdir: ${dir}`);
  logStep(`target: ${target}`);

  // This is the pre-fix WriteOperations.writeFile shape: returns Promise<void>,
  // no post-write check. We intentionally simulate the upstream "writeFile
  // resolved but the file was never created" symptom.
  async function buggyWriteFile(absolutePath, _data) {
    void _data;
    void absolutePath;
    // Resolve as if the write succeeded — this matches what the upstream
    // sandbox bridge did when its internal write op was a no-op for the path.
    return;
  }

  await buggyWriteFile(target, content);

  // Pre-fix code path then reported "Successfully wrote N bytes" without
  // verification. We reproduce that report verbatim:
  const reported = `Successfully wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${target}`;
  console.log(`${YELLOW}agent →${RESET} ${reported}`);

  let stillMissing = false;
  try {
    await fs.access(target);
  } catch {
    stillMissing = true;
  }

  if (stillMissing) {
    logFailureLine(
      "Reality: file does NOT exist on disk. The agent's success message was a lie. This is #67136 reproduced.",
    );
    summary.bugReproduced = true;
    record("A pre-fix silent failure", "bug-reproduced", { target, reported, fileExists: false });
  } else {
    logWarn("Unexpected: file does exist; could not reproduce silent-failure mode.");
    record("A pre-fix silent failure", "unexpected", { target, reported, fileExists: true });
  }

  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Scenario B — Post-fix behaviour (host path with verifyHostFile).
 *
 * The PR adds `verifyHostFile` after `fs.writeFile`. We exercise the exact
 * function shipped in this PR. Three sub-cases:
 *
 *   B1 normal write succeeds and verification passes silently.
 *   B2 the file is deleted between write and verify → verifier throws
 *      WriteVerificationError (this is the same observable failure mode the
 *      upstream bridge produced in #67136).
 *   B3 the file size differs from expected (e.g. partial write) → verifier
 *      throws WriteVerificationError with byte counts.
 */
async function scenarioB_postFixHost() {
  banner("Scenario B: post-fix behaviour — verifyHostFile catches the bug");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-67136-B-"));
  logStep(`tmpdir: ${dir}`);

  // B1: normal write
  const okPath = path.join(dir, "ok.txt");
  const okContent = "all good\n";
  await fs.writeFile(okPath, okContent, "utf-8");
  try {
    await verifyHostFile(okPath, okContent);
    logSuccessLine(`B1 normal write — verifyHostFile() OK for ${okPath}`);
    record("B1 normal write", "pass", { path: okPath });
  } catch (err) {
    logFailureLine(`B1 unexpected failure: ${err?.message ?? err}`);
    record("B1 normal write", "fail-unexpected", { error: String(err?.message ?? err) });
  }

  // B2: file is missing after the "write" (matches the upstream symptom)
  const missingPath = path.join(dir, "missing.txt");
  const missingContent = "should have landed";
  // Skip the actual fs.writeFile to simulate the silent drop.
  try {
    await verifyHostFile(missingPath, missingContent);
    logFailureLine(`B2 verifier did NOT throw — that would be a regression.`);
    record("B2 file missing after write", "fail-no-throw", {});
  } catch (err) {
    const matchedClass = isWriteVerificationError(err);
    if (matchedClass) {
      logSuccessLine(
        `B2 verifier threw WriteVerificationError as expected:\n      ${err.message}`,
      );
      summary.fixCatches.hostMissing = true;
      summary.fixCatches.missing = true;
      record("B2 file missing after write", "pass", { message: err.message });
    } else {
      logFailureLine(`B2 wrong error class: ${err?.constructor?.name}: ${err?.message}`);
      record("B2 file missing after write", "fail-wrong-class", { error: String(err) });
    }
  }

  // B3: size mismatch (partial write)
  const partialPath = path.join(dir, "partial.txt");
  const expected = "twelve bytes"; // 12 bytes
  await fs.writeFile(partialPath, "short", "utf-8"); // 5 bytes
  try {
    await verifyHostFile(partialPath, expected);
    logFailureLine(`B3 verifier did NOT throw on size mismatch — regression.`);
    record("B3 size mismatch", "fail-no-throw", {});
  } catch (err) {
    if (isWriteVerificationError(err) && /expected 12 bytes but file has 5 bytes/.test(err.message)) {
      logSuccessLine(
        `B3 verifier threw on size mismatch as expected:\n      ${err.message}`,
      );
      summary.fixCatches.wrongSize = true;
      record("B3 size mismatch", "pass", { message: err.message });
    } else {
      logFailureLine(`B3 unexpected error: ${err?.message ?? err}`);
      record("B3 size mismatch", "fail-unexpected", { error: String(err) });
    }
  }

  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Scenario C — Post-fix behaviour on the sandbox path (verifyWrittenStat).
 *
 * The sandbox bridge returns `{ type, size }` rather than fs.Stats; the PR
 * accepts both shapes. We feed verifyWrittenStat the exact shapes the bridge
 * emits to show the verifier covers all three failure modes the bug surfaced.
 */
async function scenarioC_postFixSandbox() {
  banner("Scenario C: post-fix behaviour — verifyWrittenStat catches sandbox-shape failures");

  // C1 stat returns null (bridge says: file not there)
  try {
    verifyWrittenStat({ absolutePath: "/sandbox/missing", content: "abc", stat: null });
    logFailureLine("C1 verifier did NOT throw for null stat.");
    record("C1 sandbox stat=null", "fail-no-throw", {});
  } catch (err) {
    if (err instanceof WriteVerificationError && /does not exist after write/.test(err.message)) {
      logSuccessLine(`C1 stat=null → ${err.message}`);
      summary.fixCatches.missing = true;
      record("C1 sandbox stat=null", "pass", { message: err.message });
    } else {
      logFailureLine(`C1 wrong error: ${err}`);
      record("C1 sandbox stat=null", "fail-unexpected", { error: String(err) });
    }
  }

  // C2 stat returns a directory (wrong type)
  try {
    verifyWrittenStat({
      absolutePath: "/sandbox/feature",
      content: "abc",
      stat: { type: "directory", size: 0 },
    });
    logFailureLine("C2 verifier did NOT throw for directory stat.");
    record("C2 sandbox wrong type", "fail-no-throw", {});
  } catch (err) {
    if (err instanceof WriteVerificationError && /path is not a file after write/.test(err.message)) {
      logSuccessLine(`C2 stat={type:"directory"} → ${err.message}`);
      summary.fixCatches.wrongType = true;
      record("C2 sandbox wrong type", "pass", { message: err.message });
    } else {
      logFailureLine(`C2 wrong error: ${err}`);
      record("C2 sandbox wrong type", "fail-unexpected", { error: String(err) });
    }
  }

  // C3 stat returns file with wrong size
  try {
    verifyWrittenStat({
      absolutePath: "/sandbox/feature.md",
      content: "hello world",
      stat: { type: "file", size: 5 },
    });
    logFailureLine("C3 verifier did NOT throw for size mismatch.");
    record("C3 sandbox wrong size", "fail-no-throw", {});
  } catch (err) {
    if (
      err instanceof WriteVerificationError &&
      /expected 11 bytes but file has 5 bytes/.test(err.message)
    ) {
      logSuccessLine(`C3 stat={size:5} → ${err.message}`);
      summary.fixCatches.wrongSize = true;
      record("C3 sandbox wrong size", "pass", { message: err.message });
    } else {
      logFailureLine(`C3 wrong error: ${err}`);
      record("C3 sandbox wrong size", "fail-unexpected", { error: String(err) });
    }
  }

  // C4 happy path: stat matches → no throw
  try {
    verifyWrittenStat({
      absolutePath: "/sandbox/ok.md",
      content: "hello world", // 11 bytes
      stat: { type: "file", size: 11 },
    });
    logSuccessLine("C4 happy path — verifyWrittenStat() returned cleanly for matching stat.");
    record("C4 sandbox happy path", "pass", {});
  } catch (err) {
    logFailureLine(`C4 unexpected throw: ${err}`);
    record("C4 sandbox happy path", "fail-unexpected", { error: String(err) });
  }
}

/**
 * Scenario D — wrapEditToolWithRecovery must not mask a verifier failure.
 *
 * Before this PR, the edit-tool recovery wrapper could observe a
 * WriteVerificationError and then read the file back from disk; if the readback
 * happened to look "close enough", the wrapper would synthesise a fake
 * "Successfully replaced …" message — the exact false success vector #67136
 * describes, except via the edit path.
 *
 * The PR adds an explicit `isWriteVerificationError(err)` rethrow at the top of
 * the catch block. We reproduce that wrapper inline (the production version is
 * tied to host edit infrastructure) to make the contract observable end-to-end.
 *
 * NOTE: This scenario does not exercise the production wrapper directly because
 * doing so requires the full host-edit tool factory (which needs a runtime
 * sandbox/host root). Tests covering the real wrapper are in
 * src/agents/pi-tools.read.host-edit-recovery.test.ts; this proof shows the
 * shared contract holds for the verifier-error type.
 */
async function scenarioD_recoveryDoesNotMask() {
  banner("Scenario D: edit-tool recovery must rethrow WriteVerificationError");

  async function fakeRecoveryWrapper(innerExecute) {
    try {
      return await innerExecute();
    } catch (err) {
      // This is the exact contract the PR adds in wrapEditToolWithRecovery.
      if (isWriteVerificationError(err)) {
        throw err;
      }
      // Otherwise the wrapper would attempt the readback heuristic. We return
      // a fake "success" string to make the masking observable if it occurred.
      return "Successfully replaced text (recovered after error)";
    }
  }

  // Inject a writeFile that resolves but the verifier then catches the missing
  // file — exactly the path #67136 triggers.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-67136-D-"));
  const missing = path.join(dir, "edit-target.txt");
  const innerExecute = async () => {
    // simulate write resolving cleanly
    // (intentionally do not write to disk)
    await verifyHostFile(missing, "expected content");
    return "Successfully replaced text";
  };

  let result;
  let caught;
  try {
    result = await fakeRecoveryWrapper(innerExecute);
  } catch (err) {
    caught = err;
  }

  if (caught && isWriteVerificationError(caught)) {
    logSuccessLine(
      `Recovery wrapper rethrew WriteVerificationError as required:\n      ${caught.message}`,
    );
    record("D recovery rethrow", "pass", { message: caught.message });
  } else if (typeof result === "string" && /Successfully replaced/.test(result)) {
    logFailureLine(
      `Recovery wrapper masked the verifier failure with a fake success: "${result}". This would be a regression.`,
    );
    record("D recovery rethrow", "fail-masked", { result });
  } else {
    logFailureLine(`Unexpected outcome: result=${result}, caught=${caught}`);
    record("D recovery rethrow", "fail-unexpected", { result, error: String(caught) });
  }

  await fs.rm(dir, { recursive: true, force: true });
}

(async () => {
  console.log(`${BOLD}OpenClaw #67136 / PR #67202 — Real behaviour repro${RESET}`);
  console.log(`${DIM}node ${process.version} | platform=${process.platform} ${process.arch}${RESET}`);
  console.log(`${DIM}cwd=${process.cwd()}${RESET}`);

  await scenarioA_preFixSilentFailure();
  await scenarioB_postFixHost();
  await scenarioC_postFixSandbox();
  await scenarioD_recoveryDoesNotMask();

  banner("Summary");
  for (const s of summary.scenarios) {
    const tag =
      s.status === "pass" || s.status === "bug-reproduced"
        ? `${GREEN}${s.status}${RESET}`
        : `${RED}${s.status}${RESET}`;
    console.log(`  • ${s.name} → ${tag}`);
  }

  const allFixesFired =
    summary.bugReproduced &&
    summary.fixCatches.missing &&
    summary.fixCatches.wrongType &&
    summary.fixCatches.wrongSize &&
    summary.fixCatches.hostMissing;

  console.log("");
  if (allFixesFired) {
    console.log(
      `${GREEN}${BOLD}PASS${RESET} — Bug reproduced (pre-fix) and verifier caught every failure mode (post-fix).`,
    );
    process.exit(0);
  } else {
    console.log(
      `${RED}${BOLD}FAIL${RESET} — Repro did not exercise every path. bugReproduced=${summary.bugReproduced}, fixCatches=${JSON.stringify(summary.fixCatches)}`,
    );
    process.exit(1);
  }
})().catch((err) => {
  console.error(`${RED}repro crashed:${RESET}`, err);
  process.exit(2);
});
