import { parseClaudeCodeVersion } from "./cli-shared.js";

type StoredRequirement = { version: string; learnedAt: number };

/** The two plugin-state operations this owner needs; the plugin passes its keyed store. */
export type ClaudeCodeVersionStore = {
  lookup(key: string): Promise<StoredRequirement | undefined>;
  register(key: string, value: StoredRequirement): Promise<unknown>;
};

const KEY = "anthropic-oauth";

function newer(a: string | undefined, b: string | undefined): string | undefined {
  const pa = parseClaudeCodeVersion(a)?.split(".").map(Number);
  const pb = parseClaudeCodeVersion(b)?.split(".").map(Number);
  if (!pa || !pb) {
    return pa ? a : pb ? b : undefined;
  }
  for (const [index, part] of pa.entries()) {
    const other = pb[index] ?? 0;
    if (part !== other) {
      return part > other ? a : b;
    }
  }
  return a;
}

/**
 * Claude Code version Anthropic last required for OAuth requests, kept in plugin
 * state so a restarted Gateway or a new CLI process starts at it instead of
 * being rejected once more. Combined with the installed CLI version, newest wins.
 */
export function createClaudeCodeVersionRequirement(params: {
  openStore: () => ClaudeCodeVersionStore;
  resolveInstalledVersion: () => Promise<string | undefined>;
  warn: (message: string) => void;
}) {
  let store: ClaudeCodeVersionStore | undefined;
  const open = () => (store ??= params.openStore());
  let learned: Promise<string | undefined> | undefined;
  const warn = (error: unknown) =>
    params.warn(`anthropic: Claude Code version requirement state: ${String(error)}`);
  const readLearned = () =>
    (learned ??= Promise.resolve()
      .then(() => open().lookup(KEY))
      .then(
        (entry) => entry?.version,
        (error: unknown) => {
          warn(error);
          return undefined;
        },
      ));
  return {
    resolveVersion: async () => newer(await params.resolveInstalledVersion(), await readLearned()),
    record: (version: string) => {
      learned = Promise.resolve(version);
      void Promise.resolve()
        .then(() => open().register(KEY, { version, learnedAt: Date.now() }))
        .catch(warn);
    },
  };
}
