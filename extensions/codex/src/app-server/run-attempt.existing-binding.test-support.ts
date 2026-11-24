import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";

const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});

/** Stores a resumable native thread binding for an attempt fixture. */
export async function writeExistingBinding(
  sessionFile: string,
  workspaceDir: string,
  overrides: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
) {
  const supervisionFingerprint =
    overrides.connectionScope === "supervision" && !overrides.appServerRuntimeFingerprint
      ? buildCodexAppServerConnectionFingerprint(
          resolveCodexSupervisionAppServerRuntimeOptions({
            pluginConfig: { supervision: { enabled: true } },
          }),
        )
      : undefined;
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-existing",
    cwd: workspaceDir,
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    historyCoveredThrough: new Date().toISOString(),
    webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
    ...(supervisionFingerprint ? { appServerRuntimeFingerprint: supervisionFingerprint } : {}),
    ...overrides,
  });
}
