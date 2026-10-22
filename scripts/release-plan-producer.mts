#!/usr/bin/env node
import { execFileSync, type ExecFileSyncOptionsWithBufferEncoding } from "node:child_process";
import * as fs from "node:fs";
import { isBuiltin } from "node:module";
import { delimiter, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ReleasePlan, ReleasePlanLock } from "./release-plan-contract.mjs";
import type {
  ReleasePlanIntent,
  MainQualificationValidationIntent,
  ReleasePlanSourceBase,
  ReleasePlanSource,
  ReleaseInventorySource,
  VerifiedReleaseInventory,
  RunGh,
} from "./release-plan-producer.types.mts";
export type {
  ReleasePlanIntent,
  MainQualificationValidationIntent,
  ReleasePlanSource,
  ReleaseInventorySource,
  VerifiedReleaseInventory,
} from "./release-plan-producer.types.mts";

const REPOSITORY = "openclaw/openclaw";
const EXECUTION_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BOOTSTRAP_PATH = "scripts/release-plan-producer.mts",
  CORE_PATH = "scripts/release-plan-producer-core.mts";
const TOOLING_MODULE_PATHS = [
  "packages/normalization-core/src/record-coerce.ts",
  "packages/normalization-core/src/string-coerce.ts",
  "packages/plugin-package-contract/src/categories.ts",
  "packages/plugin-package-contract/src/index.ts",
  "scripts/lib/actions-artifact-archive.mjs",
  "scripts/lib/bounded-response.mjs",
  "scripts/lib/canonical-json.mjs",
  "scripts/lib/full-release-child-request.mjs",
  "scripts/lib/npm-publish-plan.mjs",
  "scripts/lib/plain-gh.mjs",
  "scripts/lib/plugin-publication-candidates.ts",
  "scripts/lib/plugin-publication-collector.ts",
  "scripts/lib/plugin-publication-target.mjs",
  "scripts/lib/pnpm-lockfile-documents.mjs",
  "scripts/lib/qualification-admission-baselines.mjs",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/release-plan-source.mts",
  "scripts/lib/release-upgrade-baseline.mjs",
  "scripts/lib/release-version.mjs",
  "scripts/release-plan-contract.mjs",
  "scripts/release-plan-producer-core.mts",
  "scripts/release-qualification-admission.mjs",
  "scripts/release-qualification-coverage.mjs",
  "scripts/release-tooling-identity.mjs",
  "scripts/release-validation-intent.mjs",
] as const;
const PROTECTED_TAG_PATTERN = /^release-publish\/([a-f0-9]{12})-([1-9][0-9]*)$/u;
const MAX_TOOLING_FILE_BYTES = 512 * 1024,
  MAX_TOOLING_BYTES = 2 * 1024 * 1024;
const YAML_PACKAGE_MAX_FILES = 512;
const YAML_PACKAGE_MAX_ENTRIES = 1024;
const YAML_PACKAGE_MAX_BYTES = 4 * 1024 * 1024;
// Keep both comparators local: this one precedes tooling verification, and CHILD_RUNNER's precedes
// loader-hook registration. Importing either would execute code before its integrity boundary.
const compareAscii = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function resolveReleasePlanNodeExecutable(): string | undefined {
  if (!process.versions.bun && process.allowedNodeEnvironmentFlags.has("--input-type")) {
    return process.execPath;
  }

  const names =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
          .map((extension) => `node${extension.toLowerCase()}`)
      : ["node"];
  const candidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => join(directory, name)));
  if (process.platform === "darwin") {
    candidates.push(
      "/opt/homebrew/bin/node",
      "/opt/homebrew/opt/node/bin/node",
      "/usr/local/bin/node",
      "/usr/local/opt/node/bin/node",
      "/usr/bin/node",
    );
  } else if (process.platform === "linux") {
    candidates.push("/usr/local/bin/node", "/usr/bin/node");
  }

  const probeEnv: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    const value = process.env[key];
    if (value) {
      probeEnv[key] = value;
    }
  }
  const probeSource =
    'process.stdout.write(!process.versions.bun&&process.allowedNodeEnvironmentFlags.has("--input-type")?process.execPath:"")';
  for (const candidate of new Set(candidates)) {
    try {
      const nodePath = execFileSync(candidate, ["--eval", probeSource], {
        encoding: "utf8",
        env: probeEnv,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim();
      if (nodePath) {
        return nodePath;
      }
    } catch {
      // Missing, non-executable, incompatible, and Bun shim candidates are skipped.
    }
  }
  return undefined;
}

type ToolingModule = { path: string; bytes: Buffer; imports: Array<[string, string]> };
type YamlEntry =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; bytes: Buffer };
type SerializableSource = Omit<ReleasePlanSourceBase, "runGh" | "downloadArchive"> &
  Record<string, unknown>;
