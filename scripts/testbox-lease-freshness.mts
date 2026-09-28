import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const STATE_VERSION = 2;
const DEPENDENCY_INPUTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"];
const ENVIRONMENT_INPUTS = [
  ".crabbox.yaml",
  ".github/actions/prepare-testbox-shell",
  ".node-version",
  "scripts/crabbox-wrapper.mjs",
  "scripts/crabbox-wrapper.mts",
  "scripts/crabbox-source-capsule.mts",
  "scripts/crabbox-source-receiver.mts",
  "scripts/testbox-lease-freshness.mts",
];

function optionValue(args: readonly string[], name: string, fallback = "") {
  const shortName = name.replace(/^--/u, "-");
  let value = fallback;
  for (const [index, argument = ""] of args.entries()) {
    if (argument === "--") {
      break;
    }
    if (argument === name || argument === shortName) {
      value = args[index + 1] ?? fallback;
    }
    if (argument.startsWith(`${name}=`) || argument.startsWith(`${shortName}=`)) {
      value = argument.slice(argument.indexOf("=") + 1);
    }
  }
  return value;
}

function booleanOption(args: readonly string[], name: string) {
  let enabled = false;
  for (const arg of args) {
    if (arg === "--") {
      break;
    }
    if (arg === `--${name}` || arg === `-${name}`) {
      enabled = true;
    } else if (arg.startsWith(`--${name}=`) || arg.startsWith(`-${name}=`)) {
      // Match Go flag/strconv.ParseBool, including its last-occurrence rule.
      enabled = ["1", "t", "T", "TRUE", "true", "True"].includes(arg.slice(arg.indexOf("=") + 1));
    }
  }
  return enabled;
}

function git(repoRoot: string, args: readonly string[]) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

function listFiles(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  if (statSync(path).isFile()) {
    return [path];
  }
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => listFiles(resolve(path, entry.name)))
    .toSorted((left, right) => left.localeCompare(right));
}

