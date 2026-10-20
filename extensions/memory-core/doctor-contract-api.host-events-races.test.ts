import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { createDoctorContext, resetDoctorPluginState } from "./doctor-contract-api.test-support.js";
import { hostEventsStateMigration } from "./src/migration/doctor-host-events.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    __setFsSafeTestHooksForTest(undefined);
    await resetDoctorPluginState();
    cleanup();
  }),
);

async function fixture(stage: "claim" | "archive" | "restore") {
  const root = tempDirs.make("openclaw-host-events-move-race-");
  const workspaceDir = path.join(root, "workspace");
  const eventDir = path.join(workspaceDir, "memory", ".dreams");
  const active = path.join(eventDir, "events.jsonl");
  const claim = path.join(eventDir, ".events.jsonl.doctor-importing");
  const archive = `${active}.migrated`;
  const contents =
    stage === "restore"
      ? "invalid json\n"
      : `${JSON.stringify({
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
  const source = stage === "claim" ? active : claim;
  const target = stage === "claim" ? claim : stage === "archive" ? archive : active;
  let swapped = false;
  let movedDirectory = false;
  __setFsSafeTestHooksForTest({
    beforeRootFallbackMutation: async (operation, destination) => {
      if (operation !== "move") {
        return;
      }
      if (destination === target) {
        swapped = true;
        await fs.rename(source, `${source}.retained`);
        await fs.mkdir(source);
        await fs.writeFile(path.join(source, "nested.md"), "user directory");
      } else if (stage === "claim" && destination === active) {
        movedDirectory = (await fs.lstat(claim)).isDirectory();
      }
    },
  });
  return {
    active,
    claim,
    archive,
    context,
    async expectPreserved() {
      expect(swapped).toBe(true);
      expect(movedDirectory).toBe(false);
      expect(await fs.readFile(path.join(source, "nested.md"), "utf8")).toBe("user directory");
      expect(await fs.readFile(`${source}.retained`, "utf8")).toBe(contents);
    },
    apply: () =>
      hostEventsStateMigration.migrateLegacyState({
        config: { agents: { list: [{ id: "main", workspace: workspaceDir }] } },
        env,
        stateDir: env.OPENCLAW_STATE_DIR,
        oauthDir: path.join(root, "oauth"),
        context,
      }),
  };
}

async function expectMissing(filePath: string) {
  await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

it.each(["claim", "archive", "restore"] as const)(
  "host-event migration rejects directory replacement during %s",
  async (stage) => {
    const { active, claim, archive, context, apply, expectPreserved } = await fixture(stage);
    if (stage === "claim") {
      await expect(apply()).rejects.toThrow();
    } else {
      const result = await apply();
      if (stage === "archive") {
        expect(result).toMatchObject({
          changes: [],
          warnings: [
            expect.stringContaining("Failed archiving Memory Core host events"),
            expect.stringContaining("Failed restoring claimed Memory Core host events"),
          ],
        });
        await expectMissing(archive);
        await expect(
          context
            .openPluginStateKeyedStore({
              namespace: "memory-host.event-migration-checkpoints",
              maxEntries: 10_000,
              overflowPolicy: "reject-new",
            })
            .entries(),
        ).resolves.toEqual([]);
      } else {
        expect(result.warnings).toContainEqual(
          expect.stringContaining("Failed restoring claimed Memory Core host events"),
        );
      }
    }
    await expectMissing(stage === "claim" ? claim : active);
    await expectPreserved();
  },
);
