import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  registerResolvedAgentDir,
  resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir,
} from "./agent-dir-registry.js";

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("keeps maintenance directory lookups current without retaining native watches", async () => {
  const root = tempDirs.make("agent-directory-maintenance-");
  const original = path.join(root, "original");
  const replacement = path.join(root, "replacement");
  const alias = path.join(root, "alias");
  fs.mkdirSync(original);
  fs.mkdirSync(replacement);
  fs.symlinkSync(original, alias, process.platform === "win32" ? "junction" : "dir");
  const watch = vi.spyOn(fs, "watch");
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
  });
  try {
    maintenance.run(() => {
      registerResolvedAgentDir({ agentId: "main", agentDir: alias });
      expect(watch).not.toHaveBeenCalled();
      expect(resolveRegisteredAgentIdForDir(alias)).toBe("main");
      fs.unlinkSync(alias);
      fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
      expect(resolveRegisteredAgentIdForDir(alias)).toBeUndefined();
      expect(resolveRegisteredAgentIdForDir(original)).toBe("main");
      expect(watch).not.toHaveBeenCalled();
    });
  } finally {
    maintenance.run(() => unregisterResolvedAgentDir({ agentId: "main", agentDir: original }));
    await maintenance.close();
  }
});
