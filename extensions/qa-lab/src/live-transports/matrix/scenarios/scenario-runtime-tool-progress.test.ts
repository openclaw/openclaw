import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeMatrixQaObservedEvent } from "../substrate/events.js";
import { createCurrentScenarioEventPredicate } from "./scenario-runtime-event-scope.js";
import {
  MATRIX_QA_TOOL_PROGRESS_MENTION_GATE_DIRECTORY,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import { prepareMatrixMentionProgressGate } from "./scenario-runtime-tool-progress-gate.js";
import { runToolProgressMentionSafetyScenario } from "./scenario-runtime-tool-progress.js";
import { matrixMessage } from "./scenario-runtime.test-support.js";

const publications = vi.hoisted(() => new Map<string, () => void>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(async (...args: Parameters<typeof mkdir>) => {
      const result = await actual.mkdir(...args);
      publications.get(String(args[0]))?.();
      return result;
    }),
  };
});
afterEach(() => publications.clear());

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("does not reuse events observed before the current progress scenario", () => {
  const event = (eventId: string) =>
    normalizeMatrixQaObservedEvent("!room:matrix-qa.test", matrixMessage(eventId, "Working"))!;
  const stale = event("$stale");
  const isCurrent = createCurrentScenarioEventPredicate([stale, event("$current")], 1);
  expect([stale, event("$stale"), event("$current")].map(isCurrent)).toEqual([false, false, true]);
});

it("skips the release-directory-backed mention progress scenario on Windows", async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const scenario = runToolProgressMentionSafetyScenario({} as MatrixQaScenarioContext);
    await expect(scenario).rejects.toMatchObject({
      name: "QaSuiteScenarioSkipError",
      message: "Matrix tool progress mention safety requires POSIX shell support.",
    });
  } finally {
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  }
});

async function prepareGate(consumeTimeoutMs?: number) {
  const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
  const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_GATE_DIRECTORY);
  const published = Promise.withResolvers<void>();
  publications.set(gatePath, () => published.resolve());
  const context = { gatewayWorkspaceDir };
  const gate = await prepareMatrixMentionProgressGate(context, { consumeTimeoutMs });
  return { gate, gatePath, published: published.promise };
}

const gateTest = it.skipIf(process.platform === "win32");
gateTest.for(["cleanup", "release"])("consumes the gate on %s", async (mode, { signal }) => {
  const { gate, gatePath, published } = await prepareGate();
  const pending =
    mode === "cleanup"
      ? gate.cleanup()
      : Promise.all([gate.release(), gate.release()]).then(() => undefined);
  try {
    await withinTest(published, signal);
    expect((await stat(gatePath)).isDirectory()).toBe(true);
    expect(await readdir(gatePath)).toEqual([]);
    await rm(gatePath, { recursive: true });
    await withinTest(pending, signal);
  } finally {
    await rm(gatePath, { recursive: true, force: true });
    await gate.cleanup();
    await pending;
  }
});

gateTest.each([false, true])("cleans unconsumed gate (pending release: %s)", async (release) => {
  const { gate, gatePath } = await prepareGate(10);
  const releasePromise = release ? gate.release() : undefined;
  const cleanupPromise = gate.cleanup();
  if (releasePromise) {
    await expect(releasePromise).rejects.toThrow("did not consume its release gate");
  }
  await cleanupPromise;
  await expect(stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
  if (!release) {
    await expect(gate.release()).rejects.toThrow("has already been cleaned up");
  }
});
