import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
  CliBackendPreparedExecution,
} from "openclaw/plugin-sdk/cli-backend";
import { expect, vi } from "vitest";
import { isProcessAlive as running } from "../test-support/process.test-support.js";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import type { ClaudeCliSecretInput } from "./cli-process.js";
import { executeClaudeCli } from "./cli.runtime.js";

export async function collectClaudeCli(
  context: CliBackendExecuteContext,
  secretInput?: Parameters<typeof executeClaudeCli>[1],
  execute = executeClaudeCli,
) {
  const records: Record<string, unknown>[] = [];
  for await (const record of execute(context, secretInput)) {
    records.push(record);
  }
  return records;
}

export function createCliTestHarness(prefix = "openclaw-claude-stderr-") {
  const roots: string[] = [];
  const handles = new Set<CliBackendLiveSessionHandle>();
  return {
    async context(
      source: string,
      overrides: Partial<CliBackendExecuteContext> = {},
      env: Record<string, string> = {},
    ): Promise<CliBackendExecuteContext> {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
      roots.push(root);
      const command = path.join(root, "claude.mjs");
      await writeFile(command, source);
      return {
        command: process.execPath,
        args: [command],
        cwd: root,
        env: { PATH: process.env.PATH ?? "", HOME: root, CLAUDE_CONFIG_DIR: root, ...env },
        prompt: "Synthetic subprocess diagnostic probe.",
        systemPrompt: "Synthetic subprocess diagnostic probe.",
        modelId: "claude-sonnet-4-6",
        useResume: false,
        timeoutMs: 10_000,
        abortSignal: AbortSignal.timeout(10_000),
        requestToolPermission: async () => ({ behavior: "deny", message: "No tools." }),
        requestUserInput: async () => ({ status: "cancelled", message: "No input in this probe." }),
        ...overrides,
      };
    },
    liveSession(cleanup?: () => Promise<void>): CliBackendLiveSessionCapability {
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
          if (current !== handle) {
            return;
          }
          current = undefined;
          if (cleanup) {
            retiredCleanup = handle.waitForExit().then(async () => {
              await cleanup();
              retiredCleanup = undefined;
            });
          }
        },
      };
    },
    async cleanup() {
      for (const handle of handles) {
        handle.close("restart");
        await handle.waitForExit();
      }
      handles.clear();
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    },
  };
}

export async function prepareClaudeCli(
  context: CliBackendExecuteContext,
  authCredential: { type: "token"; token: string } | { type: "api_key"; key: string },
  backend = buildAnthropicCliBackend(),
) {
  const prepared = (await backend.prepareExecution?.({
    workspaceDir: context.cwd,
    provider: "claude-cli",
    modelId: context.modelId,
    executionMode: "agent",
    authCredential,
  } as Parameters<NonNullable<typeof backend.prepareExecution>>[0])) as
    | (CliBackendPreparedExecution & { secretInput?: ClaudeCliSecretInput })
    | undefined;
  const { execute, secretInput, cleanup } = prepared ?? {};
  if (!execute || !secretInput || !cleanup) {
    throw new Error("Expected provider-owned credential execution.");
  }
  return { ...prepared, execute, secretInput, cleanup };
}

export function recordCredentialBuffers(input: ClaudeCliSecretInput) {
  const buffers: Buffer[] = [];
  const createData = input.createData;
  vi.spyOn(input, "createData").mockImplementation(() => {
    const bytes = createData();
    buffers.push(bytes);
    return bytes;
  });
  return buffers;
}

// The transport joins its root and signal dispatch, not foreign descendant extinction.
export async function waitForProcessExit(pids: number[], signal: AbortSignal): Promise<void> {
  while (pids.some(running)) {
    await waitForProcessTick(10, undefined, { signal });
  }
}

export function resultDetail(records: Record<string, unknown>[]): Record<string, unknown> {
  const result = records.findLast((record) => record.type === "result");
  expect(result).toMatchObject({ subtype: "success", result: expect.any(String) });
  return JSON.parse(String(result?.result)) as Record<string, unknown>;
}
