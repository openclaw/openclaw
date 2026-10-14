import fs from "node:fs";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import * as migrationSdk from "openclaw/plugin-sdk/runtime-doctor-migrations";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "../doctor-contract-api.js";

vi.mock("openclaw/plugin-sdk/security-runtime", () => {
  throw new Error("Doctor migration detection must not load the broad security runtime");
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);
const migration = stateMigrations[0]!;
const authFiles = [
  "creds.json",
  "creds.json.bak",
  "pre-key-1.json",
  "session-contact.json",
  "sender-key-group.json",
  "sender-key-memory-group.json",
  "app-state-sync-key-contact.json",
  "app-state-sync-version-contact.json",
  "lid-mapping-15551234567.json",
  "device-list-15551234567.json",
  "tctoken-15551234567.json",
  "identity-key-15551234567.json",
];

function fixture(): Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0] {
  const stateDir = tempDirs.make("openclaw-wa-auth-migration-");
  const oauthDir = path.join(stateDir, "credentials");
  fs.mkdirSync(oauthDir);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_OAUTH_DIR: oauthDir };
  return {
    config: {},
    env,
    oauthDir,
    stateDir,
    context: {
      openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
        return createPluginStateKeyedStoreForTests<T>("whatsapp", { ...options, env });
      },
      channelIngressQueues: [
        {
          channelId: "whatsapp",
          assertCurrent() {},
          openChannelIngressQueueForInspection: vi.fn(),
          listChannelIngressQueueAccountIds: async () => [],
        },
      ],
    },
  };
}

function seedSources(oauthDir: string): Map<string, string> {
  const originals = new Map(
    authFiles.map((name) => [name, `${JSON.stringify({ synthetic: name })}\n`]),
  );
  for (const [name, bytes] of originals) {
    fs.writeFileSync(path.join(oauthDir, name), bytes);
  }
  return originals;
}

