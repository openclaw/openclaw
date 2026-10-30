// Memory indexing tests exercise explicit sync, not physical filesystem events.
import { afterAll, beforeAll, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";

// Reuse the same controlled observation contract as watcher-domain tests. Root
// admission remains real; this fixture simply publishes no unsolicited dirties.
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => {
  const { createMemoryObservationHarness } = await import("./watcher-test-support.js");
  return {
    ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
    watch: createMemoryObservationHarness().watch,
  };
});

// Keep controlled observation in-process; native transport has separate coverage.
vi.mock("./local-file-watcher.js", async (original) => {
  const watcher = await import("./file-watcher.js");
  return {
    ...(await original<typeof import("./local-file-watcher.js")>()),
    LocalMemoryFileWatcher: watcher.MemoryFileWatcher,
  };
});

beforeAll(async () => {
  await configureMemoryCoreDreamingStateForTests();
});
afterAll(() => {
  resetMemoryCoreDreamingStateForTests();
});