type ProducerRequest =
  | { operation: "produce" | "produce-lock"; params: SerializableSource }
  | {
      operation: "produce-inventory" | "verify-inventory-identity";
      params: Omit<ReleaseInventorySource, "runGh" | "downloadArchive">;
    }
  | { operation: "verify-lock"; lockJson: string; params: SerializableSource };

const CHILD_RUNNER_PATH = "scripts/lib/release-plan-child-runner.mjs";

const gitBytes = (repoRoot: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

function requireSha(value: string, label: string) {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error(`${label} must be an exact lowercase 40-character commit SHA`);
  }
  return value;
}

function defaultRunGh(args: string[]) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function defaultDownloadArchive(args: string[]) {
  const options = {
    encoding: null,
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 512 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  } satisfies ExecFileSyncOptionsWithBufferEncoding;
  try {
    return execFileSync("gh", [...args, "--allow-escape-sequences"], options);
  } catch (error) {
    const stderr =
      error !== null && typeof error === "object" && "stderr" in error ? error.stderr : undefined;
    if (
      !String(stderr)
        .split(/\r?\n/u)
        .some((line) => line.trim() === "unknown flag: --allow-escape-sequences")
    ) {
      throw error;
    }
    return execFileSync("gh", args, options);
  }
}

function verifyRemoteTooling(
  params: ReleaseInventorySource | ReleasePlanSource,
  runGh: RunGh,
  inventoryOnly: boolean,
) {
  const sha = requireSha(params.toolingSha, "tooling SHA");
  const tagRef = params.toolingFullRef.replace(/^refs\/tags\//u, "");
  const protectedMatch = PROTECTED_TAG_PATTERN.exec(tagRef);
  // Acquisition is not admission: the verified child owns canonical branch policy.
  // Preserve its literal GET argv while rejecting reserved and traversal operands.
  const inventoryBranch =
    inventoryOnly &&
    params.toolingFullRef !== "refs/heads/main" &&
    /^refs\/heads\/[A-Za-z0-9._/-]{1,256}$/u.test(params.toolingFullRef) &&
    params.toolingFullRef.trim() === params.toolingFullRef &&
    !params.toolingFullRef.includes("..") &&
    params.toolingFullRef.split("/").every((part) => part !== "" && part !== ".");
  let args: string[], failure: string;
  if (protectedMatch) {
    if (protectedMatch[1] !== sha.slice(0, 12)) {
      throw new Error("protected release tooling tag SHA prefix does not match the workflow SHA");
    }
    args = ["api", `repos/${REPOSITORY}/git/ref/tags/${tagRef}`, "--method", "GET"];
    failure = "protected release tooling tag is missing or unreadable";
  } else if (params.toolingFullRef === "refs/heads/main") {
    // Keep this bounded query identical to the verified child's cached identity request.
    args = [
      "api",
      `repos/${REPOSITORY}/compare/${sha}...main`,
      "--method",
      "GET",
      "--jq",
      "{status}",
    ];
    failure = "main release tooling ancestry could not be verified";
  } else if (inventoryBranch) {
    args = [
      "api",
      `repos/${REPOSITORY}/git/ref/heads/${params.toolingFullRef.slice("refs/heads/".length)}`,
      "--method",
      "GET",
    ];
    failure = "inventory release tooling branch is missing or unreadable";
  } else {
    throw new Error("release tooling identity must be trusted main or an exact protected tag");
  }
  let raw: string;
  try {
    raw = runGh(args);
  } catch (error) {
    throw new Error(failure, { cause: error });
  }
  const response = JSON.parse(raw) as {
    ref?: unknown;
    status?: unknown;
    object?: { type?: unknown; sha?: unknown };
  };
  if (
    (protectedMatch || inventoryBranch) &&
    (response.ref !== params.toolingFullRef ||
      response.object?.type !== "commit" ||
      response.object.sha !== sha)
  ) {
    throw new Error(
      `${inventoryBranch ? "inventory release tooling branch" : "protected release tooling tag"} is missing, moved, annotated, or bound to the wrong SHA`,
    );
  }
  if (
    !protectedMatch &&
    !inventoryBranch &&
    response.status !== "ahead" &&
    response.status !== "identical"
  ) {
    throw new Error("main release tooling SHA is not reachable from current main");
  }
  if (
    !inventoryOnly &&
    "intent" in params &&
    params.intent !== "diagnostic" &&
    params.intent !== "main-qualification" &&
    !protectedMatch
  ) {
    throw new Error(`${params.intent} tooling must use a release-publish tag bound to its SHA`);
  }
  return [[JSON.stringify(args), raw]] as Array<[string, string]>;
}

function captureQualificationIdentity(
  params: ReleaseInventorySource,
  runGh: RunGh,
): Array<[string, string | Uint8Array]> {
  const descriptor = params.qualificationAdmission;
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("Invalid inventory admission descriptor");
  }
  const positiveId = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  // This capture precedes executable tooling admission. Snapshot JSON fields with
  // built-ins; the verified child still owns full descriptor and authority validation.
  const fields = new Map<string, unknown>(Object.entries(descriptor));
  const workflowSha = fields.get("workflowSha"),
    workflowFullRef = fields.get("workflowFullRef"),
    runId = fields.get("runId"),
    runAttempt = fields.get("runAttempt"),
    artifactId = fields.get("artifactId");
  if (
    params.candidateSha !== params.toolingSha ||
    params.qualificationInputs === undefined ||
    fields.get("repository") !== REPOSITORY ||
    typeof workflowSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(workflowSha) ||
    typeof workflowFullRef !== "string" ||
    (workflowFullRef !== "refs/heads/main" &&
      !/^refs\/tags\/release-publish\/[a-f0-9]{12}-[1-9][0-9]*$/u.test(workflowFullRef)) ||
    !positiveId(runId) ||
    !positiveId(runAttempt) ||
    !positiveId(artifactId)
  ) {
    throw new Error(
      "Candidate inventory requires an exact independent P admission descriptor and inputs",
    );
  }
  const responses: Array<[string, string | Uint8Array]> = [];
  let totalBytes = 0;
  const capture = (args: string[], binary = false) => {
    const value = binary ? (params.downloadArchive ?? defaultDownloadArchive)(args) : runGh(args);
    const size = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
    totalBytes += size;
    if (
      size > (binary ? 512 * 1024 : 1024 * 1024) ||
      totalBytes > 8 * 1024 * 1024 ||
      responses.length >= 32
    ) {
      throw new Error("Inventory admission identity responses exceed their bounds");
    }
    responses.push([JSON.stringify(args), value]);
    return value;
  };
  const api = (path: string, binary = false) =>
    capture(
      [
        "api",
        "repos/" + REPOSITORY + "/" + path,
        "--method",
        "GET",
        "--hostname",
        "github.com",
        "-H",
        "Cache-Control: max-age=0",
        "-H",
        "X-GitHub-Api-Version: 2026-03-10",
      ],
      binary,
    );
  const producer = () => {
    verifyRemoteTooling(
      {
        candidateSha: params.candidateSha,
        toolingSha: workflowSha,
        toolingFullRef: workflowFullRef,
      },
      (args) => String(capture(args)),
      false,
    );
    const run: unknown = JSON.parse(
      String(api("actions/runs/" + runId + "/attempts/" + runAttempt)),
    );
    if (run === null || typeof run !== "object" || Array.isArray(run)) {
      throw new Error("Invalid admission run");
    }
    const runFields = new Map<string, unknown>(Object.entries(run));
    for (const actor of [runFields.get("actor"), runFields.get("triggering_actor")]) {
      if (actor === null || typeof actor !== "object" || Array.isArray(actor)) {
        throw new Error("Invalid admission actor");
      }
      const login = new Map<string, unknown>(Object.entries(actor)).get("login");
      if (typeof login !== "string" || !/^[A-Za-z0-9-]{1,39}$/u.test(login)) {
        throw new Error("Invalid admission actor");
      }
      api("collaborators/" + login + "/permission");
    }
  };
  api("contents/.github/workflows/openclaw-release-prepare.yml?ref=" + workflowSha);
  producer();
  api("actions/artifacts/" + artifactId);
  api("actions/runs/" + runId + "/attempts/" + runAttempt + "/jobs?per_page=100");
  api("actions/artifacts/" + artifactId + "/zip", true);
  api("actions/artifacts/" + artifactId);
  producer();
  return responses;
}

