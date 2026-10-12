import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDoctorContext,
  resetDoctorPluginState,
  type RawLegacyDoctorConfig,
} from "./doctor-contract-api.test-support.js";
import { hostEventsStateMigration } from "./src/migration/doctor-host-events.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    __setFsSafeTestHooksForTest(undefined);
    await resetDoctorPluginState();
    cleanup();
  }),
);

async function fixture(raw?: string) {
  const root = tempDirs.make("openclaw-host-events-move-race-");
  const workspaceDir = path.join(root, "workspace");
  const eventDir = path.join(workspaceDir, "memory", ".dreams");
  const active = path.join(eventDir, "events.jsonl");
  const claim = path.join(eventDir, ".events.jsonl.doctor-importing");
  const archive = `${active}.migrated`;
  const contents =
    raw ??
    `${JSON.stringify({
      type: "memory.recall.recorded",
      timestamp: "2026-07-01T00:00:00.000Z",
      query: "retained event",
      resultCount: 0,
      results: [],
    })}\n`;
  await fs.mkdir(eventDir, { recursive: true });
  await fs.writeFile(active, contents);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const context = createDoctorContext(env);
  const config: RawLegacyDoctorConfig = {
    agents: { list: [{ id: "main", workspace: workspaceDir }] },
  };
  return {
    active,
    claim,
    archive,
    contents,
    context,
    apply: () =>
      hostEventsStateMigration.migrateLegacyState({
        config,
        env,
        stateDir: env.OPENCLAW_STATE_DIR,
        oauthDir: path.join(root, "oauth"),
        context,
      }),
  };
}

async function substituteDirectory(filePath: string) {
  await fs.rename(filePath, `${filePath}.retained`);
  await fs.mkdir(filePath);
  await fs.writeFile(path.join(filePath, "nested.md"), "user directory");
}

describe("host-event migration file-only moves", () => {
  it("does not claim a discovered event file replaced by a directory", async () => {
    const { active, claim, contents, apply } = await fixture();
    let swapped = false;
    let movedDirectory = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation, destination) => {
        if (operation !== "move") {
          return;
        }
        if (destination === claim) {
          swapped = true;
          await substituteDirectory(active);
        } else if (destination === active) {
          movedDirectory = (await fs.lstat(claim)).isDirectory();
        }
      },
    });

    await expect(apply()).rejects.toThrow();

    expect(swapped).toBe(true);
    expect(movedDirectory).toBe(false);
    await expect(fs.readFile(path.join(active, "nested.md"), "utf8")).resolves.toBe(
      "user directory",
    );
    await expect(fs.readFile(`${active}.retained`, "utf8")).resolves.toBe(contents);
    await expect(fs.access(claim)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not archive a claim replaced by a directory after SQLite import", async () => {
    const { active, claim, archive, contents, context, apply } = await fixture();
    let swapped = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation, destination) => {
        if (operation === "move" && destination === archive) {
          swapped = true;
          await substituteDirectory(claim);
        }
      },
    });

    const result = await apply();

    expect(swapped).toBe(true);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Failed archiving Memory Core host events"),
      expect.stringContaining("Failed restoring claimed Memory Core host events"),
    ]);
    await expect(fs.access(archive)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(active)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(claim, "nested.md"), "utf8")).resolves.toBe(
      "user directory",
    );
    await expect(fs.readFile(`${claim}.retained`, "utf8")).resolves.toBe(contents);
    await expect(
      context
        .openPluginStateKeyedStore({
          namespace: "memory-host.event-migration-checkpoints",
          maxEntries: 10_000,
          overflowPolicy: "reject-new",
        })
        .entries(),
    ).resolves.toEqual([]);
  });

  it("does not restore a claim replaced by a directory after a blocked import", async () => {
    const { active, claim, contents, apply } = await fixture("invalid json\n");
    let swapped = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation, destination) => {
        if (operation === "move" && destination === active) {
          swapped = true;
          await substituteDirectory(claim);
        }
      },
    });

    const result = await apply();

    expect(swapped).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("Failed restoring claimed Memory Core host events"),
    );
    await expect(fs.access(active)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(claim, "nested.md"), "utf8")).resolves.toBe(
      "user directory",
    );
    await expect(fs.readFile(`${claim}.retained`, "utf8")).resolves.toBe(contents);
  });
});
