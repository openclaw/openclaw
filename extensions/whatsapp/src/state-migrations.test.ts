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
import { afterEach, expect, it, vi } from "vitest";
import { stateMigrations } from "../doctor-contract-api.js";
import { authFiles } from "./auth-files.test-support.js";

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

function fixture(seed = true) {
  const stateDir = tempDirs.make("openclaw-wa-auth-migration-");
  const oauthDir = path.join(stateDir, "credentials");
  fs.mkdirSync(oauthDir);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_OAUTH_DIR: oauthDir };
  const input: Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0] = {
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
  const source = (name: string) => path.join(oauthDir, name);
  const write = (name: string, bytes: string) => fs.writeFileSync(source(name), bytes);
  const read = (name: string) => fs.readFileSync(source(name), "utf8");
  const originals = new Map(
    seed
      ? authFiles.map((name) => [name, JSON.stringify({ synthetic: name }) + "\n"] as const)
      : [],
  );
  for (const [name, bytes] of originals) {
    write(name, bytes);
  }
  const targetDir = source("whatsapp/default");
  return {
    input,
    originals,
    source,
    write,
    read,
    targetDir,
    migrate: () => migration.migrateLegacyState(input),
    detect: () => migration.detectLegacyState(input),
    expectCopies(directory = oauthDir, suffix = "", retainedOnly = false) {
      for (const [name, bytes] of originals) {
        const file = path.join(directory, name + suffix);
        if (!retainedOnly || fs.existsSync(file)) {
          expect(fs.readFileSync(file, "utf8")).toBe(bytes);
        }
      }
    },
  };
}

async function expectInterruptedImport(f: ReturnType<typeof fixture>, phase: string) {
  const backupSource = migrationSdk.backupLegacyStateSource;
  const interrupted = vi
    .spyOn(migrationSdk, "backupLegacyStateSource")
    .mockImplementation(async (params) => {
      const backup = await backupSource(params);
      return {
        ...backup,
        removeSource(markSourceRemoved) {
          if (phase !== "before-cleanup") {
            backup.removeSource(markSourceRemoved);
          }
          if (!phase.endsWith(".json") || path.basename(params.filePath) === phase) {
            throw new Error("interrupted credential cleanup");
          }
        },
      };
    });
  try {
    await expect(f.migrate()).rejects.toThrow("interrupted credential cleanup");
  } finally {
    interrupted.mockRestore();
  }
}

it.each(["missing", "expired"])("preserves originals with %s authority", async (authority) => {
  const f = fixture();
  const access = f.input.context.channelIngressQueues![0]!;
  if (authority === "missing") {
    delete access.assertCurrent;
    expect(await f.migrate()).toMatchObject({
      changes: [],
      warnings: [expect.stringContaining("Update OpenClaw core")],
    });
  } else {
    access.assertCurrent = () => {
      throw new Error("offline authority expired");
    };
    await expect(f.migrate()).rejects.toThrow("offline authority expired");
  }
  expect(fs.readdirSync(f.input.oauthDir).toSorted()).toEqual(authFiles.toSorted());
  f.expectCopies();
});

it.each(["creds.json", "session-contact.json", "before-cleanup", "partial-cleanup"])(
  "preserves bytes and never relinks after logout at %s",
  async (phase) => {
    const f = fixture();
    const resumeBeforeLogout = phase.endsWith(".json");
    if (resumeBeforeLogout) {
      f.write("oauth.json", "unrelated-provider-state");
      fs.mkdirSync(f.source("nested"));
      f.write("nested/session-retained.json", "unrelated");
      fs.renameSync(f.source("creds.json"), f.source("creds.json.doctor-importing"));
      expect(await f.detect()).not.toBeNull();
    }
    await expectInterruptedImport(f, phase);
    if (resumeBeforeLogout) {
      expect((await f.migrate()).warnings).toEqual([]);
      f.expectCopies(f.input.oauthDir, ".migrated");
      for (const name of f.originals.keys()) {
        if (process.platform !== "win32") {
          expect(fs.statSync(f.source(name + ".migrated")).mode & 0o777).toBe(0o600);
        }
        expect(fs.existsSync(f.source(name))).toBe(false);
      }
      expect(f.read("oauth.json")).toBe("unrelated-provider-state");
      expect(f.read("nested/session-retained.json")).toBe("unrelated");
      expect(await f.detect()).toBeNull();
    }
    f.expectCopies(f.targetDir);
    fs.rmSync(f.targetDir, { recursive: true });
    const result = await f.migrate();
    if (resumeBeforeLogout) {
      expect(result).toEqual({ changes: [], warnings: [] });
    } else {
      expect(result).toMatchObject({
        changes: [],
        warnings: [expect.stringContaining("will not recreate credentials after logout")],
      });
      expect(result.warningDisposition).toBeUndefined();
      f.expectCopies(f.input.oauthDir, ".migrated");
      f.expectCopies(f.input.oauthDir, "", true);
    }
    expect(fs.existsSync(f.targetDir)).toBe(false);
  },
);

