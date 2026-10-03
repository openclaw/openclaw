import fs, { type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNoSymlinkParentsSync } from "openclaw/plugin-sdk/file-access-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { defineCodexBuildState } from "../build-state.js";
/** One selector for immutable managed Desktop and package CLI runtime generations. */
import { findMacOSDesktopCodexExecutable } from "./desktop-app-layout.js";

const runtimeRevision = defineCodexBuildState("openclaw.codexManagedRuntimeRevision", () => ({
  value: 0,
}));
export function readCodexManagedRuntimeRevision(): number {
  return runtimeRevision().value;
}

export type CodexManagedRuntimeSelection = Readonly<{
  version: 1;
  appName: "ChatGPT.app" | "Codex.app" | "cli";
  runtimeVersion?: string;
  generation: string;
}>;

export type CodexManagedRuntimeInstallation = Readonly<{
  selection: CodexManagedRuntimeSelection;
  appBundlePath: string;
}>;

export function resolveCodexManagedRuntimeRoot(kind: "desktop" | "cli" = "desktop"): string {
  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "OpenClaw", "Codex")
      : process.platform === "win32"
        ? path.join(os.homedir(), "AppData", "Local", "OpenClaw", "Codex")
        : path.join(os.homedir(), ".local", "share", "openclaw", "codex");
  return kind === "cli" ? path.join(base, "cli") : base;
}

export type CodexManagedRuntimeStateOptions = {
  env?: NodeJS.ProcessEnv;
  store?: Required<PluginStateKeyedStore<CodexManagedRuntimeSelection>>;
};

async function selectionStore(options: CodexManagedRuntimeStateOptions) {
  if (options.store) {
    return options.store;
  }
  // Descriptor registration stays light; the canonical SQLite worker loads only
  // when runtime selection or explicit maintenance actually reads durable state.
  const { createPluginStateKeyedStore } =
    await import("openclaw/plugin-sdk/plugin-state-store-runtime");
  return createPluginStateKeyedStore<CodexManagedRuntimeSelection>("codex", {
    namespace: "managed-runtime-selection",
    retention: "retained",
    env: options.env,
  });
}

export function resolveCodexManagedRuntimeAppPath(
  selection: CodexManagedRuntimeSelection,
  root = resolveCodexManagedRuntimeRoot(),
): string {
  assertSelection(selection);
  return path.join(path.resolve(root), "versions", selection.generation, selection.appName);
}

/** Recognizes retained generations as well as the current one; never follows an alias. */
export function isCodexManagedRuntimeAppPath(
  appBundlePath: string,
  root = resolveCodexManagedRuntimeRoot(),
): boolean {
  try {
    const relative = path.relative(path.resolve(root), path.resolve(appBundlePath)).split(path.sep);
    if (relative.length !== 3 || relative[0] !== "versions") {
      return false;
    }
    const selection = {
      version: 1,
      generation: relative[1],
      appName: relative[2],
      ...(relative[2] === "cli" ? { runtimeVersion: "0.0.0" } : {}),
    };
    assertSelection(selection);
    if (resolveCodexManagedRuntimeAppPath(selection, root) !== appBundlePath) {
      return false;
    }
    inspectCandidate(root, appBundlePath);
    return true;
  } catch {
    return false;
  }
}

/** Read-only worker lookup: discovery never creates a database or a selector file. */
export async function readCodexManagedRuntimeSelection(
  root = resolveCodexManagedRuntimeRoot(),
  options: CodexManagedRuntimeStateOptions = {},
): Promise<CodexManagedRuntimeInstallation | undefined> {
  const selected = await (await selectionStore(options)).lookup(path.resolve(root));
  return inspectSelection(selected, root);
}

/** Capture writable admission and a row comparison before downloading a candidate. */
export async function observeCodexManagedRuntimeSelection(
  params: CodexManagedRuntimeStateOptions & {
    root?: string;
    signal: AbortSignal;
    assertCurrent: () => void;
  },
): Promise<{ installation: CodexManagedRuntimeInstallation | undefined; comparison: string }> {
  const root = path.resolve(params.root ?? resolveCodexManagedRuntimeRoot());
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  const store = (await selectionStore(params)).withCurrent({ assertCurrent });
  const observation = await store.observe(root);
  assertCurrent();
  return {
    installation: inspectSelection(observation.value, root),
    comparison: observation.comparison,
  };
}

