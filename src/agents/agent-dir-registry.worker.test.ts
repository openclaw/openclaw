import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  registerResolvedAgentDir,
  resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir,
} from "./agent-dir-registry.js";

vi.mock("node:worker_threads", () => ({ isMainThread: false }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("keeps worker lookups current without retaining ancestor watchers", () => {
  const root = tempDirs.make("agent-directory-worker-");
  const original = path.join(root, "original");
  const replacement = path.join(root, "replacement");
  const alias = path.join(root, "alias");
  fs.mkdirSync(original);
  fs.mkdirSync(replacement);
  fs.symlinkSync(original, alias, process.platform === "win32" ? "junction" : "dir");
  const watch = vi.spyOn(fs, "watch");
  registerResolvedAgentDir({ agentId: "main", agentDir: alias });
  try {
    expect(resolveRegisteredAgentIdForDir(alias)).toBe("main");
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
    expect(resolveRegisteredAgentIdForDir(alias)).toBeUndefined();
    expect(resolveRegisteredAgentIdForDir(original)).toBe("main");
    expect(watch).not.toHaveBeenCalled();
  } finally {
    unregisterResolvedAgentDir({ agentId: "main", agentDir: original });
  }
});