function digestInputs(repoRoot: string, inputs: readonly string[]) {
  const hash = createHash("sha256");
  for (const input of inputs) {
    for (const path of listFiles(resolve(repoRoot, input))) {
      hash.update(path.slice(repoRoot.length));
      hash.update("\0");
      hash.update(readFileSync(path));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function taskIdentity(args: readonly string[], env: NodeJS.ProcessEnv) {
  // These identify a caller session, not a shell/pane that can outlive a task.
  // An explicit label narrows a long-running session to one named task.
  const label = optionValue(args, "--label");
  const caller = env.CODEX_THREAD_ID
    ? "codex"
    : env.CLAUDE_CODE_SESSION_ID
      ? "claude"
      : env.GITHUB_RUN_ID
        ? "github-actions"
        : "operator";
  const session =
    env.CODEX_THREAD_ID ||
    env.CLAUDE_CODE_SESSION_ID ||
    (env.GITHUB_RUN_ID
      ? `${env.GITHUB_REPOSITORY}:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:${env.GITHUB_JOB}`
      : "");
  return {
    caller,
    taskKey: session || label ? digest(JSON.stringify([caller, session, label])) : "",
  };
}

function buildTestboxLeaseFingerprint(
  repoRoot: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  const workflow = optionValue(
    args,
    "--blacksmith-workflow",
    ".github/workflows/ci-check-testbox.yml",
  );
  let baseSha;
  try {
    baseSha = git(repoRoot, ["merge-base", "HEAD", "refs/remotes/origin/main"]);
  } catch {
    baseSha = git(repoRoot, ["rev-parse", "HEAD"]);
  }
  return {
    version: STATE_VERSION,
    ...taskIdentity(args, env),
    checkoutKey: digest(realpathSync(repoRoot)),
    baseSha,
    headSha: git(repoRoot, ["rev-parse", "HEAD"]),
    dependencyDigest: digestInputs(repoRoot, [...DEPENDENCY_INPUTS, "patches"]),
    environmentDigest: digestInputs(repoRoot, [
      ...ENVIRONMENT_INPUTS,
      ...(workflow ? [workflow] : []),
    ]),
    workflow,
    job: optionValue(args, "--blacksmith-job", "check"),
    ref: optionValue(args, "--blacksmith-ref", "main"),
  };
}

export function testboxLeaseStaleReasons(saved: unknown, current: unknown) {
  if (!isRecord(saved) || saved.version !== STATE_VERSION || !isRecord(current)) {
    return ["state schema"];
  }
  return [
    "taskKey",
    "checkoutKey",
    "headSha",
    "baseSha",
    "dependencyDigest",
    "environmentDigest",
    "workflow",
    "job",
    "ref",
  ].filter((key) => saved[key] !== current[key]);
}

function assertAllocationReceipt(stateDir: string, id: string, current: unknown) {
  if (!id) {
    return;
  }
  const path = resolve(stateDir, `${id}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Testbox ${id} has no allocation receipt; stop it and allocate a fresh lease through scripts/crabbox-wrapper.mjs`,
    );
  }
  const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
  const staleReasons = testboxLeaseStaleReasons(saved, current);
  if (staleReasons.length > 0) {
    throw new Error(
      `Testbox ${id} is stale (${staleReasons.join(", ")}); stop it and allocate a fresh lease`,
    );
  }
}

export function prepareTestboxLeaseFreshness({
  args,
  command = args,
  env,
  provider,
  repoRoot,
}: {
  args: readonly string[];
  command?: readonly string[];
  env: NodeJS.ProcessEnv;
  provider: string;
  repoRoot: string;
}) {
  const id = optionValue(args, "--id");
  if (provider !== "blacksmith-testbox" || !["run", "warmup"].includes(args[0] ?? "")) {
    return null;
  }
  const configuredStateDir = env.OPENCLAW_TESTBOX_LEASE_STATE_DIR?.trim();
  if (env.VITEST && !configuredStateDir) {
    return null;
  }
  const stateDir = resolve(configuredStateDir || resolve(repoRoot, ".crabbox", "testbox-leases"));
  const current = buildTestboxLeaseFingerprint(repoRoot, args, env);
  if (id && !/^tbx_[a-zA-Z0-9_-]+$/u.test(id)) {
    throw new Error("Testbox reuse requires an exact tbx_ lease id");
  }
  const keep = booleanOption(args, "keep");
  const keepOnFailure = booleanOption(args, "keep-on-failure");
  if (!current.taskKey && (id || args[0] === "warmup" || keep || keepOnFailure)) {
    throw new Error(
      "Reusable Testboxes need a caller session or task label. Start with run --keep --label <unique-task-name>, reuse that label on each run, then stop the lease",
    );
  }
  assertAllocationReceipt(stateDir, id, current);
  return {
    current,
    stateDir,
    id,
    retained: args[0] === "warmup" || keep || Boolean(id),
    keepOnFailure,
    assertCurrent() {
      const changed = testboxLeaseStaleReasons(
        current,
        buildTestboxLeaseFingerprint(repoRoot, args, env),
      );
      if (changed.length > 0) {
        throw new Error(
          `Testbox inputs changed during preparation (${changed.join(", ")}); rerun from the current checkout`,
        );
      }
      assertAllocationReceipt(stateDir, id, current);
    },
    attribution: {
      ...current,
      commandKey: digest(JSON.stringify(command)),
      operation: args[0],
      requestedIdleTimeout: optionValue(args, "--idle-timeout") || undefined,
      // TTL is a request only: the delegated Blacksmith provider does not enforce it.
      requestedTtl: optionValue(args, "--ttl") || undefined,
    },
  };
}

export function recordTestboxLeaseFreshness(
  prepared: ReturnType<typeof prepareTestboxLeaseFreshness> | undefined,
  allocatedId = prepared?.id,
  nativeExitCode = 0,
) {
  // One-shot runs stop natively. Their attribution stays in the output, without
  // leaving receipts that can invalidate the source mirror for the next command.
  // Conditional retention follows the native result, before wrapper cleanup.
  if (!prepared || (!prepared.retained && !(prepared.keepOnFailure && nativeExitCode !== 0))) {
    return;
  }
  if (!allocatedId || !/^tbx_[a-zA-Z0-9_-]+$/u.test(allocatedId)) {
    throw new Error(
      "Testbox did not return an allocation receipt; inspect the native lease before reusing it",
    );
  }
  // Reuse never adopts or refreshes allocation provenance, including after failure.
  if (prepared.id) {
    return;
  }
  mkdirSync(prepared.stateDir, { recursive: true });
  const path = resolve(prepared.stateDir, `${allocatedId}.json`);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(prepared.current, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}
