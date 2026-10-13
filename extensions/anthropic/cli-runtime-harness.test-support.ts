import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
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
import { executeClaudeCli } from "./cli.runtime.js";

/** Registers per-file fixture lifecycle hooks and returns helpers bound to them. */
export function installClaudeProtocolHarness() {
  const roots: string[] = [];
  const handles = new Set<CliBackendLiveSessionHandle>();
  let receipts: FixtureReceiptChannel;
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await receipts.close();
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

  async function createContext(
    scenario = "normal",
    overrides: Partial<CliBackendExecuteContext> = {},
  ): Promise<CliBackendExecuteContext> {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-protocol-")));
    roots.push(root);
    const fixture = path.join(root, "claude.mjs");
    await writeFile(
      fixture,
      `${fixtureReceiptClientSource(receipts.endpoint)}
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

  function createLiveSession(cleanup?: () => Promise<void>): CliBackendLiveSessionCapability {
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

  async function fixtureReadyBeforeSettlement(
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
    await withinTest(Promise.race([receipts.waitFor(readyPath, "ready"), settled]), signal);
  }

  return { createContext, createLiveSession, fixtureReadyBeforeSettlement };
}

export async function collect(context: CliBackendExecuteContext) {
  const records: Record<string, unknown>[] = [];
  for await (const record of executeClaudeCli(context)) {
    records.push(record);
  }
  return records;
}

export function resultDetail(records: Record<string, unknown>[]): Record<string, unknown> {
  const result = records.findLast((record) => record.type === "result");
  expect(result).toEqual(
    expect.objectContaining({ subtype: "success", result: expect.any(String) }),
  );
  return JSON.parse(String(result?.result)) as Record<string, unknown>;
}

// Native transport joins its root and signal dispatch, not foreign descendant extinction.
export async function waitForProcessExit(pids: number[], signal: AbortSignal): Promise<void> {
  try {
    for (;;) {
      if (
        pids.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        })
      ) {
        return;
      }
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (cause) {
    throw new Error(`Claude process tree ${pids.join(", ")} did not exit before the test aborted`, {
      cause,
    });
  }
}