function readGitFile(repoRoot: string, sha: string, path: string) {
  const entry = gitBytes(repoRoot, ["ls-tree", sha, "--", path]).toString("utf8").trim();
  if (!/^100(?:644|755) blob [a-f0-9]{40}\t/u.test(entry)) {
    throw new Error(`tooling closure path must be a regular Git blob: ${path}`);
  }
  return gitBytes(repoRoot, ["show", `${sha}:${path}`]);
}

function gitPathExists(repoRoot: string, sha: string, path: string) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}:${path}`], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function collectLiteralImports(source: string) {
  return [
    ...new Set(
      [...source.matchAll(/\b(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/gu)].map(
        (match) => match[1]!,
      ),
    ),
  ].toSorted(compareAscii);
}

function resolveImport(repoRoot: string, sha: string, sourcePath: string, specifier: string) {
  if (!specifier.startsWith(".") || specifier.startsWith("file:")) {
    throw new Error(`tooling closure contains an unowned import: ${sourcePath} -> ${specifier}`);
  }
  const importedPath = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
  if (importedPath === ".." || importedPath.startsWith("../")) {
    throw new Error(`tooling import escapes repository root: ${sourcePath} -> ${specifier}`);
  }
  const candidates = new Set([importedPath]);
  if (importedPath.endsWith(".js")) {
    candidates.add(`${importedPath.slice(0, -3)}.ts`);
  } else if (importedPath.endsWith(".mjs")) {
    candidates.add(`${importedPath.slice(0, -4)}.mts`);
  } else if (!posix.extname(importedPath)) {
    for (const suffix of [".ts", ".mts", ".mjs", "/index.ts"]) {
      candidates.add(`${importedPath}${suffix}`);
    }
  }
  const existing = [...candidates].filter((path) => gitPathExists(repoRoot, sha, path));
  if (existing.length !== 1) {
    throw new Error(
      `tooling import must resolve to one unambiguous file: ${sourcePath} -> ${specifier}`,
    );
  }
  const [target] = existing;
  if (!target || !TOOLING_MODULE_PATHS.includes(target as (typeof TOOLING_MODULE_PATHS)[number])) {
    throw new Error(`tooling import is outside the fixed closure: ${sourcePath} -> ${specifier}`);
  }
  return target;
}

function retainToolingClosure(repoRoot: string, sha: string) {
  const pending = [CORE_PATH];
  const modules = new Map<string, ToolingModule>();
  let totalBytes = 0;
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || modules.has(path)) {
      continue;
    }
    const bytes = readGitFile(repoRoot, sha, path);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_TOOLING_FILE_BYTES || totalBytes > MAX_TOOLING_BYTES) {
      throw new Error("tooling closure exceeds its retained-byte bounds");
    }
    const imports: Array<[string, string]> = [];
    for (const specifier of collectLiteralImports(bytes.toString("utf8"))) {
      if (isBuiltin(specifier)) {
        continue;
      }
      const target = resolveImport(repoRoot, sha, path, specifier);
      imports.push([specifier, target]);
      pending.push(target);
    }
    modules.set(path, { path, bytes, imports });
  }
  const retained = [...modules.values()].toSorted((left, right) =>
    compareAscii(left.path, right.path),
  );
  if (
    retained.length !== TOOLING_MODULE_PATHS.length ||
    retained.some(
      (record, index) => record.path !== [...TOOLING_MODULE_PATHS].toSorted(compareAscii)[index],
    )
  ) {
    throw new Error("tooling closure does not match the fixed allowlist");
  }
  return retained;
}

function assertSafeYamlPath(path: string) {
  const components = new Set(path.split("/"));
  if (
    !path ||
    !/^[\x20-\x7e]+$/u.test(path) ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    components.has(".") ||
    components.has("..")
  ) {
    throw new Error(`installed yaml package contains an unsafe path: ${JSON.stringify(path)}`);
  }
}

function retainYamlPackage() {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("installed yaml package verification requires O_NOFOLLOW support");
  }
  const packageRoot = fs.realpathSync(join(EXECUTION_ROOT, "node_modules", "yaml"));
  if (!fs.lstatSync(packageRoot).isDirectory()) {
    throw new Error("installed yaml package root must be a directory");
  }
  const entries: YamlEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  const walk = (directory: string, relativeDirectory = "") => {
    for (const name of fs.readdirSync(directory).toSorted(compareAscii)) {
      // Installer-created dependencies and bin shims are not package bytes or retained modules.
      if (!relativeDirectory && name === "node_modules") {
        continue;
      }
      const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      assertSafeYamlPath(path);
      if (entries.length >= YAML_PACKAGE_MAX_ENTRIES) {
        throw new Error(`installed yaml package exceeds ${YAML_PACKAGE_MAX_ENTRIES} entries`);
      }
      const absolutePath = join(directory, name);
      const lstat = fs.lstatSync(absolutePath);
      if (lstat.isSymbolicLink()) {
        throw new Error(`installed yaml package must not contain symbolic links: ${path}`);
      }
      if (lstat.isDirectory()) {
        entries.push({ kind: "directory", path });
        walk(absolutePath, path);
        continue;
      }
      if (!lstat.isFile()) {
        throw new Error("installed yaml package must contain only directories and files");
      }
      fileCount += 1;
      if (fileCount > YAML_PACKAGE_MAX_FILES) {
        throw new Error(`installed yaml package exceeds ${YAML_PACKAGE_MAX_FILES} files`);
      }
      const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile()) {
          throw new Error(`installed yaml package file changed type: ${path}`);
        }
        totalBytes += stat.size;
        if (totalBytes > YAML_PACKAGE_MAX_BYTES) {
          throw new Error(`installed yaml package exceeds ${YAML_PACKAGE_MAX_BYTES} bytes`);
        }
        bytes = fs.readFileSync(descriptor);
        if (bytes.byteLength !== stat.size) {
          throw new Error(`installed yaml package file changed while being read: ${path}`);
        }
      } finally {
        fs.closeSync(descriptor);
      }
      entries.push({ kind: "file", path, bytes });
    }
  };
  walk(packageRoot);
  return entries;
}

const serializableParams = ({
  runGh: _runGh,
  downloadArchive: _download,
  ...source
}: ReleasePlanSource) => source as SerializableSource;

function runOperation(
  request: ProducerRequest,
  params: ReleaseInventorySource | ReleasePlanSource,
) {
  const repoRoot = resolve(params.repoRoot ?? ".");
  const runGh = params.runGh ?? defaultRunGh;
  const identityResponses =
    params.qualificationAdmission === undefined
      ? verifyRemoteTooling(params, runGh, request.operation === "produce-inventory")
      : captureQualificationIdentity(params, runGh);
  const toolingSha = requireSha(params.toolingSha, "tooling SHA");
  const executionHead = gitBytes(EXECUTION_ROOT, ["rev-parse", "HEAD"]).toString("utf8").trim();
  if (executionHead !== toolingSha) {
    throw new Error("tooling bootstrap checkout HEAD must equal tooling SHA");
  }
  const bootstrapBytes = readGitFile(repoRoot, toolingSha, BOOTSTRAP_PATH);
  if (!fs.readFileSync(fileURLToPath(import.meta.url)).equals(bootstrapBytes)) {
    throw new Error(`tooling bootstrap differs from tooling SHA: ${BOOTSTRAP_PATH}`);
  }
  let stdout: string;
  try {
    const nodeExecPath = resolveReleasePlanNodeExecutable();
    if (!nodeExecPath) {
      throw new Error("verified release plan child requires a Node executable");
    }
    // The verified child always runs on Node, while its parent may run on Bun.
    // JSON plus canonical base64 keeps this integrity boundary runtime-neutral.
    const toolingModules = retainToolingClosure(repoRoot, toolingSha).map(({ bytes, ...record }) =>
      Object.assign(record, { bytesBase64: bytes.toString("base64") }),
    );
    const yamlEntries = retainYamlPackage().map((entry) =>
      entry.kind === "file"
        ? { kind: entry.kind, path: entry.path, bytesBase64: entry.bytes.toString("base64") }
        : entry,
    );
    const childRunner = readGitFile(repoRoot, toolingSha, CHILD_RUNNER_PATH).toString("utf8");
    if (fs.readFileSync(join(EXECUTION_ROOT, CHILD_RUNNER_PATH), "utf8") !== childRunner) {
      throw new Error("verified inventory child runner differs from tooling SHA");
    }
    const execute = (operation: ProducerRequest) =>
      execFileSync(nodeExecPath, ["--input-type=module", "-e", childRunner], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {},
        input: JSON.stringify({
          identityResponses: identityResponses.map(([key, value]) => [
            key,
            {
              encoding: typeof value === "string" ? "text" : "base64",
              body: typeof value === "string" ? value : Buffer.from(value).toString("base64"),
            },
          ]),
          expectedToolingPaths: TOOLING_MODULE_PATHS,
          request: operation,
          toolingModules,
          yamlEntries,
        }),
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
    // Verify the complete captured P proof before inventory production, then have
    // its secretless producer independently replay those same bounded observations.
    const verification =
      request.operation === "produce-inventory" && params.qualificationAdmission !== undefined
        ? execute({ operation: "verify-inventory-identity", params: request.params })
        : undefined;
    stdout = verification && JSON.parse(verification).ok !== true ? verification : execute(request);
  } catch (error) {
    throw new Error("verified release plan child failed", { cause: error });
  }
  const envelope = JSON.parse(stdout) as { ok?: unknown; value?: unknown; message?: unknown };
  if (envelope.ok !== true) {
    throw new Error(
      typeof envelope.message === "string" ? envelope.message : "verified child failed",
    );
  }
  return envelope.value;
}

export function produceReleasePlan(params: ReleasePlanSource): ReleasePlan {
  return runOperation(
    { operation: "produce", params: serializableParams(params) },
    params,
  ) as ReleasePlan;
}

export function produceVerifiedReleaseInventory(
  params: ReleaseInventorySource,
): VerifiedReleaseInventory {
  const { runGh: _runGh, downloadArchive: _download, ...source } = params;
  return runOperation(
    {
      operation: "produce-inventory",
      params: source,
    },
    params,
  ) as VerifiedReleaseInventory;
}

export function verifyReleasePlanLock(lockJson: string, params: ReleasePlanSource) {
  return runOperation(
    { operation: "verify-lock", lockJson, params: serializableParams(params) },
    params,
  ) as ReleasePlanLock;
}

function requiredOption(args: string[], name: string) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const intent = requiredOption(args, "--intent") as ReleasePlanIntent;
  if (!["publish", "diagnostic", "postpublish-confidence", "main-qualification"].includes(intent)) {
    throw new Error(
      "--intent must be publish, diagnostic, postpublish-confidence, or main-qualification",
    );
  }
  const source = {
    candidateSha: requiredOption(args, "--candidate-sha"),
    candidateRef: requiredOption(args, "--candidate-ref"),
    toolingSha: requiredOption(args, "--tooling-sha"),
    toolingFullRef: requiredOption(args, "--tooling-full-ref"),
  };
  const params = {
    ...source,
    intent,
    ...(intent === "main-qualification"
      ? {
          validationIntent: requiredOption(
            args,
            "--validation-intent",
          ) as MainQualificationValidationIntent,
        }
      : {}),
  } as ReleasePlanSource;
  process.stdout.write(
    runOperation(
      { operation: "produce-lock", params: serializableParams(params) },
      params,
    ) as string,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[release-plan-producer] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
