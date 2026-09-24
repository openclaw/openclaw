import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { asNullableRecord, readStringField } from "@openclaw/normalization-core/record-coerce";

export const RESOURCE_MARKER = "__OPENCLAW_IMPORT_RESOURCES__=";

export type ImportResources = {
  pid: number;
  maxRssKb: number;
  userCpuUs: number;
  systemCpuUs: number;
  totalCpuUs: number;
  runtime: { node: string; v8: string; abi: string; platform: string; arch: string };
};

/** Accept only complete native counter observations; missing is never zero. */
export function parseImportResources(line: string): ImportResources | null {
  if (!line.startsWith(RESOURCE_MARKER)) {
    return null;
  }
  try {
    const value = asNullableRecord(JSON.parse(line.slice(RESOURCE_MARKER.length)));
    const runtime = asNullableRecord(value?.runtime);
    const node = readStringField(runtime, "node");
    const v8 = readStringField(runtime, "v8");
    const abi = readStringField(runtime, "abi");
    const platform = readStringField(runtime, "platform");
    const arch = readStringField(runtime, "arch");
    const pid = value?.pid;
    const maxRssKb = value?.maxRssKb;
    const user = value?.userCpuUs;
    const system = value?.systemCpuUs;
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof maxRssKb !== "number" ||
      !Number.isSafeInteger(maxRssKb) ||
      maxRssKb < 0 ||
      typeof user !== "number" ||
      !Number.isSafeInteger(user) ||
      user < 0 ||
      typeof system !== "number" ||
      !Number.isSafeInteger(system) ||
      system < 0 ||
      !Number.isSafeInteger(user + system) ||
      !node ||
      !v8 ||
      !abi ||
      !platform ||
      !arch
    ) {
      return null;
    }
    return {
      pid,
      maxRssKb,
      userCpuUs: user,
      systemCpuUs: system,
      totalCpuUs: user + system,
      runtime: { node, v8, abi, platform, arch },
    };
  } catch {
    return null;
  }
}

export function importCpuDelta(sample: ImportResources | null, baseline: ImportResources | null) {
  if (!sample || !baseline || JSON.stringify(sample.runtime) !== JSON.stringify(baseline.runtime)) {
    return null;
  }
  // Independent cold processes can have negative deltas. Never clamp or sum plugin rows.
  return {
    userCpuUs: sample.userCpuUs - baseline.userCpuUs,
    systemCpuUs: sample.systemCpuUs - baseline.systemCpuUs,
    totalCpuUs: sample.totalCpuUs - baseline.totalCpuUs,
  };
}

function readGit(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
    }).trim();
  } catch {
    return null;
  }
}

function artifactIdentity(relativePath: string, bytes: Buffer | null) {
  return {
    path: relativePath,
    sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
    bytes: bytes?.length ?? null,
  };
}

function readArtifact(root: string, relativePath: string) {
  try {
    return artifactIdentity(relativePath, readFileSync(path.join(root, relativePath)));
  } catch {
    return artifactIdentity(relativePath, null);
  }
}

/** Diagnostic snapshots, not an attestation of the transitive dependency/build closure. */
export function captureImportIdentity(root: string, files: string[]) {
  const commit = readGit(root, ["rev-parse", "HEAD"]);
  const tree = readGit(root, ["rev-parse", "HEAD^{tree}"]);
  const status = readGit(root, ["status", "--porcelain", "--untracked-files=no"]);
  const buildPath = "dist/build-info.json";
  let buildBytes: Buffer | null = null;
  let declaredCommit: string | null = null;
  try {
    buildBytes = readFileSync(path.join(root, buildPath));
    const value = asNullableRecord(JSON.parse(buildBytes.toString("utf8")));
    if (typeof value?.commit === "string" && /^[0-9a-f]{40}$/iu.test(value.commit)) {
      declaredCommit = value.commit.toLowerCase();
    }
  } catch {
    // Package-local builds need not contain the host's canonical build metadata.
  }
  return {
    source: {
      commit: commit && /^[0-9a-f]{40}$/u.test(commit) ? commit : null,
      tree: tree && /^[0-9a-f]{40}$/u.test(tree) ? tree : null,
      trackedClean: status === null ? null : status === "",
    },
    build: { ...artifactIdentity(buildPath, buildBytes), declaredCommit },
    entries: files.map((file) =>
      readArtifact(root, path.relative(root, file).split(path.sep).join("/")),
    ),
  };
}

export function importIdentityGaps(
  before: ReturnType<typeof captureImportIdentity>,
  after: ReturnType<typeof captureImportIdentity>,
): string[] {
  const gaps: string[] = [];
  if (!before.source.commit || !before.source.tree || before.source.trackedClean !== true) {
    gaps.push("source identity unavailable or tracked source dirty");
  }
  if (!before.build.sha256 || !before.build.declaredCommit) {
    gaps.push("canonical build identity unavailable");
  } else if (before.build.declaredCommit !== before.source.commit) {
    gaps.push("build declaration does not match source commit");
  }
  if (before.entries.some((entry) => entry.sha256 === null)) {
    gaps.push("entry identity unavailable");
  }
  if (before.entries.some((entry) => !entry.path.startsWith("dist/extensions/"))) {
    gaps.push("package-local build provenance unavailable");
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    gaps.push("source, build metadata, or entry changed during profiling");
  }
  return gaps;
}