/** Atomically selects verified resources using canonical action-bound SQLite CAS. */
export async function publishCodexManagedRuntimeSelection(
  params: CodexManagedRuntimeStateOptions & {
    root?: string;
    selection: CodexManagedRuntimeSelection;
    expectedComparison: string;
    signal: AbortSignal;
    assertCurrent: () => void;
  },
): Promise<void> {
  const root = path.resolve(params.root ?? resolveCodexManagedRuntimeRoot());
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  const rootIdentity = inspectRoot(root);
  const appBundlePath = resolveCodexManagedRuntimeAppPath(params.selection, root);
  const candidateIdentity = inspectCandidate(root, appBundlePath);
  const assertUnchanged = () => {
    assertCurrent();
    if (inspectRoot(root) !== rootIdentity) {
      throw new Error("Codex managed runtime root changed during publication.");
    }
    if (inspectCandidate(root, appBundlePath) !== candidateIdentity) {
      throw new Error("Codex managed runtime candidate changed during publication.");
    }
    assertCurrent();
  };
  const store = (await selectionStore(params)).withCurrent({ assertCurrent: assertUnchanged });
  const result = await store.compareAndApply(root, params.expectedComparison, {
    operation: "update",
    action: "set",
    value: params.selection,
  });
  if (result.status !== "conflict") {
    runtimeRevision().value++;
  }
  if (result.status === "conflict") {
    throw new Error("Codex managed runtime selection changed; retry the update.");
  }
  assertCurrent();
}

function inspectSelection(
  selection: unknown,
  root: string,
): CodexManagedRuntimeInstallation | undefined {
  if (selection === undefined) {
    return undefined;
  }
  assertSelection(selection);
  const appBundlePath = resolveCodexManagedRuntimeAppPath(selection, root);
  inspectCandidate(root, appBundlePath);
  return { selection, appBundlePath };
}

function assertSelection(value: unknown): asserts value is CodexManagedRuntimeSelection {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("appName" in value) ||
    (value.appName !== "ChatGPT.app" && value.appName !== "Codex.app" && value.appName !== "cli") ||
    !("generation" in value) ||
    typeof value.generation !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.generation) ||
    ("runtimeVersion" in value &&
      (typeof value.runtimeVersion !== "string" ||
        !/^\d+\.\d+\.\d+$/u.test(value.runtimeVersion))) ||
    (value.appName === "cli" && !("runtimeVersion" in value)) ||
    Object.keys(value).some(
      (key) => !["version", "appName", "generation", "runtimeVersion"].includes(key),
    )
  ) {
    throw new Error("Invalid Codex managed runtime selection.");
  }
}

function inspectRoot(root: string): string {
  if (
    [resolveCodexManagedRuntimeRoot(), resolveCodexManagedRuntimeRoot("cli")].includes(
      path.resolve(root),
    )
  ) {
    assertNoSymlinkParentsSync({ rootDir: os.homedir(), targetPath: root });
  }
  const stat = fs.lstatSync(root, { bigint: true });
  assertOwned(stat);
  if (!stat.isDirectory()) {
    throw new Error("Codex managed runtime root must be a real directory.");
  }
  return `${stat.dev}:${stat.ino}`;
}

function inspectCandidate(root: string, appBundlePath: string): string {
  inspectRoot(root);
  const command =
    path.basename(appBundlePath) === "cli"
      ? path.join(appBundlePath, "bin", "codex.js")
      : findMacOSDesktopCodexExecutable(appBundlePath)?.appServerCommandPath;
  if (!command) {
    throw new Error("Codex managed runtime candidate has no supported executable.");
  }
  assertNoSymlinkParentsSync({
    rootDir: root,
    targetPath: path.dirname(command),
    requireDirectories: true,
    allowMissing: false,
  });
  const bundle = fs.lstatSync(appBundlePath, { bigint: true });
  const executable = fs.lstatSync(command, { bigint: true });
  assertOwned(bundle);
  assertOwned(executable);
  if (
    !bundle.isDirectory() ||
    !executable.isFile() ||
    (process.platform !== "win32" && !(executable.mode & 0o111n))
  ) {
    throw new Error("Codex managed runtime candidate must contain a real executable.");
  }
  return `${identity(bundle)}:${identity(executable)}`;
}

function assertOwned(stat: BigIntStats): void {
  if (
    (process.getuid && stat.uid !== BigInt(process.getuid())) ||
    (process.platform !== "win32" && (stat.mode & 0o022n) !== 0n)
  ) {
    throw new Error(
      "Codex managed runtime files must be owned by this user and not shared-writable.",
    );
  }
}

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
