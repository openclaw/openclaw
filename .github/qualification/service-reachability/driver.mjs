import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packet = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const out = path.join(root, ".service-reachability-evidence");
const manifest = JSON.parse(fs.readFileSync(path.join(packet, "manifest.json"), "utf8"));
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const json = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + "\n");
fs.mkdirSync(out, { recursive: true });
function git(args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || "Git command failed: " + args.join(" "));
  return r.stdout.trim();
}
function seals() {
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (digest(fs.readFileSync(path.join(packet, name))) !== hash) throw new Error("Packet seal mismatch: " + name);
  }
}
function postimages() {
  for (const entry of manifest.postimages) {
    const bytes = fs.readFileSync(path.join(root, entry.path));
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error("Source postimage mismatch: " + entry.path);
  }
  const actual = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean).sort();
  const expected = manifest.postimages.map((entry) => entry.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Unexpected candidate path set");
  if (git(["diff", "--name-only"])) throw new Error("Unstaged tracked source changes");
}
export function assertOutcome(raw) {
  const log = raw.replace(/\x1b\[[0-9;]*m/g, "");
  for (const prefix of ["Test Files", "Tests"]) {
    const lines = log.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith(prefix + " "));
    if (!lines.length || lines.some((line) => line.replace(/\s+/g, " ") !== prefix + " 1 passed (1)")) {
      throw new Error("Expected exactly one passed, non-skipped " + prefix + " summary");
    }
  }
  if (!log.includes(manifest.testFile) || !log.includes(manifest.testTitle)) throw new Error("Expected registered test identity absent");
}
function runPhase(name, command, args) {
  seals();
  postimages();
  if (name === "test") {
    const prior = JSON.parse(fs.readFileSync(path.join(out, "bootstrap.json"), "utf8"));
    if (prior.exitCode !== 0) throw new Error("Bootstrap did not succeed");
  }
  const start = Date.now();
  const fd = fs.openSync(path.join(out, name + ".log"), "w");
  let result;
  try { result = spawnSync(command, args, { cwd: root, stdio: ["ignore", fd, fd] }); }
  finally { fs.closeSync(fd); }
  const record = { command, args, startedAt: new Date(start).toISOString(), durationMs: Date.now() - start, exitCode: result.status, signal: result.signal, error: result.error?.message ?? null };
  try {
    if (result.status !== 0 || result.error) throw new Error("Phase failed: " + name);
    postimages();
    if (name === "test") assertOutcome(fs.readFileSync(path.join(out, "test.log"), "utf8"));
    record.qualified = true;
  } catch (error) { record.qualified = false; record.failure = String(error); throw error; }
  finally { json(name + ".json", record); }
}
const mode = process.argv[2];
try {
  if (mode === "apply") {
    seals();
    const packetSha = git(["-C", path.join(packet, "../../.."), "rev-parse", "HEAD"]);
    if (packetSha !== process.env.QUALIFICATION_WORKFLOW_SHA) throw new Error("Packet checkout differs from executing workflow SHA");
    if (git(["rev-parse", "HEAD"]) !== manifest.base) throw new Error("Wrong source base");
    if (git(["diff", "--name-only"]) || git(["diff", "--cached", "--name-only"])) throw new Error("Source checkout not clean");
    git(["apply", "--check", "--index", path.join(packet, "candidate.patch")]);
    git(["apply", "--index", path.join(packet, "candidate.patch")]);
    git(["apply", "--check", "--index", path.join(packet, manifest.diagnosticPatch)]);
    git(["apply", "--index", path.join(packet, manifest.diagnosticPatch)]);
    postimages();
    for (const file of ["candidate.patch", "manifest.json", "driver.mjs", "ci-fixture.sh", manifest.diagnosticPatch]) fs.copyFileSync(path.join(packet, file), path.join(out, file));
    json("binding.json", { base: manifest.base, candidatePatchSha256: manifest.files["candidate.patch"], diagnosticPatchSha256: manifest.files[manifest.diagnosticPatch], candidateTree: git(["write-tree"]), packetCheckout: git(["-C", path.join(packet, "../../.."), "rev-parse", "HEAD"]), workflowSha: process.env.QUALIFICATION_WORKFLOW_SHA ?? null, workflowRef: process.env.GITHUB_WORKFLOW_REF ?? null, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, node: process.version, packageManager: JSON.parse(fs.readFileSync("package.json", "utf8")).packageManager, postimages: manifest.postimages });
    const visuals = manifest.priorVisuals.map((entry) => {
      const file = path.join(packet, "visual", entry.name);
      if (!fs.existsSync(file)) return { ...entry, status: "not staged" };
      if (digest(fs.readFileSync(file)) !== entry.sha256) throw new Error("Prior screenshot hash differs: " + entry.name);
      fs.copyFileSync(file, path.join(out, entry.name));
      return { ...entry, status: "archived prior proof; not generated by this CI run" };
    });
    json("visual-proof.json", visuals);
  } else if (mode === "bootstrap") {
    runPhase("bootstrap", process.execPath, ["scripts/worktree-setup.mjs", "gateway"]);
  } else if (mode === "test") {
    runPhase("test", "bash", [path.join(packet, "ci-fixture.sh")]);
  } else if (mode === "finalize") {
    const records = {};
    for (const name of ["bootstrap", "test"]) {
      const file = path.join(out, name + ".json");
      records[name] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { qualified: false, failure: "Phase did not complete" };
    }
    let sourceVerified = false;
    try { seals(); postimages(); sourceVerified = true; } catch (error) { records.sourceFailure = String(error); }
    const qualified = sourceVerified && records.bootstrap.qualified === true && records.test.qualified === true;
    json("result.json", { qualified, sourceVerified, records });
    const files = fs.readdirSync(out).filter((name) => name !== "sha256sums.txt").sort();
    fs.writeFileSync(path.join(out, "sha256sums.txt"), files.map((name) => digest(fs.readFileSync(path.join(out, name))) + "  " + name).join("\n") + "\n");
    if (!qualified) process.exitCode = 1;
  } else if (mode !== "selftest-import") throw new Error("Unknown qualification phase");
} catch (error) {
  json("failure-" + (mode ?? "unknown") + ".json", { error: String(error), at: new Date().toISOString() });
  console.error(error);
  process.exitCode = 1;
}
