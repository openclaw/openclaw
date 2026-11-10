import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { parseClaudeCodeVersion } from "./cli-shared.js";

type StoredRequirement = { version: string; learnedAt: number };

const KEY = "anthropic-oauth";

function newer(a: string | undefined, b: string | undefined): string | undefined {
  const pa = parseClaudeCodeVersion(a)?.split(".").map(Number);
  const pb = parseClaudeCodeVersion(b)?.split(".").map(Number);
  if (!pa) {
    return pb ? b : undefined;
  }
  if (!pb) {
    return a;
  }
  const index = pa.findIndex((part, i) => part !== pb[i]);
  return index !== -1 && pb[index]! > pa[index]! ? b : a;
}

/**
 * Claude Code version Anthropic last required for OAuth requests, kept in plugin
 * state so a restarted Gateway or a new CLI process starts at it instead of
 * being rejected once more. Combined with the installed CLI version, newest wins.
 */
export function createClaudeCodeVersionRequirement(
  api: OpenClawPluginApi,
  resolveInstalledVersion: () => Promise<string | undefined>,
) {
  let store: PluginStateKeyedStore<StoredRequirement, 2> | undefined;
  const open = () =>
    (store ??= api.runtime.state.openKeyedStoreV2<StoredRequirement>({
      namespace: "claude-code-version",
      maxEntries: 1,
    }));
  let learned: Promise<string | undefined> | undefined;
  const warn = (error: unknown) =>
    api.logger.warn?.(`anthropic: Claude Code version requirement state: ${String(error)}`);
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
    resolveVersion: async () => newer(await resolveInstalledVersion(), await readLearned()),
    record: (version: string) => {
      learned = Promise.resolve(version);
      void Promise.resolve()
        .then(() => open().register(KEY, { version, learnedAt: Date.now() }))
        .catch(warn);
    },
  };
}
