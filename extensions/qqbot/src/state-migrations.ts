import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import { buildQQBotStateKey } from "./engine/utils/state-keys.js";

type CredentialBackup = {
  accountId: string;
  appId: string;
  clientSecret: string;
  savedAt: string;
};

type CredentialBackupCandidate = {
  sourcePath: string;
  expectedSafeAccountId?: string;
};

const CREDENTIAL_BACKUPS_NAMESPACE = "credential-backups";
const MAX_CREDENTIAL_BACKUPS = 1000;

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readCredentialBackup(filePath: string): CredentialBackup | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<CredentialBackup>;
    if (
      typeof parsed.accountId !== "string" ||
      typeof parsed.appId !== "string" ||
      typeof parsed.clientSecret !== "string" ||
      !parsed.accountId ||
      !parsed.appId ||
      !parsed.clientSecret
    ) {
      return null;
    }
    return {
      accountId: parsed.accountId,
      appId: parsed.appId,
      clientSecret: parsed.clientSecret,
      savedAt:
        typeof parsed.savedAt === "string" && parsed.savedAt
          ? parsed.savedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function credentialBackupKey(accountId: string): string {
  return buildQQBotStateKey("credential-backup", accountId);
}

function credentialBackupPlan(
  candidate: CredentialBackupCandidate,
): ChannelLegacyStateMigrationPlan | null {
  const { sourcePath } = candidate;
  const backup = readCredentialBackup(sourcePath);
  if (!backup) {
    return null;
  }
  if (
    candidate.expectedSafeAccountId !== undefined &&
    safeName(backup.accountId) !== candidate.expectedSafeAccountId
  ) {
    return null;
  }
  return {
    kind: "plugin-state-import",
    label: "QQBot credential backup",
    sourcePath,
    targetPath: `plugin state:${CREDENTIAL_BACKUPS_NAMESPACE}`,
    pluginId: "qqbot",
    namespace: CREDENTIAL_BACKUPS_NAMESPACE,
    maxEntries: MAX_CREDENTIAL_BACKUPS,
    scopeKey: "",
    cleanupSource: "rename",
    preview: `- QQBot credential backup: ${sourcePath} -> plugin state (${CREDENTIAL_BACKUPS_NAMESPACE})`,
    readEntries: () => {
      const current = readCredentialBackup(sourcePath);
      return current
        ? [
            {
              key: credentialBackupKey(current.accountId),
              value: current,
            },
          ]
        : [];
    },
  };
}

function credentialBackupCandidates(params: {
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): CredentialBackupCandidate[] {
  const roots = new Set<string>([path.join(params.stateDir, "qqbot", "data")]);
  const home = params.env.HOME || params.env.USERPROFILE;
  if (home) {
    roots.add(path.join(home, ".openclaw", "qqbot", "data"));
  }
  const candidates = new Map<string, CredentialBackupCandidate>();
  for (const root of roots) {
    const accountFiles: CredentialBackupCandidate[] = [];
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (
          entry.isFile() &&
          entry.name.startsWith("credential-backup-") &&
          entry.name.endsWith(".json")
        ) {
          accountFiles.push({
            sourcePath: path.join(root, entry.name),
            expectedSafeAccountId: entry.name.slice("credential-backup-".length, -".json".length),
          });
        }
      }
    } catch {
      // Missing legacy directory means there is nothing to import.
    }
    for (const accountFile of accountFiles.toSorted((a, b) =>
      a.sourcePath.localeCompare(b.sourcePath),
    )) {
      candidates.set(accountFile.sourcePath, accountFile);
    }
    const single = path.join(root, "credential-backup.json");
    if (fileExists(single)) {
      candidates.set(single, { sourcePath: single });
    }
  }
  return [...candidates.values()];
}

export function detectQQBotLegacyStateMigrations(params: {
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): ChannelLegacyStateMigrationPlan[] {
  return credentialBackupCandidates(params).flatMap((candidate) => {
    const plan = credentialBackupPlan(candidate);
    return plan ? [plan] : [];
  });
}
