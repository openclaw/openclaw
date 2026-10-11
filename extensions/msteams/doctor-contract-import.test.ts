import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

// mock-isolation: Doctor must inspect legacy state before plugin runtime initialization.
vi.mock("./src/runtime.js", () => {
  throw new Error("Doctor imported the Teams runtime");
});

import { stateMigrations } from "./doctor-contract-api.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("checks absent delegated tokens without loading the Teams runtime", async () => {
  const root = tempDirs.make("msteams-doctor-import-");
  const migration = stateMigrations.find(
    (entry) => entry.id === "msteams-delegated-token-json-to-plugin-state",
  );
  expect(migration).toBeDefined();
  await expect(
    migration!.detectLegacyState({
      config: {},
      env: { OPENCLAW_STATE_DIR: root },
      stateDir: root,
      oauthDir: path.join(root, "oauth"),
    }),
  ).resolves.toBeNull();
});
