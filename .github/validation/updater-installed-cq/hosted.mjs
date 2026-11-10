// Validation-only transport/receipt adapter; never imports product runtime code.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "dd6c99776b161d441cb827f78d2b031addce6648";
const SHA256 = "8af1ea0fa5901638538863c602ae28674849322bd759ea80d936fe3c9824ac69";
const CASES = ["success", "relative", "absolute", "failure", "cancel"];
const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.realpathSync(process.env.PROOF_ROOT);
assert.equal(fs.statSync(root).mode & 0o777, 0o700, "Proof root must be private (0700)");
const evidence = path.join(root, "evidence");
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const save = (name, data) =>
  fs.writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

if (process.argv[2] === "verify") {
  // Inspect bounded artifact contents without executing or extracting package code.
  assert.equal(process.version, "v26.12.1", "Exact Node runtime required");
  assert.equal(process.platform, "linux");
  const candidates = [];
  let entries = 0;
  function walk(dir, depth) {
    assert(depth <= 3, "Artifact nesting exceeds inspection bound");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      assert(++entries <= 100, "Artifact file count exceeds inspection bound");
      assert(!entry.isSymbolicLink(), "Artifact links are not accepted");
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".tgz")) candidates.push(file);
    }
  }
  walk(path.join(root, "download"), 0);
  assert.equal(candidates.length, 1, "Expected exactly one candidate tarball");
  const candidate = candidates[0];
  assert.equal(await digest(candidate), SHA256, "Candidate checksum mismatch");
  const member = (name) =>
    JSON.parse(
      execFileSync("tar", ["-xOf", candidate, name], { encoding: "utf8", maxBuffer: 1024 * 1024 }),
    );
  const pkg = member("package/package.json");
  const build = member("package/dist/build-info.json");
  assert.equal(pkg.name, "openclaw");
  assert.equal(build.commit, SOURCE, "Candidate source commit mismatch");
  assert.equal(build.version, pkg.version, "Package/build version mismatch");
  const provenance = read(path.join(here, "tooling/PROVENANCE.json"));
  assert.equal(provenance.commit, SOURCE);
  for (const file of provenance.files) {
    assert(!path.isAbsolute(file.path) && !file.path.split("/").includes(".."));
    const bundled = path.join(here, "tooling", file.path);
    assert.equal(fs.statSync(bundled).size, file.bytes);
    assert.equal(
      await digest(bundled),
      file.sha256,
      "Bundled helper provenance mismatch: " + file.path,
    );
  }
  save("binding.json", {
    scope: "validation-only-node-installed-cq",
    repository: process.env.GITHUB_REPOSITORY ?? null,
    workflowHead: process.env.GITHUB_SHA ?? null,
    harnessHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim(),
    harnessBranch: process.env.GITHUB_HEAD_REF ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    candidate: {
      artifact: "package-under-test-42717541806-1",
      runId: "42717541806",
      sha256: SHA256,
      source: SOURCE,
      version: pkg.version,
      build,
      engines: pkg.engines,
    },
    runtime: {
      node: process.version,
      executable: process.execPath,
      platform: process.platform,
      arch: process.arch,
    },
    helperProvenance: provenance,
    cases: CASES,
  });
  fs.writeFileSync(path.join(root, "candidate-path.txt"), candidate, { mode: 0o600 });
} else if (process.argv[2] === "collect") {
  // Deliberate allowlist: no installation, database, config, home, cache, or tarball.
  const run = path.join(root, "run");
  const manifest = { jobStatus: process.env.PROOF_JOB_STATUS ?? "local", files: [], omitted: [] };
  const totalLimit = 64 * 1024 * 1024;
  let total = 0;
  function collect(relative, limit) {
    const source = path.join(run, relative);
    if (!fs.existsSync(source)) return;
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    if (total + Math.min(stat.size, limit) > totalLimit) {
      manifest.omitted.push(relative);
      return;
    }
    const fd = fs.openSync(source, "r");
    const bytes = Buffer.alloc(Math.min(stat.size, limit));
    try {
      fs.readSync(fd, bytes, 0, bytes.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    // Logs originate in an isolated synthetic fixture, but redact its token at egress too.
    const text = bytes
      .toString("utf8")
      .replaceAll("isolated-hosted-proof-token", "[synthetic-token-redacted]");
    const target = relative.replaceAll("/", "__");
    fs.writeFileSync(path.join(evidence, target), text, { mode: 0o600 });
    total += bytes.length;
    manifest.files.push({
      source: relative,
      artifact: target,
      originalBytes: stat.size,
      retainedBytes: bytes.length,
      truncated: stat.size > limit,
    });
  }
  collect("summary.json", 8 * 1024 * 1024);
  if (fs.existsSync(run)) {
    const logs = fs
      .readdirSync(run)
      .filter((name) =>
        /^(derive-Q|node-(success|relative|absolute|failure|cancel)-[a-z-]+)\.(out|err)$/.test(
          name,
        ),
      )
      .sort();
    for (const log of logs.slice(0, 100)) collect(log, 1024 * 1024);
    for (const name of CASES)
      for (let i = 1; i <= 20; i++)
        collect("node-" + name + "/private-write-" + i + ".json", 64 * 1024);
  }
  save("collection.json", manifest);
  save("workflow.json", {
    status: manifest.jobStatus,
    scope: "validation-only-node-installed-cq",
    collectedAt: new Date().toISOString(),
  });
} else {
  throw new Error("Expected verify or collect");
}
