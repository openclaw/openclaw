// Zalouser API module exposes the plugin public contract.
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isZaloCredentialRevocation,
  normalizeStoredZaloCredentials,
  normalizeZalouserCredentialProfile,
  resolveLegacyZalouserCredentialsDir,
  resolveLegacyZalouserCredentialsPath,
  zalouserCredentialStoreKey,
  ZALOUSER_CREDENTIALS_MAX_ENTRIES,
  ZALOUSER_CREDENTIALS_NAMESPACE,
  type ZaloCredentialStateRecord,
  type StoredZaloCredentials,
} from "./src/session-state.js";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";

type LegacyZalouserCredentialSource = {
  filePath: string;
  profile: string;
};

async function collectLegacyZalouserCredentialSources(
  env: NodeJS.ProcessEnv,
): Promise<LegacyZalouserCredentialSource[]> {
  const credentialsDir = resolveLegacyZalouserCredentialsDir(env);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(credentialsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === "credentials.json" ||
          (entry.name.startsWith("credentials-") && entry.name.endsWith(".json"))),
    )
    .flatMap((entry) => {
      let profile = "default";
      if (entry.name !== "credentials.json") {
        try {
          profile = decodeURIComponent(entry.name.slice("credentials-".length, -".json".length));
        } catch {
          return [];
        }
      }
      const normalizedProfile = normalizeZalouserCredentialProfile(profile);
      const filePath = path.join(credentialsDir, entry.name);
      return resolveLegacyZalouserCredentialsPath(normalizedProfile, env) === filePath
        ? [{ filePath, profile: normalizedProfile }]
        : [];
    })
    .toSorted((left, right) => left.profile.localeCompare(right.profile));
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "zalouser-credentials-json-to-plugin-state",
    label: "Zalo Personal credentials",
    async detectLegacyState(params) {
      const sources = await collectLegacyZalouserCredentialSources(params.env);
      return sources.length > 0
        ? {
            preview: [
              `- Zalo Personal credentials: ${sources.length} ${sources.length === 1 ? "file" : "files"} -> plugin state (${ZALOUSER_CREDENTIALS_NAMESPACE})`,
            ],
          }
        : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const store = params.context.openPluginStateKeyedStore<ZaloCredentialStateRecord>({
        namespace: ZALOUSER_CREDENTIALS_NAMESPACE,
        maxEntries: ZALOUSER_CREDENTIALS_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      for (const source of await collectLegacyZalouserCredentialSources(params.env)) {
        let credentials: StoredZaloCredentials | null = null;
        try {
          const raw = JSON.parse(await fs.readFile(source.filePath, "utf8")) as unknown;
          const createdAt =
            isRecord(raw) && typeof raw.createdAt === "string" && raw.createdAt
              ? raw.createdAt
              : (await fs.stat(source.filePath)).mtime.toISOString();
          credentials = normalizeStoredZaloCredentials(
            isRecord(raw) ? { ...raw, createdAt } : raw,
            source.profile,
          );
        } catch {
          // Report the same fail-closed result as a structurally invalid file.
        }
        if (!credentials) {
          warnings.push(
            `Left invalid Zalo Personal credential legacy source in place for profile ${source.profile}`,
          );
          continue;
        }
        const key = zalouserCredentialStoreKey(source.profile);
        const stored = await store.lookup(key);
        if (isZaloCredentialRevocation(stored, source.profile)) {
          changes.push(
            `Archived revoked Zalo Personal credential legacy source for profile ${source.profile}`,
          );
          await archiveLegacyStateSource({
            filePath: source.filePath,
            label: "Zalo Personal credentials",
            changes,
            warnings,
          });
          continue;
        }
        const existing = normalizeStoredZaloCredentials(stored, source.profile);
        if (existing && JSON.stringify(existing) !== JSON.stringify(credentials)) {
          warnings.push(
            `Kept existing Zalo Personal credentials for profile ${source.profile}; left differing legacy source in place`,
          );
          continue;
        }
        if (!existing) {
          try {
            await store.registerIfAbsent(key, credentials);
          } catch (error) {
            warnings.push(
              `Failed importing Zalo Personal credentials for profile ${source.profile}: ${String(error)}; left legacy source in place`,
            );
            continue;
          }
        }
        const persisted = normalizeStoredZaloCredentials(await store.lookup(key), source.profile);
        if (!persisted || JSON.stringify(persisted) !== JSON.stringify(credentials)) {
          warnings.push(
            `Failed verifying Zalo Personal credentials for profile ${source.profile}; left legacy source in place`,
          );
          continue;
        }
        changes.push(`Migrated Zalo Personal credentials for profile ${source.profile}`);
        await archiveLegacyStateSource({
          filePath: source.filePath,
          label: "Zalo Personal credentials",
          changes,
          warnings,
        });
      }
      return { changes, warnings };
    },
  },
];