describe("WhatsApp legacy credential import", () => {
  it.each(["missing", "expired"] as const)(
    "preserves all source bytes when offline host authority is %s",
    async (authority) => {
      const input = fixture();
      const originals = seedSources(input.oauthDir);
      const access = input.context.channelIngressQueues![0]!;
      if (authority === "missing") {
        delete access.assertCurrent;
        expect(await migration.migrateLegacyState(input)).toMatchObject({
          changes: [],
          warnings: [expect.stringContaining("Update OpenClaw core")],
        });
      } else {
        access.assertCurrent = () => {
          throw new Error("offline authority expired");
        };
        await expect(migration.migrateLegacyState(input)).rejects.toThrow(
          "offline authority expired",
        );
      }
      expect(fs.readdirSync(input.oauthDir).toSorted()).toEqual(authFiles.toSorted());
      for (const [name, bytes] of originals) {
        expect(fs.readFileSync(path.join(input.oauthDir, name), "utf8")).toBe(bytes);
      }
    },
  );

  it.each(["creds.json", "session-contact.json"])(
    "preserves all bytes across cleanup interruption after %s and later logout",
    async (interruptedName) => {
      const input = fixture();
      const originals = seedSources(input.oauthDir);
      const unrelated = path.join(input.oauthDir, "oauth.json");
      fs.writeFileSync(unrelated, "unrelated-provider-state");
      fs.mkdirSync(path.join(input.oauthDir, "nested"));
      fs.writeFileSync(path.join(input.oauthDir, "nested", "session-retained.json"), "unrelated");
      fs.renameSync(
        path.join(input.oauthDir, "creds.json"),
        path.join(input.oauthDir, "creds.json.doctor-importing"),
      );
      const targetDir = path.join(input.oauthDir, "whatsapp", "default");

      expect(await migration.detectLegacyState(input)).not.toBeNull();
      const backupSource = migrationSdk.backupLegacyStateSource;
      const interrupted = vi
        .spyOn(migrationSdk, "backupLegacyStateSource")
        .mockImplementation(async (params) => {
          const backup = await backupSource(params);
          return {
            ...backup,
            removeSource(markSourceRemoved) {
              backup.removeSource(markSourceRemoved);
              if (path.basename(params.filePath) === interruptedName) {
                throw new Error("interrupted after credential cleanup");
              }
            },
          };
        });
      try {
        await expect(migration.migrateLegacyState(input)).rejects.toThrow(
          "interrupted after credential cleanup",
        );
      } finally {
        interrupted.mockRestore();
      }
      expect((await migration.migrateLegacyState(input)).warnings).toEqual([]);
      for (const [name, bytes] of originals) {
        expect(fs.readFileSync(path.join(targetDir, name), "utf8")).toBe(bytes);
        const backupPath = path.join(input.oauthDir, `${name}.migrated`);
        expect(fs.readFileSync(backupPath, "utf8")).toBe(bytes);
        if (process.platform !== "win32") {
          expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
        }
        expect(fs.existsSync(path.join(input.oauthDir, name))).toBe(false);
      }
      expect(fs.readFileSync(unrelated, "utf8")).toBe("unrelated-provider-state");
      expect(
        fs.readFileSync(path.join(input.oauthDir, "nested", "session-retained.json"), "utf8"),
      ).toBe("unrelated");
      expect(await migration.detectLegacyState(input)).toBeNull();
      fs.rmSync(targetDir, { recursive: true });
      expect(await migration.migrateLegacyState(input)).toEqual({ changes: [], warnings: [] });
      expect(fs.existsSync(targetDir)).toBe(false);
    },
  );

  it.each(["before-cleanup", "partial-cleanup"] as const)(
    "does not relink after logout follows a %s interruption",
    async (phase) => {
      const input = fixture();
      const originals = seedSources(input.oauthDir);
      const backupSource = migrationSdk.backupLegacyStateSource;
      const interrupted = vi
        .spyOn(migrationSdk, "backupLegacyStateSource")
        .mockImplementation(async (params) => {
          const backup = await backupSource(params);
          return {
            ...backup,
            removeSource(markSourceRemoved) {
              if (phase === "partial-cleanup") {
                backup.removeSource(markSourceRemoved);
              }
              throw new Error("interrupted credential cleanup");
            },
          };
        });
      try {
        await expect(migration.migrateLegacyState(input)).rejects.toThrow(
          "interrupted credential cleanup",
        );
      } finally {
        interrupted.mockRestore();
      }
      const targetDir = path.join(input.oauthDir, "whatsapp", "default");
      for (const [name, bytes] of originals) {
        expect(fs.readFileSync(path.join(targetDir, name), "utf8")).toBe(bytes);
      }
      fs.rmSync(targetDir, { recursive: true });

      const result = await migration.migrateLegacyState(input);

      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining("will not recreate credentials after logout"),
      ]);
      expect(result.warningDisposition).toBeUndefined();
      expect(fs.existsSync(targetDir)).toBe(false);
      for (const [name, bytes] of originals) {
        expect(fs.readFileSync(path.join(input.oauthDir, `${name}.migrated`), "utf8")).toBe(bytes);
        const source = path.join(input.oauthDir, name);
        if (fs.existsSync(source)) {
          expect(fs.readFileSync(source, "utf8")).toBe(bytes);
        }
      }
    },
  );

  it.each(["creds.json", "session-contact.json", "incomplete-canonical", "disjoint-incomplete"])(
    "preserves both credential sets when %s conflicts",
    async (conflict) => {
      const input = fixture();
      const originals = seedSources(input.oauthDir);
      const targetDir = path.join(input.oauthDir, "whatsapp", "default");
      fs.mkdirSync(targetDir, { recursive: true });
      const incomplete = conflict.endsWith("incomplete") || conflict === "incomplete-canonical";
      if (!incomplete) {
        fs.writeFileSync(path.join(targetDir, "creds.json"), originals.get("creds.json")!);
      }
      const targetName =
        conflict === "disjoint-incomplete"
          ? "session-other.json"
          : conflict === "incomplete-canonical"
            ? "session-contact.json"
            : conflict;
      fs.writeFileSync(path.join(targetDir, targetName), "canonical-bytes");
      const before = fs.readdirSync(targetDir);
      const result = await migration.migrateLegacyState(input);
      expect(result.warnings).toHaveLength(1);
      expect(result.warningDisposition).toBe(incomplete ? undefined : "recoverable");
      expect(fs.readdirSync(targetDir)).toEqual(before);
      expect(fs.readFileSync(path.join(targetDir, targetName), "utf8")).toBe("canonical-bytes");
      for (const [name, bytes] of originals) {
        expect(fs.readFileSync(path.join(input.oauthDir, name), "utf8")).toBe(bytes);
        expect(fs.readFileSync(path.join(input.oauthDir, `${name}.migrated`), "utf8")).toBe(bytes);
      }
    },
  );

  it("preserves orphaned keys until their original credential identity is restored", async () => {
    const input = fixture();
    const originals = seedSources(input.oauthDir);
    fs.unlinkSync(path.join(input.oauthDir, "creds.json"));
    originals.delete("creds.json");

    const result = await migration.migrateLegacyState(input);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("restore the original creds.json")]);
    expect(result.warningDisposition).toBeUndefined();
    expect(fs.existsSync(path.join(input.oauthDir, "whatsapp"))).toBe(false);
    for (const [name, bytes] of originals) {
      expect(fs.readFileSync(path.join(input.oauthDir, name), "utf8")).toBe(bytes);
      expect(fs.readFileSync(path.join(input.oauthDir, `${name}.migrated`), "utf8")).toBe(bytes);
    }
  });

  it.each([false, true])(
    "recovers an explicitly owned root claim unless the original conflicts: %s",
    async (conflict) => {
      const input = fixture();
      const original = path.join(input.oauthDir, "creds.json");
      const claim = `${original}.doctor-importing`;
      fs.writeFileSync(claim, "claimed-original");
      fs.writeFileSync(path.join(input.oauthDir, "session-contact.json"), "retained-session");
      input.config = {
        channels: { whatsapp: { accounts: { work: { authDir: input.oauthDir } } } },
      };
      if (conflict) {
        fs.writeFileSync(original, "different-original");
      }
      expect(await migration.detectLegacyState(input)).not.toBeNull();
      if (conflict) {
        await expect(migration.migrateLegacyState(input)).rejects.toThrow("disagree");
        expect(fs.readFileSync(original, "utf8")).toBe("different-original");
        expect(fs.readFileSync(claim, "utf8")).toBe("claimed-original");
      } else {
        expect((await migration.migrateLegacyState(input)).warnings).toEqual([]);
        expect(fs.readFileSync(original, "utf8")).toBe("claimed-original");
        expect(fs.readFileSync(`${original}.migrated`, "utf8")).toBe("claimed-original");
        expect(fs.existsSync(claim)).toBe(false);
        expect(await migration.detectLegacyState(input)).toBeNull();
      }
      expect(fs.readFileSync(path.join(input.oauthDir, "session-contact.json"), "utf8")).toBe(
        "retained-session",
      );
      expect(fs.existsSync(path.join(input.oauthDir, "whatsapp"))).toBe(false);
    },
  );

  it.each(["default", "named"])("preserves an explicit %s account root owner", async (account) => {
    const input = fixture();
    const originals = seedSources(input.oauthDir);
    input.config = {
      channels: {
        whatsapp: {
          accounts: { [account === "default" ? "default" : "work"]: { authDir: input.oauthDir } },
        },
      },
    };
    expect(await migration.detectLegacyState(input)).toBeNull();
    expect(await migration.migrateLegacyState(input)).toEqual({ changes: [], warnings: [] });
    expect(fs.readdirSync(input.oauthDir).toSorted()).toEqual(authFiles.toSorted());
    for (const [name, bytes] of originals) {
      expect(fs.readFileSync(path.join(input.oauthDir, name), "utf8")).toBe(bytes);
    }
  });
});
