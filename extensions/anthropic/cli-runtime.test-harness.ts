import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  withinTest,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import { CLAUDE_PROTOCOL_FIXTURE } from "./cli-runtime.test-support.js";
import { executeClaudeCli, type ClaudeCliExecuteContext } from "./cli.runtime.js";

const roots: string[] = [];
const handles = new Set<CliBackendLiveSessionHandle>();
export const harness: { receipts: FixtureReceiptChannel } = {
  receipts: undefined as unknown as FixtureReceiptChannel,
};

/** Registers the fixture channel and per-test cleanup for the calling test file. */
export function useClaudeFixture(): void {
  beforeAll(async () => {
    harness.receipts = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await harness.receipts.close();
  });
  afterEach(async () => {
    for (const handle of handles) {
      handle.close("restart");
      await handle.waitForExit();
    }
    handles.clear();
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
}

export async function createContext(
  scenario = "normal",
  overrides: Partial<ClaudeCliExecuteContext> = {},
): Promise<ClaudeCliExecuteContext> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-protocol-")));
  roots.push(root);
  const fixture = path.join(root, "claude.mjs");
  await writeFile(
    fixture,
    `${fixtureReceiptClientSource(harness.receipts.endpoint)}
${CLAUDE_PROTOCOL_FIXTURE}`,
  );
  return {
    command: process.execPath,
    args: [fixture],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_FIXTURE_SCENARIO: scenario,
    },
    prompt: "synthetic user input",
    systemPrompt: "synthetic operator instructions",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    liveSession: createLiveSession(),
    timeoutMs: 10_000,
    abortSignal: AbortSignal.timeout(10_000),
    requestToolPermission: vi.fn<CliBackendExecuteContext["requestToolPermission"]>(async () => ({
      behavior: "deny",
      message: "Fixture denied.",
    })),
    requestUserInput: vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
      status: "cancelled",
      message: "No question expected.",
    })),
    ...overrides,
  };
}

export function createLiveSession(cleanup?: () => Promise<void>): CliBackendLiveSessionCapability {
  let current: CliBackendLiveSessionHandle | undefined;
  let retiredCleanup: Promise<void> | undefined;
  return {
    fingerprint: "synthetic-process-policy",
    current: () => current,
    restart: async () => {
      const previous = current;
      previous?.close("restart");
      await previous?.waitForExit();
      await retiredCleanup;
    },
    register: (handle) => {
      if (retiredCleanup) {
        throw new Error("Previous CLI live session cleanup has not settled.");
      }
      current = handle;
      handles.add(handle);
    },
    activate: () => {},
    remove: (handle) => {
      if (current === handle) {
        current = undefined;
        if (cleanup) {
          retiredCleanup = handle
            .waitForExit()
            .then(cleanup)
            .then(() => {
              retiredCleanup = undefined;
            });
        }
      }
    },
  };
}

export async function collect(context: CliBackendExecuteContext) {
  const records: Record<string, unknown>[] = [];
  for await (const record of executeClaudeCli(context)) {
    records.push(record);
  }
  return records;
}

export async function fixtureReadyBeforeSettlement(
  context: CliBackendExecuteContext,
  fileName: string,
  operation: PromiseLike<unknown>,
  signal: AbortSignal,
): Promise<void> {
  const readyPath = path.join(context.cwd, fileName);
  const recorded = async () => {
    expect(await readFile(readyPath, "utf8")).toBe("ready");
  };
  // The fixture writes this record before replying; receipt and protocol pipes are unordered.
  const settled = Promise.resolve(operation).then(recorded, async (error: unknown) => {
    try {
      await recorded();
    } catch {
      throw error;
    }
  });
  await withinTest(Promise.race([harness.receipts.waitFor(readyPath, "ready"), settled]), signal);
}
