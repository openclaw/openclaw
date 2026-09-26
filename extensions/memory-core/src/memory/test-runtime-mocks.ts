// Memory indexing tests exercise explicit sync, not physical filesystem events.
import { afterAll, beforeAll, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";

// Reuse the same controlled observation contract as watcher-domain tests. Root
// admission remains real; this fixture simply publishes no unsolicited dirties.
vi.mock("@openclaw/fs-safe/watch", async () => {
  const { createMemoryObservationHarness } = await import("./watcher-test-support.js");
  return { watch: createMemoryObservationHarness().watch };
});

beforeAll(async () => {
  await configureMemoryCoreDreamingStateForTests();
});
afterAll(() => {
  resetMemoryCoreDreamingStateForTests();
});
