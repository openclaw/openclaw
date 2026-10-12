import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { hostEventsStateMigration } from "./src/migration/doctor-host-events.js";
import { memorySidecarStateMigration } from "./src/migration/doctor-memory-sidecar.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const root = tempDirs.make("openclaw-memory-migration-inventory-");
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  return {
    root,
    stateDir,
    workspaceDir,
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_HOME: root },
    config: { agents: { entries: { main: { workspace: workspaceDir } } } },
  };
}

it("inventories host-event originals, claims, and archives without moving or importing them", async () => {
  const params = fixture();
  const collect = hostEventsStateMigration.collectBackupResources;
  if (!collect) {
    throw new Error("Missing host-event recovery inventory");
  }
  await expect(collect(params)).resolves.toEqual([]);
  const eventPath = path.join(params.workspaceDir, "memory", ".dreams", "events.jsonl");
  await fs.mkdir(path.dirname(eventPath), { recursive: true });
  await fs.writeFile(eventPath, "legacy event bytes\n");
  await expect(collect(params)).resolves.toEqual([
    { path: eventPath, kind: "file" },
    { path: path.join(path.dirname(eventPath), ".events.jsonl.doctor-importing"), kind: "file" },
    { path: `${eventPath}.migrated`, kind: "file" },
  ]);
  await expect(fs.readFile(eventPath, "utf8")).resolves.toBe("legacy event bytes\n");
  await expect(fs.readdir(path.dirname(eventPath))).resolves.toEqual(["events.jsonl"]);
  await expect(fs.access(params.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it("inventories sidecar imports and retry paths while preserving empty legacy files", async () => {
  const params = fixture();
  const legacyPath = path.join(params.root, "external-memory", "main.sqlite");
  const input = {
    ...params,
    config: { ...params.config, memorySearch: { store: { path: legacyPath } } },
  };
  const collect = memorySidecarStateMigration.collectBackupResources;
  if (!collect) {
    throw new Error("Missing sidecar recovery inventory");
  }
  await expect(collect(input)).resolves.toEqual([]);
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, "");
  const inventory = await collect(input);
  expect(inventory).toEqual(
    expect.arrayContaining([
      { path: legacyPath, kind: "file" },
      { path: `${legacyPath}.migrated`, kind: "file" },
      {
        path: path.join(params.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
        kind: "sqlite",
      },
      { path: path.join(params.stateDir, "memory", "main.sqlite"), kind: "file" },
      { path: path.join(params.stateDir, "memory", "main.sqlite-journal"), kind: "file" },
      expect.objectContaining({
        path: expect.stringMatching(/main\.retry-[a-f0-9]{12}\.sqlite$/u),
        kind: "file",
      }),
      // Retry copies carry every legacy companion, including rollback journals.
      expect.objectContaining({
        path: expect.stringMatching(/main\.retry-[a-f0-9]{12}\.sqlite-journal$/u),
        kind: "file",
      }),
    ]),
  );
  await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe("");
  await expect(fs.access(params.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
});
