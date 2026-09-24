import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { listTelegramAccountIds } from "./account-selection.js";

type MigrationInput = Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];

async function collectRetiredStateWarnings(params: MigrationInput): Promise<string[]> {
  const telegramDir = path.join(params.stateDir, "telegram");
  const sources: string[] = [];
  try {
    for (const entry of await fs.readdir(telegramDir, { withFileTypes: true })) {
      if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        /^(?:bot-info-.+|sticker-cache|thread-bindings-.+|update-offset-.+)\.json$/.test(entry.name)
      ) {
        sources.push(path.join(telegramDir, entry.name));
      }
    }
  } catch (error) {
    if (extractErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  const agentIds = new Set([
    ...listAgentIds(params.config),
    ...listTelegramAccountIds(params.config),
    "main",
  ]);
  const storePaths = new Set([
    path.join(params.stateDir, "sessions", "sessions.json"),
    ...[...agentIds].map((agentId) =>
      resolveStorePath(params.config.session?.store, { env: params.env, agentId }),
    ),
  ]);
  for (const storePath of storePaths) {
    for (const suffix of ["telegram-messages", "telegram-sent-messages", "telegram-topic-names"]) {
      const sourcePath = `${storePath}.${suffix}.json`;
      try {
        const entry = await fs.lstat(sourcePath);
        if (entry.isFile() || entry.isSymbolicLink()) {
          sources.push(sourcePath);
        }
      } catch (error) {
        if (extractErrorCode(error) !== "ENOENT") {
          throw error;
        }
      }
    }
  }
  return sources.map(
    (source) =>
      `Preserved retired Telegram JSON state at ${source}. Run openclaw doctor --fix on 2026.9.5 before upgrading to latest: https://docs.openclaw.ai/install/updating#upgrading-very-old-versions`,
  );
}

// Keep the action identity so pending imports settle only after their old sources are gone.
export const telegramRetiredStateMigration: PluginDoctorStateMigration = {
  id: "telegram-legacy-state",
  label: "Retired Telegram JSON state",
  async detectLegacyState(params) {
    const preview = await collectRetiredStateWarnings(params);
    return preview.length > 0 ? { preview } : null;
  },
  async migrateLegacyState(params) {
    return { changes: [], warnings: await collectRetiredStateWarnings(params) };
  },
};
