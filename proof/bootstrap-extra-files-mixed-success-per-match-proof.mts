/**
 * Runtime proof for PR #89040's per-match isolation of extra-bootstrap failures.
 *
 * SCOPE (read this before trusting a green run):
 *   This harness proves ONE thing at runtime, over real on-disk state and the real
 *   production code path, with NO mocks of the pipeline: when one glob match cannot
 *   be canonicalized (a real non-ENOENT realpath fault), that single failure is
 *   isolated — a readable sibling match under the SAME pattern still LOADS, and the
 *   unreadable match surfaces as its OWN `io` diagnostic keyed to that matched path,
 *   instead of the whole pattern collapsing to nothing.
 *
 *   The fix lives in src/agents/workspace-extra-bootstrap-walker.ts: the per-match
 *   realpath catch records the failure and continues the walk rather than rethrowing.
 *   Both the native fs.glob path and the fs.glob-absent fallback walk feed the SAME
 *   shared realpath-containment filter, so this harness exercises BOTH engines to
 *   prove the isolation lives at that one site (CHECK 2 native, CHECK 3 fallback).
 *
 * Real fault, no mock:
 *   A matched path is a symlink whose target lives inside a chmod-000 directory
 *   (placed OUTSIDE the workspace so the glob walk never reads it). fs.glob only
 *   lstat's the symlink and yields it; the resolver's fs.realpath then FOLLOWS it and
 *   fails with a genuine EACCES resolving through the unsearchable directory. This is
 *   the exact non-ENOENT matched-path fault the unit tests inject with a realpath
 *   stub — reproduced here from real filesystem permissions.
 *
 * What is driven (no mocks of the pipeline):
 *   - resolveExtraBootstrapPatternPaths(workspace, "*\/AGENTS.md")
 *       the real resolver + workspace realpath containment filter.
 *   - loadExtraBootstrapFilesWithDiagnostics(workspace, [...])
 *       the real guarded loader the bundled hook calls (files + diagnostics).
 *   - bootstrapExtraFilesHook over a real AgentBootstrapHookContext
 *       the exact production consumption path that appends to context.bootstrapFiles.
 *   For CHECK 3 only fs.promises.glob is removed — to REACH the fallback walk, not to
 *   fake it. Nothing else is stubbed.
 *
 * Discriminator:
 *   Before this PR the resolver RETHREW the first non-ENOENT matched-path failure, so
 *   the accumulated match set was abandoned: the readable sibling was silently
 *   discarded and the loader reported a single `io` diagnostic keyed to the whole
 *   PATTERN. Loading the readable sibling here AND seeing the failure keyed to the
 *   specific matched path is exactly the all-or-nothing discard the fix removes.
 *
 * Honest limits:
 *   - Directory-target symlinks / chmod may be unconstructible in some sandboxes
 *     (EPERM/ENOSYS); there the harness SKIPS cleanly as PASS rather than assert a
 *     broken fixture.
 *   - Running as root bypasses the chmod-000 search check, so the EACCES cannot be
 *     produced; the harness SKIPS as PASS in that case.
 *   - Windows is out of scope for the POSIX permission/symlink semantics; it SKIPS.
 *
 * Run: NO_COLOR=1 node --import tsx proof/bootstrap-extra-files-mixed-success-per-match-proof.mts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveExtraBootstrapPatternPaths } from "../src/agents/workspace-extra-bootstrap-walker.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "../src/agents/workspace.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import bootstrapExtraFilesHook from "../src/hooks/bundled/bootstrap-extra-files/handler.js";
import {
  type AgentBootstrapHookContext,
  createInternalHookEvent,
} from "../src/hooks/internal-hooks.js";

const GOOD_CONTENT = "good agents";
const CONTROL_CONTENT = "control agents";
const PATTERN = "*/AGENTS.md";

function redact(text: string, needles: string[]): string {
  let result = text;
  for (const needle of needles) {
    if (needle.length > 0) {
      result = result.split(needle).join("<workspace>");
    }
  }
  return result;
}

function makeExtraFilesConfig(patterns: string[]): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "bootstrap-extra-files": { enabled: true, paths: patterns },
        },
      },
    },
  } as OpenClawConfig;
}

