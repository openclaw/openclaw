import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { resolveUserPath } from "openclaw/plugin-sdk/account-resolution";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  assertNoSymlinkParentsSync,
  readRegularFileSync,
  root,
} from "openclaw/plugin-sdk/file-access-runtime";
// The published 2026.9.7 host loads canonical state without these newer repair capabilities.
import * as migrationSdk from "openclaw/plugin-sdk/runtime-doctor-migrations";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveOAuthDir } from "openclaw/plugin-sdk/state-paths";
import { isWhatsAppBaileysAuthFileName } from "./creds-files.js";

type MigrationInput = Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];
type AuthSource = { name: string; filePath: string; claimPaths: string[] };
type AuthImportReceipt = { targetDigest: string };

function credentialSetDigest(files: ReadonlyMap<string, string>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...files].toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      ),
    )
    .digest("hex");
}

function comparablePath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function explicitlyOwnsRoot(params: MigrationInput): boolean {
  const channel = params.config.channels?.whatsapp;
  const oauthRoot = comparablePath(params.oauthDir);
  const configuredOwners = Object.values(channel?.accounts ?? {});
  return configuredOwners.some((owner) => {
    const configured = owner?.authDir?.trim();
    return configured && comparablePath(resolveUserPath(configured, params.env)) === oauthRoot;
  });
}

