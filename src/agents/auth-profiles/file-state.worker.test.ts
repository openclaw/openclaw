import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { authProfileSourceExists } from "./file-state.js";

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: false,
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("reads current source presence in workers without retaining directory watches", () => {
  const directory = temporary.make("auth-worker-source-presence-");
  const source = path.join(directory, "legacy.json");
  const watch = vi.spyOn(fs, "watch");
  expect(authProfileSourceExists(source)).toBe(false);
  fs.writeFileSync(source, "{}");
  expect(authProfileSourceExists(source)).toBe(true);
  fs.unlinkSync(source);
  expect(authProfileSourceExists(source)).toBe(false);
  expect(watch).not.toHaveBeenCalled();
});