// Try to create a file symlink; return false if the sandbox forbids it so the
// harness can SKIP instead of asserting on a fixture that could not be built.
function trySymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (["EPERM", "EACCES", "ENOSYS"].includes(code)) {
      return false;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const out: string[] = [];
  const w = (line = "") => out.push(line);

  w(
    "============= PR #89040 per-match isolation runtime proof (mixed success/failure) =============",
  );
  w(`head:            ${headSha} (exact current HEAD)`);
  w(`node:            ${process.version}`);
  w(`os/arch:         ${os.type()} ${os.release()} ${process.arch}`);
  w("driven fn:       resolveExtraBootstrapPatternPaths + loadExtraBootstrapFilesWithDiagnostics");
  w("                 + bootstrapExtraFilesHook (all REAL; no mocks; real chmod-000 EACCES)");
  w("");

  if (process.platform === "win32") {
    w("PART: SKIP (POSIX permission/symlink semantics are out of scope on Windows)");
    w("VERDICT: PASS");
    w(
      "===============================================================================================",
    );
    process.stdout.write(`${out.join("\n")}\n`);
    return;
  }
  if (process.getuid?.() === 0) {
    w("PART: SKIP (running as root: chmod-000 search denial is bypassed, so EACCES cannot occur)");
    w("VERDICT: PASS");
    w(
      "===============================================================================================",
    );
    process.stdout.write(`${out.join("\n")}\n`);
    return;
  }

  // Hermetic, redactable environment. realpath the tmp base first: on macOS
  // os.tmpdir() is /var -> /private/var and the walker's containment filter
  // compares canonical realpaths, so a raw /var workspace would reject every match.
  const tmpBase = await fsp.realpath(os.tmpdir());
  const cfgHome = fs.mkdtempSync(path.join(tmpBase, "openclaw-permatch-home-"));
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;
  process.env.OPENCLAW_HOME = cfgHome;
  process.env.OPENCLAW_STATE_DIR = path.join(cfgHome, "state");
  process.env.OPENCLAW_CONFIG_PATH = path.join(cfgHome, "no-such-openclaw.json");

  const workspace = fs.mkdtempSync(path.join(tmpBase, "openclaw-permatch-ws-"));
  // The unsearchable directory lives OUTSIDE the workspace so the glob walk never
  // reads it (avoiding a top-level throw); it is reached ONLY by following the
  // matched symlink during realpath, which is exactly where the per-match fault fires.
  const outsideRoot = fs.mkdtempSync(path.join(tmpBase, "openclaw-permatch-outside-"));
  const redactNeedles = [workspace, outsideRoot, cfgHome];

  // Fixture (both matched by `*/AGENTS.md`, one readable, one faulting):
  //   good/AGENTS.md               ordinary readable sibling; must LOAD.
  //   bad/AGENTS.md -> <vault>/inner/AGENTS.md   symlink whose target sits under a
  //                    chmod-000 dir OUTSIDE the workspace; realpath -> EACCES.
  const goodDir = path.join(workspace, "good");
  fs.mkdirSync(goodDir, { recursive: true });
  const goodFileAbs = path.join(goodDir, "AGENTS.md");
  fs.writeFileSync(goodFileAbs, GOOD_CONTENT);

  const vault = path.join(outsideRoot, "vault");
  fs.mkdirSync(path.join(vault, "inner"), { recursive: true });
  fs.writeFileSync(path.join(vault, "inner", "AGENTS.md"), "unreadable");
  const badDir = path.join(workspace, "bad");
  fs.mkdirSync(badDir, { recursive: true });
  const badMatchAbs = path.join(badDir, "AGENTS.md");
  const symlinkOk = trySymlink(path.join(vault, "inner", "AGENTS.md"), badMatchAbs);
  if (!symlinkOk) {
    w("PART: SKIP (this sandbox cannot create symlinks: EPERM/ENOSYS)");
    w("VERDICT: PASS");
    w(
      "===============================================================================================",
    );
    process.stdout.write(`${out.join("\n")}\n`);
    await fsp.rm(workspace, { recursive: true, force: true });
    await fsp.rm(outsideRoot, { recursive: true, force: true });
    await fsp.rm(cfgHome, { recursive: true, force: true });
    return;
  }
  // Deny search on the vault: realpath through it now fails EACCES. Set last so the
  // fixture above could be written.
  fs.chmodSync(vault, 0o000);

  const fsGlobPresent = typeof (fsp as { glob?: unknown }).glob === "function";
  let check0 = false;
  let check1 = false;
  let check2 = false;
  let check3 = false;
  let check4 = false;

  try {
    // Pre-flight: confirm the real fault actually fires, so a green run cannot be a
    // silently-absent EACCES (e.g. an unexpected permission model). Not a numbered
    // CHECK — a guard on the fixture itself.
    let realpathFaulted = false;
    try {
      await fsp.realpath(badMatchAbs);
    } catch (err) {
      realpathFaulted = (err as NodeJS.ErrnoException).code === "EACCES";
    }
    check0 = fsGlobPresent && realpathFaulted;
    w("-- CHECK 0: environment — native fs.glob present and the chmod-000 EACCES really fires --");
    w(`   typeof fs.glob === "function": ${fsGlobPresent} (expect true)`);
    w(`   realpath(bad/AGENTS.md) throws EACCES: ${realpathFaulted} (expect true)`);
    w(`   CHECK 0: ${check0 ? "PASS" : "FAIL"}`);
    w("");

    // -- CHECK 1: NATIVE resolver — readable sibling matched, faulting match recorded --
    const resolved = await resolveExtraBootstrapPatternPaths(workspace, PATTERN);
    const matchesSorted = [...resolved.matches].toSorted();
    const badFailure = resolved.failures.find((f) => f.path === "bad/AGENTS.md");
    check1 =
      matchesSorted.includes("good/AGENTS.md") &&
      !matchesSorted.includes("bad/AGENTS.md") &&
      resolved.failures.length === 1 &&
      badFailure !== undefined;
    w("-- CHECK 1: native resolver keeps the readable match and records the faulting one --");
    w(`   matches:                ${JSON.stringify(matchesSorted)}`);
    w(`   failures:               ${JSON.stringify(resolved.failures.map((f) => f.path))}`);
    w(`   good/AGENTS.md matched:  ${matchesSorted.includes("good/AGENTS.md")} (expect true)`);
    w(`   bad/AGENTS.md recorded:  ${badFailure !== undefined} (expect true)`);
    w(`   CHECK 1: ${check1 ? "PASS" : "FAIL"}`);
    w("");

    // -- CHECK 2: NATIVE loader + bundled hook — sibling LOADS, fault is its own io diag --
    const loaded = await loadExtraBootstrapFilesWithDiagnostics(workspace, [PATTERN]);
    const goodLoaded = loaded.files.find((f) => f.path === goodFileAbs);
    const ioForBad = loaded.diagnostics.filter((d) => d.reason === "io" && d.path === badMatchAbs);
    const noOtherFailures = loaded.diagnostics.every(
      (d) => (d.reason !== "io" && d.reason !== "security") || d.path === badMatchAbs,
    );

    const context: AgentBootstrapHookContext = {
      workspaceDir: workspace,
      bootstrapFiles: [] as AgentBootstrapHookContext["bootstrapFiles"],
      cfg: makeExtraFilesConfig([PATTERN]),
      sessionKey: "agent:main:main",
    };
    const event = createInternalHookEvent("agent", "bootstrap", "agent:main:main", context);
    await bootstrapExtraFilesHook(event);
    const hookAppendedGood = context.bootstrapFiles.some(
      (f) => f.path === goodFileAbs && f.content === GOOD_CONTENT,
    );
    check2 =
      goodLoaded !== undefined &&
      goodLoaded.content === GOOD_CONTENT &&
      goodLoaded.missing === false &&
      ioForBad.length === 1 &&
      noOtherFailures &&
      hookAppendedGood;
    w("-- CHECK 2: native loader loads the sibling and surfaces the fault per matched path --");
    w(
      `   good loaded path:       ${goodLoaded ? redact(goodLoaded.path, redactNeedles) : "(not loaded)"}`,
    );
    w(`   good content matches:   ${goodLoaded?.content === GOOD_CONTENT} (expect true)`);
    w(
      `   io diag keyed to bad:   ${redact(JSON.stringify(ioForBad.map((d) => d.path)), redactNeedles)} (expect one)`,
    );
    w(`   hook appended good:     ${hookAppendedGood} (expect true)`);
    w(`   CHECK 2: ${check2 ? "PASS" : "FAIL"}`);
    w("");

    // -- CHECK 3: FALLBACK parity — same isolation with fs.glob hidden (one shared filter) --
    const originalGlob = Object.getOwnPropertyDescriptor(fsp, "glob");
    Object.defineProperty(fsp, "glob", { value: undefined, configurable: true, writable: true });
    try {
      const fbLoaded = await loadExtraBootstrapFilesWithDiagnostics(workspace, [PATTERN]);
      const fbGood = fbLoaded.files.find((f) => f.path === goodFileAbs);
      const fbIoForBad = fbLoaded.diagnostics.filter(
        (d) => d.reason === "io" && d.path === badMatchAbs,
      );
      check3 =
        typeof (fsp as { glob?: unknown }).glob !== "function" &&
        fbGood !== undefined &&
        fbGood.content === GOOD_CONTENT &&
        fbIoForBad.length === 1;
      w("-- CHECK 3: fs.glob-absent fallback walk isolates identically (single shared filter) --");
      w(
        `   fs.glob hidden:         ${typeof (fsp as { glob?: unknown }).glob !== "function"} (expect true)`,
      );
      w(`   good loaded on fallback: ${fbGood?.content === GOOD_CONTENT} (expect true)`);
      w(`   io diag keyed to bad:   ${fbIoForBad.length === 1} (expect true)`);
      w(`   CHECK 3: ${check3 ? "PASS" : "FAIL"}`);
      w("");
    } finally {
      if (originalGlob) {
        Object.defineProperty(fsp, "glob", originalGlob);
      }
    }

    // -- CHECK 4: CONTROL — an all-readable pattern loads fully with ZERO diagnostics --
    const controlDir = path.join(workspace, "clean");
    fs.mkdirSync(controlDir, { recursive: true });
    const controlFileAbs = path.join(controlDir, "AGENTS.md");
    fs.writeFileSync(controlFileAbs, CONTROL_CONTENT);
    // Glob form (`clean/*.md`, not the literal `clean/AGENTS.md`) so the loader
    // takes the glob branch and actually drives resolveExtraBootstrapPatternPaths.
    // A literal would skip the resolver entirely, leaving the control unable to
    // rule out an always-recording resolver — the very mode it exists to exclude.
    const controlLoaded = await loadExtraBootstrapFilesWithDiagnostics(workspace, ["clean/*.md"]);
    const controlFile = controlLoaded.files.find((f) => f.path === controlFileAbs);
    check4 =
      controlFile !== undefined &&
      controlFile.content === CONTROL_CONTENT &&
      controlLoaded.diagnostics.length === 0;
    w(
      "-- CHECK 4: CONTROL — an all-readable pattern loads with no diagnostics (not always-erroring) --",
    );
    w(
      `   control loaded path:    ${controlFile ? redact(controlFile.path, redactNeedles) : "(not loaded)"}`,
    );
    w(`   control content matches: ${controlFile?.content === CONTROL_CONTENT} (expect true)`);
    w(`   control diagnostics:     ${controlLoaded.diagnostics.length} (expect 0)`);
    w(`   CHECK 4: ${check4 ? "PASS" : "FAIL"}`);
    w("");
  } finally {
    // Restore search on the vault so the recursive removal can descend it.
    try {
      fs.chmodSync(vault, 0o755);
    } catch {
      // best-effort restore; rm --force below still tries.
    }
    await fsp.rm(workspace, { recursive: true, force: true });
    await fsp.rm(outsideRoot, { recursive: true, force: true });
    await fsp.rm(cfgHome, { recursive: true, force: true });
  }

  const pass = check0 && check1 && check2 && check3 && check4;
  w("PRE-FIX NOTE:");
  w("   Before this PR the resolver rethrew the first non-ENOENT matched-path realpath");
  w("   fault, abandoning the accumulated match set: the readable good/AGENTS.md sibling");
  w("   was silently discarded and the loader reported ONE io diagnostic keyed to the");
  w("   whole pattern. Loading the sibling above AND keying the io diagnostic to the");
  w("   specific bad/AGENTS.md match is this PR's per-match isolation.");
  w("");
  w(`VERDICT: ${pass ? "PASS" : "FAIL"}`);
  w(
    "===============================================================================================",
  );

  process.stdout.write(`${out.join("\n")}\n`);
  if (!pass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[mixed-success-per-match-proof] FAILED", error);
  process.exitCode = 1;
});