async function listSources(params: MigrationInput): Promise<AuthSource[]> {
  try {
    if (!(await fs.lstat(params.oauthDir)).isDirectory()) {
      throw new Error("WhatsApp legacy credential root must be a regular directory.");
    }
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const sources = new Map<string, AuthSource>();
  for (const entry of await fs.readdir(params.oauthDir, { withFileTypes: true })) {
    const name = migrationSdk.resolveLegacyMigrationSourcePath?.(entry.name) ?? entry.name;
    if (!entry.isFile() || !isWhatsAppBaileysAuthFileName(name)) {
      continue;
    }
    const source = sources.get(name) ?? {
      name,
      filePath: path.join(params.oauthDir, name),
      claimPaths: [],
    };
    if (name !== entry.name) {
      source.claimPaths.push(path.join(params.oauthDir, entry.name));
    }
    sources.set(name, source);
  }
  return (
    [...sources.values()]
      .filter((source) => !explicitlyOwnsRoot(params) || source.claimPaths.length > 0)
      // Publish the complete destination first; retain source identity until every key is removed.
      .toSorted(
        (left, right) =>
          Number(left.name === "creds.json") - Number(right.name === "creds.json") ||
          left.name.localeCompare(right.name),
      )
  );
}

export const whatsappLegacyStateMigration: PluginDoctorStateMigration = {
  id: "whatsapp-legacy-state",
  label: "WhatsApp legacy state",
  collectBackupResources: ({ env, stateDir }) => [
    { path: resolveOAuthDir(env, stateDir), kind: "directory" },
    { path: path.join(stateDir, "state", "openclaw.sqlite"), kind: "sqlite" },
  ],
  async detectLegacyState(params) {
    const sources = await listSources(params);
    return sources.length > 0
      ? {
          preview: [
            explicitlyOwnsRoot(params)
              ? `- Restore ${sources.length} interrupted WhatsApp credential claims in the configured root`
              : `- Move ${sources.length} WhatsApp credential files into the default account`,
          ],
        }
      : null;
  },
  async migrateLegacyState(params) {
    const sources = await listSources(params);
    const changes: string[] = [];
    const warnings: string[] = [];
    const warn = (message: string, recoverable = false) => ({
      changes,
      warnings: [message],
      ...(recoverable ? { warningDisposition: "recoverable" as const } : {}),
    });
    if (sources.length === 0) {
      return { changes, warnings };
    }
    const assertCurrent = params.context.channelIngressQueues?.find(
      (entry) => entry.channelId === "whatsapp",
    )?.assertCurrent;
    const { backupLegacyStateSource } = migrationSdk;
    if (!assertCurrent || !backupLegacyStateSource) {
      return warn(
        "WhatsApp credential import requires offline Doctor repair. Update OpenClaw core and run openclaw doctor --fix; original files remain unchanged.",
      );
    }
    const backups = [];
    for (const source of sources) {
      backups.push({
        source,
        backup: await backupLegacyStateSource({
          filePath: source.filePath,
          claimPaths: source.claimPaths,
          assertCurrent,
        }),
      });
    }
    if (explicitlyOwnsRoot(params)) {
      return {
        changes: backups.map(
          ({ source, backup }) =>
            `Restored WhatsApp auth ${source.name} in the configured root; backup: ${backup.backupPath}`,
        ),
        warnings,
      };
    }
    const credentials = await root(params.oauthDir, {
      assertBeforeMutation: assertCurrent,
      symlinks: "reject",
      hardlinks: "reject",
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    const targetDir = path.join("whatsapp", DEFAULT_ACCOUNT_ID);
    const targetCreds = path.join(targetDir, "creds.json");
    const canonical = (await credentials.exists(targetCreds))
      ? await credentials.read(targetCreds)
      : undefined;
    const legacy = backups.find(({ source }) => source.name === "creds.json");
    if (!legacy) {
      return warn(
        "WhatsApp shared-root key files have no creds.json identity. Kept all original files and private .migrated backups; restore the original creds.json before retrying Doctor.",
        Boolean(canonical),
      );
    }
    if (canonical && !canonical.buffer.equals(legacy.backup.bytes)) {
      return warn(
        "WhatsApp canonical credentials differ from the legacy shared root. Kept both complete sets and private .migrated backups; choose the intended authDir before removing either set.",
        true,
      );
    }
    const targetNames = await fs
      .readdir(path.join(params.oauthDir, targetDir))
      .catch((error: unknown) => {
        if (extractErrorCode(error) === "ENOENT") {
          return [];
        }
        throw error;
      });
    const targetFiles = new Map<string, string>();
    for (const name of targetNames.filter(isWhatsAppBaileysAuthFileName)) {
      const target = await credentials.read(path.join(targetDir, name));
      targetFiles.set(name, createHash("sha256").update(target.buffer).digest("hex"));
    }
    const receiptStore = params.context.openPluginStateKeyedStore<AuthImportReceipt>({
      namespace: "auth-directory-migrations",
      maxEntries: 4_096,
      overflowPolicy: "reject-new",
    });
    if (!receiptStore.withCurrent) {
      return warn(
        "WhatsApp credential import requires current offline storage authority. Update OpenClaw core and rerun Doctor; original credentials remain unchanged.",
      );
    }
    const receipts = receiptStore.withCurrent({ assertCurrent });
    const sourceIdentity = legacy.backup.snapshot.sha256;
    const previous = await receipts.lookup(sourceIdentity);
    if (previous && (!canonical || previous.targetDigest !== credentialSetDigest(targetFiles))) {
      return warn(
        "WhatsApp credential migration previously started, but its complete canonical credential set is absent or changed. Kept source files and backups; restore the complete intended account or select its authDir explicitly. Doctor will not recreate credentials after logout.",
        Boolean(canonical),
      );
    }
    if (!canonical) {
      const sourceNames = new Set(sources.map((source) => source.name));
      if (
        targetNames.some((name) => isWhatsAppBaileysAuthFileName(name) && !sourceNames.has(name))
      ) {
        return warn(
          "WhatsApp default account contains unmatched auth files without creds.json. Kept the incomplete account and legacy credentials separate; choose the intended credential set before retrying Doctor.",
        );
      }
    }
    for (const { source, backup } of backups) {
      const relativePath = path.join(targetDir, source.name);
      if (
        (await credentials.exists(relativePath)) &&
        !(await credentials.read(relativePath)).buffer.equals(backup.bytes)
      ) {
        return warn(
          `WhatsApp auth ${source.name} differs between the default account and legacy shared root. Kept both copies and a private .migrated backup; choose the intended credential set before retrying Doctor.`,
          Boolean(canonical),
        );
      }
    }
    if (!previous) {
      const expected = new Map(targetFiles);
      for (const { source, backup } of backups) {
        backup.assertUnchanged();
        expected.set(source.name, backup.snapshot.sha256);
      }
      // Persist intent before publishing credentials, so a crash followed by logout cannot relink.
      if (
        !(await receipts.registerIfAbsent(sourceIdentity, {
          targetDigest: credentialSetDigest(expected),
        }))
      ) {
        throw new Error("WhatsApp credential migration receipt changed; rerun Doctor.");
      }
    }
    await credentials.mkdir(targetDir, { private: true });
    const targets = [];
    for (const { source, backup } of backups) {
      backup.assertUnchanged();
      const relativePath = path.join(targetDir, source.name);
      if (!(await credentials.exists(relativePath))) {
        await credentials.create(relativePath, backup.bytes, {
          atomic: true,
          durable: true,
          mode: 0o600,
          private: true,
        });
      }
      const target = await credentials.read(relativePath);
      if (!target.buffer.equals(backup.bytes)) {
        throw new Error(
          "WhatsApp canonical credentials changed during import; original files retained.",
        );
      }
      targets.push({
        source,
        backup,
        target,
        targetPath: path.join(params.oauthDir, relativePath),
      });
    }
    for (const { source, backup, target, targetPath } of targets) {
      backup.removeSource(() => {
        assertCurrent();
        assertNoSymlinkParentsSync({
          rootDir: params.oauthDir,
          targetPath: path.dirname(targetPath),
          requireDirectories: true,
        });
        const current = readRegularFileSync({ filePath: targetPath });
        if (
          current.stat.dev !== target.stat.dev ||
          current.stat.ino !== target.stat.ino ||
          !current.buffer.equals(target.buffer)
        ) {
          throw new Error(
            "WhatsApp canonical credentials changed during import; original backup retained.",
          );
        }
        return undefined;
      });
      changes.push(
        `Moved WhatsApp auth ${source.name} into the default account; backup: ${backup.backupPath}`,
      );
    }
    return { changes, warnings };
  },
};
