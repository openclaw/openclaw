/** Per-user, immutable desktop generations selected only by explicit maintenance. */
import fs, { type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNoSymlinkParentsSync } from "openclaw/plugin-sdk/file-access-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export type CodexManagedDesktopSelection = Readonly<{
  version: 1;
  appName: "ChatGPT.app" | "Codex.app";
  generation: string;
}>;

export type CodexManagedDesktopInstallation = Readonly<{
  selection: CodexManagedDesktopSelection;
  appBundlePath: string;
}>;

export function resolveCodexManagedDesktopRoot(): string {
  return path.join(os.homedir(), "Library", "Application Support", "OpenClaw", "Codex");
}

export type CodexManagedDesktopStateOptions = {
  env?: NodeJS.ProcessEnv;
  store?: Required<PluginStateKeyedStore<CodexManagedDesktopSelection>>;
};

async function selectionStore(options: CodexManagedDesktopStateOptions) {
  if (options.store) {
    return options.store;
  }
  // Descriptor registration stays light; the canonical SQLite worker loads only
  // when runtime selection or explicit maintenance actually reads durable state.
  const { createPluginStateKeyedStore } =
    await import("openclaw/plugin-sdk/plugin-state-store-runtime");
  return createPluginStateKeyedStore<CodexManagedDesktopSelection>("codex", {
    namespace: "managed-desktop-selection",
    retention: "retained",
    env: options.env,
  });
}

export function resolveCodexManagedDesktopAppPath(
  selection: CodexManagedDesktopSelection,
  root = resolveCodexManagedDesktopRoot(),
): string {
  assertSelection(selection);
  return path.join(path.resolve(root), "versions", selection.generation, selection.appName);
}

/** Recognizes retained generations as well as the current one; never follows an alias. */
export function isCodexManagedDesktopAppPath(
  appBundlePath: string,
  root = resolveCodexManagedDesktopRoot(),
): boolean {
  try {
    const relative = path.relative(path.resolve(root), path.resolve(appBundlePath)).split(path.sep);
    if (relative.length !== 3 || relative[0] !== "versions") {
      return false;
    }
    const selection = { version: 1, generation: relative[1], appName: relative[2] };
    assertSelection(selection);
    if (resolveCodexManagedDesktopAppPath(selection, root) !== appBundlePath) {
      return false;
    }
    inspectCandidate(root, appBundlePath);
    return true;
  } catch {
    return false;
  }
}

/** Read-only worker lookup: discovery never creates a database or a selector file. */
export async function readCodexManagedDesktopSelection(
  root = resolveCodexManagedDesktopRoot(),
  options: CodexManagedDesktopStateOptions = {},
): Promise<CodexManagedDesktopInstallation | undefined> {
  const selected = await (await selectionStore(options)).lookup(path.resolve(root));
  return inspectSelection(selected, root);
}

/** Capture writable admission and a row comparison before downloading a candidate. */
export async function observeCodexManagedDesktopSelection(
  params: CodexManagedDesktopStateOptions & {
    root?: string;
    signal: AbortSignal;
    assertCurrent: () => void;
  },
): Promise<{ installation: CodexManagedDesktopInstallation | undefined; comparison: string }> {
  const root = path.resolve(params.root ?? resolveCodexManagedDesktopRoot());
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
export async function publishCodexManagedDesktopSelection(
  params: CodexManagedDesktopStateOptions & {
    root?: string;
    selection: CodexManagedDesktopSelection;
    expectedComparison: string;
    signal: AbortSignal;
    assertCurrent: () => void;
  },
): Promise<void> {
  const root = path.resolve(params.root ?? resolveCodexManagedDesktopRoot());
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  const rootIdentity = inspectRoot(root);
  const appBundlePath = resolveCodexManagedDesktopAppPath(params.selection, root);
  const candidateIdentity = inspectCandidate(root, appBundlePath);
  const assertUnchanged = () => {
    assertCurrent();
    if (inspectRoot(root) !== rootIdentity) {
      throw new Error("Codex managed desktop root changed during publication.");
    }
    if (inspectCandidate(root, appBundlePath) !== candidateIdentity) {
      throw new Error("Codex managed desktop candidate changed during publication.");
    }
    assertCurrent();
  };
  const store = (await selectionStore(params)).withCurrent({ assertCurrent: assertUnchanged });
  const result = await store.compareAndApply(root, params.expectedComparison, {
    operation: "update",
    action: "set",
    value: params.selection,
  });
  if (result.status === "conflict") {
    throw new Error("Codex managed desktop selection changed; retry the update.");
  }
  assertCurrent();
}

function inspectSelection(
  selection: unknown,
  root: string,
): CodexManagedDesktopInstallation | undefined {
  if (selection === undefined) {
    return undefined;
  }
  assertSelection(selection);
  const appBundlePath = resolveCodexManagedDesktopAppPath(selection, root);
  inspectCandidate(root, appBundlePath);
  return { selection, appBundlePath };
}

function assertSelection(value: unknown): asserts value is CodexManagedDesktopSelection {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("appName" in value) ||
    (value.appName !== "ChatGPT.app" && value.appName !== "Codex.app") ||
    !("generation" in value) ||
    typeof value.generation !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.generation) ||
    Object.keys(value).some((key) => !["version", "appName", "generation"].includes(key))
  ) {
    throw new Error("Invalid Codex managed desktop selection.");
  }
}

function inspectRoot(root: string): string {
  if (path.resolve(root) === path.resolve(resolveCodexManagedDesktopRoot())) {
    assertNoSymlinkParentsSync({ rootDir: os.homedir(), targetPath: root });
  }
  const stat = fs.lstatSync(root, { bigint: true });
  assertOwned(stat);
  if (!stat.isDirectory()) {
    throw new Error("Codex managed desktop root must be a real directory.");
  }
  return `${stat.dev}:${stat.ino}`;
}

function inspectCandidate(root: string, appBundlePath: string): string {
  inspectRoot(root);
  const command = path.join(appBundlePath, "Contents", "Resources", "codex");
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
  if (!bundle.isDirectory() || !executable.isFile() || !(executable.mode & 0o111n)) {
    throw new Error("Codex managed desktop candidate must contain a real executable.");
  }
  return `${identity(bundle)}:${identity(executable)}`;
}

function assertOwned(stat: BigIntStats): void {
  if ((process.getuid && stat.uid !== BigInt(process.getuid())) || (stat.mode & 0o022n) !== 0n) {
    throw new Error(
      "Codex managed desktop files must be owned by this user and not shared-writable.",
    );
  }
}

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