it.each([
  ["creds.json", false],
  ["session-contact.json", false],
  ["session-contact.json", true],
  ["session-other.json", true],
] as const)(
  "preserves both credential sets (conflict: %s, incomplete: %s)",
  async (name, incomplete) => {
    const f = fixture();
    fs.mkdirSync(f.targetDir, { recursive: true });
    if (!incomplete) {
      f.write("whatsapp/default/creds.json", f.originals.get("creds.json")!);
    }
    f.write("whatsapp/default/" + name, "canonical-bytes");
    const before = fs.readdirSync(f.targetDir);
    const result = await f.migrate();
    expect(result.warnings).toHaveLength(1);
    expect(result.warningDisposition).toBe(incomplete ? undefined : "recoverable");
    expect(fs.readdirSync(f.targetDir)).toEqual(before);
    expect(f.read("whatsapp/default/" + name)).toBe("canonical-bytes");
    f.expectCopies();
    f.expectCopies(f.input.oauthDir, ".migrated");
  },
);

it("preserves orphaned keys until their original credential identity is restored", async () => {
  const f = fixture();
  fs.unlinkSync(f.source("creds.json"));
  f.originals.delete("creds.json");
  const result = await f.migrate();
  expect(result).toMatchObject({
    changes: [],
    warnings: [expect.stringContaining("restore the original creds.json")],
  });
  expect(result.warningDisposition).toBeUndefined();
  expect(fs.existsSync(f.source("whatsapp"))).toBe(false);
  f.expectCopies();
  f.expectCopies(f.input.oauthDir, ".migrated");
});

it.each([false, true])(
  "recovers owned root claims unless originals conflict: %s",
  async (conflict) => {
    const f = fixture(false);
    const claim = "creds.json.doctor-importing";
    f.write(claim, "claimed-original");
    f.write("session-contact.json", "retained-session");
    f.input.config = {
      channels: { whatsapp: { accounts: { work: { authDir: f.input.oauthDir } } } },
    };
    if (conflict) {
      f.write("creds.json", "different-original");
    }
    expect(await f.detect()).not.toBeNull();
    if (conflict) {
      await expect(f.migrate()).rejects.toThrow("disagree");
      expect(f.read("creds.json")).toBe("different-original");
      expect(f.read(claim)).toBe("claimed-original");
    } else {
      expect((await f.migrate()).warnings).toEqual([]);
      expect(f.read("creds.json")).toBe("claimed-original");
      expect(f.read("creds.json.migrated")).toBe("claimed-original");
      expect(fs.existsSync(f.source(claim))).toBe(false);
      expect(await f.detect()).toBeNull();
    }
    expect(f.read("session-contact.json")).toBe("retained-session");
    expect(fs.existsSync(f.source("whatsapp"))).toBe(false);
  },
);

it.each(["default", "work"])("preserves explicit root owner %s", async (account) => {
  const f = fixture();
  f.input.config = {
    channels: { whatsapp: { accounts: { [account]: { authDir: f.input.oauthDir } } } },
  };
  expect(await f.detect()).toBeNull();
  expect(await f.migrate()).toEqual({ changes: [], warnings: [] });
  expect(fs.readdirSync(f.input.oauthDir).toSorted()).toEqual(authFiles.toSorted());
  f.expectCopies();
});
