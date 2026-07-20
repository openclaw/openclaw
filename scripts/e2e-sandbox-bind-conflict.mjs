/**
 * End-to-end verification: protected skill mounts keep authority; conflicting
 * user binds are skipped to prevent Docker "Duplicate mount point" errors.
 *
 * Prerequisites: Docker daemon, Node >=22.19, pnpm install
 * Usage: node --import tsx scripts/e2e-sandbox-bind-conflict.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-"));
const skillsDir = path.join(workspaceDir, "skills", "demo");
fs.mkdirSync(skillsDir, { recursive: true });
fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "# E2E demo\n");
console.log("Workspace:", workspaceDir);

const customBindHost = path.join(workspaceDir, "custom-mount");
fs.mkdirSync(customBindHost, { recursive: true });
fs.writeFileSync(path.join(customBindHost, "data.txt"), "user data\n");

const userBinds = [`${customBindHost}:/workspace/skills:rw`];
const containerName = `oc-e2e-bind-${Date.now()}`.slice(0, 63);

let failureCount = 0;
function fail(label) {
  console.log(`❌ FAIL: ${label}`);
  failureCount += 1;
}
function pass(label) {
  console.log(`✅ ${label}`);
}

// ── Load production code ──────────────────────────────────────────────
const {
  resolveReadOnlyWorkspaceSkillMounts,
  resolveProtectedSkillMountContainerPaths,
  filterBindsConflictingWithProtectedMounts,
} = await import(path.join(repoRoot, "src/agents/sandbox/workspace-mounts.js"));

// ── Resolve protected skill mounts ────────────────────────────────────
console.log("\n--- Protected skill mounts ---");
const protectedMounts = resolveReadOnlyWorkspaceSkillMounts({
  workspaceDir,
  agentWorkspaceDir: workspaceDir,
  workdir: "/workspace",
  workspaceAccess: "rw",
});
console.log(
  "Protected:",
  protectedMounts.map((m) => `${m.hostPath} -> ${m.containerPath}`),
);

// ── Resolve protected container paths ─────────────────────────────────
const protectedPaths = resolveProtectedSkillMountContainerPaths(protectedMounts);
console.log("Protected paths:", [...protectedPaths]);

// ── Filter user binds ─────────────────────────────────────────────────
console.log("\nUser binds:", userBinds);
const safeBinds = filterBindsConflictingWithProtectedMounts(userBinds, protectedPaths);
console.log(
  "Safe binds (after skipping conflicts):",
  safeBinds.length === 0 ? "(none)" : safeBinds,
);

// Conflicting bind should be filtered out (no safe binds remain)
if (safeBinds.length > 0) {
  fail("conflicting user bind was not filtered out");
} else {
  pass("conflicting user bind correctly skipped");
}

// ── Build docker create args ──────────────────────────────────────────
const dockerArgs = [
  "create",
  "--name",
  containerName,
  "--label",
  "openclaw.e2e=1",
  "--workdir",
  "/workspace",
  "-v",
  `${workspaceDir}:/workspace`,
  ...safeBinds.flatMap((b) => ["-v", b]),
];
// Protected skill mounts always appended (authoritative, read-only)
for (const m of protectedMounts) {
  dockerArgs.push("-v", `${m.hostPath}:${m.containerPath}:ro`);
}
dockerArgs.push("e2e-sleep:latest", "infinity");

// ── Duplicate check ───────────────────────────────────────────────────
console.log("\n--- Docker args ---");
let nextIsMount = false;
for (const a of dockerArgs) {
  if (nextIsMount) {
    console.log(`  -v ${a}`);
    nextIsMount = false;
  } else if (a === "-v") {
    nextIsMount = true;
  } else if (a.startsWith("-")) {
    console.log(`  ${a}`);
  } else {
    console.log(`  ${a}`);
  }
}

console.log("\n--- Duplicate check ---");
const seen = new Map();
let dupes = 0;
for (let i = 0; i < dockerArgs.length - 1; i++) {
  if (dockerArgs[i] !== "-v") {
    continue;
  }
  const parts = dockerArgs[i + 1].split(":");
  if (parts.length < 2) {
    continue;
  }
  const cpath = parts[1];
  if (seen.has(cpath)) {
    console.log(`❌ DUPLICATE: ${cpath}`);
    dupes++;
  } else {
    seen.set(cpath, dockerArgs[i + 1]);
  }
}
if (dupes === 0) {
  console.log("✅ No duplicate container paths in -v args");
} else {
  fail(`found ${dupes} duplicate container paths`);
}

// ── Helper: run sudo docker with argv (no shell string) ───────────────
function sudoDocker(args, opts = {}) {
  return spawnSync("sudo", ["docker", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    ...opts,
  });
}

// ── Docker create ─────────────────────────────────────────────────────
console.log(`\n--- docker create ${containerName} ---`);
let created = false;
try {
  const result = sudoDocker(dockerArgs, { stdio: "pipe" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const err = new Error(result.stderr?.trim() || `docker create exited ${result.status}`);
    err.code = result.status;
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    throw err;
  }
  created = true;
  pass("Container created — no Duplicate mount point error");

  const inspectResult = sudoDocker([
    "inspect",
    "-f",
    "{{range .Mounts}}{{.Destination}}|{{end}}",
    containerName,
  ]);
  const output = (inspectResult.stdout || "").trim();
  const dests = output.split("|").filter(Boolean);
  const skillsCount = dests.filter((d) => d === "/workspace/skills").length;
  console.log(`Mount destinations: ${dests.join(" ")}`);
  console.log(`/workspace/skills count: ${skillsCount}`);
  if (skillsCount <= 1) {
    pass("/workspace/skills appears at most once");
  } else {
    fail(`/workspace/skills appears ${skillsCount} times (expected ≤1)`);
  }

  // Verify protected mount source (not user bind)
  const mountResult = sudoDocker([
    "inspect",
    "-f",
    '{{range .Mounts}}{{if eq .Destination "/workspace/skills"}}{{.Source}} {{.Mode}}{{end}}{{end}}',
    containerName,
  ]);
  const mountSrc = (mountResult.stdout || "").trim();
  console.log(`Mount source for /workspace/skills: ${mountSrc}`);
  const isReadOnly = mountSrc.includes("ro");
  const isProtectedSource = mountSrc.includes(path.join(workspaceDir, "skills"));
  if (isReadOnly) {
    pass("mount is read-only");
  } else {
    fail("mount is NOT read-only");
  }
  if (isProtectedSource) {
    pass("mount source is the protected skill directory");
  } else {
    fail("mount source is NOT the protected skill directory");
  }
} catch (err) {
  const msg = err?.stderr ? String(err.stderr) : String(err.message ?? err);
  if (msg.includes("Duplicate mount point") || msg.includes("duplicate mount")) {
    fail("Duplicate mount point rejected by Docker");
    console.log(msg.slice(0, 500));
  } else {
    console.log(`❌ Error: ${msg.slice(0, 500)}`);
    fail(msg.slice(0, 200));
  }
} finally {
  if (created) {
    sudoDocker(["rm", "-f", containerName]);
  }
  fs.rmSync(workspaceDir, { recursive: true, force: true });
}

console.log(
  failureCount > 0 ? `\n❌ Done. ${failureCount} failure(s)` : "\n✅ Done. All checks passed.",
);
process.exitCode = failureCount > 0 ? 1 : 0;
