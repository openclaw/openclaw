import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import { createCurrentScenarioEventPredicate } from "./scenario-runtime-event-scope.js";
import {
  MATRIX_QA_TOOL_PROGRESS_MENTION_GATE_DIRECTORY,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import { prepareMatrixMentionProgressGate } from "./scenario-runtime-tool-progress-gate.js";
import { runToolProgressMentionSafetyScenario } from "./scenario-runtime-tool-progress.js";

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
  const event = (eventId: string): MatrixQaObservedEvent => ({
    kind: "message",
    roomId: "!room:example.test",
    eventId,
    type: "m.room.message",
  });
  const stale = event("$stale");
  const observedEvents = [stale, event("$current")];
  const isCurrentScenarioEvent = createCurrentScenarioEventPredicate(observedEvents, 1);

  expect(isCurrentScenarioEvent(stale)).toBe(false);
  expect(isCurrentScenarioEvent(event("$stale"))).toBe(false);
  expect(isCurrentScenarioEvent(event("$current"))).toBe(true);
});

it("skips the release-directory-backed mention progress scenario on Windows", async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    await expect(
      runToolProgressMentionSafetyScenario({} as MatrixQaScenarioContext),
    ).rejects.toMatchObject({
      name: "QaSuiteScenarioSkipError",
      message: "Matrix tool progress mention safety requires POSIX shell support.",
    });
  } finally {
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  }
});

describe.skipIf(process.platform === "win32")("Matrix mention progress gate", () => {
  async function prepareGate(consumeTimeoutMs?: number) {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_GATE_DIRECTORY);
    const published = Promise.withResolvers<void>();
    publications.set(gatePath, () => published.resolve());
    const gate = await prepareMatrixMentionProgressGate(
      { gatewayWorkspaceDir },
      { consumeTimeoutMs },
    );
    return { gate, gatePath, published: published.promise };
  }

  async function consumeGate(gatePath: string, published: Promise<void>, signal: AbortSignal) {
    await withinTest(published, signal);
    expect((await stat(gatePath)).isDirectory()).toBe(true);
    expect(await readdir(gatePath)).toEqual([]);
    await rm(gatePath, { recursive: true });
  }

  it("waits for failure cleanup to release and consume the gate", async ({ signal }) => {
    const { gate, gatePath, published } = await prepareGate();

    const cleanupPromise = gate.cleanup();
    try {
      await consumeGate(gatePath, published, signal);
      await withinTest(cleanupPromise, signal);
    } finally {
      await rm(gatePath, { recursive: true, force: true });
      await cleanupPromise;
    }

    await expect(stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the release directory idempotently and waits for consumption", async ({ signal }) => {
    const { gate, gatePath, published } = await prepareGate();

    const releases = Promise.all([gate.release(), gate.release()]);
    try {
      await consumeGate(gatePath, published, signal);
      await withinTest(releases, signal);
    } finally {
      await rm(gatePath, { recursive: true, force: true });
      await gate.cleanup();
      await releases;
    }

    await expect(stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes an unconsumed gate after bounded cleanup", async () => {
    const { gate, gatePath } = await prepareGate(10);

    await gate.cleanup();

    await expect(stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(gate.release()).rejects.toThrow("has already been cleaned up");
  });

  it("does not mistake cleanup removal for command consumption", async () => {
    const { gate, gatePath } = await prepareGate(10);

    const releasePromise = gate.release();
    const cleanupPromise = gate.cleanup();

    await expect(releasePromise).rejects.toThrow("did not consume its release gate");
    await cleanupPromise;
    await expect(stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
