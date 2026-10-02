import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

async function retiredSourceWarnings(stateDir: string): Promise<string[]> {
  const imessageDir = path.join(stateDir, "imessage");
  const catchupDir = path.join(imessageDir, "catchup");
  let catchupFiles: string[];
  try {
    catchupFiles = await fs.readdir(catchupDir);
  } catch (error) {
    if (extractErrorCode(error) !== "ENOENT") {
      throw error;
    }
    catchupFiles = [];
  }
  const candidates = [
    path.join(imessageDir, "reply-cache.jsonl"),
    path.join(imessageDir, "sent-echoes.jsonl"),
    ...catchupFiles
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map((name) => path.join(catchupDir, name)),
  ];
  const warnings: string[] = [];
  for (const sourcePath of candidates) {
    try {
      await fs.lstat(sourcePath);
    } catch (error) {
      if (extractErrorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
    warnings.push(
      `Preserved retired iMessage state at ${sourcePath}. Install OpenClaw 2026.9.5, run "openclaw doctor --fix", then upgrade to latest. See https://docs.openclaw.ai/install/updating#upgrading-very-old-versions.`,
    );
  }
  return warnings;
}

export const imessageRetiredStateMigration: PluginDoctorStateMigration = {
  id: "imessage-legacy-state",
  label: "iMessage legacy state",
  async detectLegacyState({ stateDir }) {
    const preview = await retiredSourceWarnings(stateDir);
    return preview.length > 0 ? { preview } : null;
  },
  async migrateLegacyState({ stateDir }) {
    return { changes: [], warnings: await retiredSourceWarnings(stateDir) };
  },
};
