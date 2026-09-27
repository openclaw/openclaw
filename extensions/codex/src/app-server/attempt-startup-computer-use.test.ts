import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerInitialize,
  createAttemptPaths,
  createAttemptThreadStarter,
  readHarnessRequestMethods,
  waitForRequest,
} from "./attempt-startup.test-support.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult as createThreadStartResult } from "./codex-app-server.test-fixtures.js";
import { readCodexComputerUseStatus } from "./computer-use.js";
import { createComputerUseRequest, requireRecord } from "./computer-use.test-support.js";
import { resolveCodexAppServerRuntimeOptions, type CodexPluginConfig } from "./config.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { resetCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createInferenceReadyClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.mock("./desktop-generation.js", () => ({
  isCodexDesktopGenerationCurrent: () => false,
  waitForCodexDesktopGeneration: async () => undefined,
}));

const tempRoots = new Set<string>();
const pluginConfig: CodexPluginConfig = { appServer: { command: "codex" } };
const startThreadWithHarness = createAttemptThreadStarter(tempRoots, pluginConfig);
const threadStartResult = (threadId = "thread-1") => createThreadStartResult(threadId, "/repo");

describe("Computer Use attempt startup", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(undefined);
    defaultCodexPluginMetadataCache.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it("retries one-off status after its client rejects a stale desktop selection", async () => {
    const original = createStatusClient();
    const replacement = createStatusClient();
    const start = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(original.client)
      .mockResolvedValueOnce(replacement.client);
    const paths = createAttemptPaths(tempRoots);
    const statusPluginConfig = {
      ...pluginConfig,
      computerUse: { enabled: true, marketplaceName: "desktop-tools" },
    } satisfies CodexPluginConfig;
    const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: statusPluginConfig });
    const firstLease = await getLeasedSharedCodexAppServerClient({
      startOptions: runtime.start,
      pluginConfig: statusPluginConfig,
      agentDir: paths.agentDir,
    });
    const staleGuard = vi.fn(async () => {
      throw Object.assign(new Error("desktop selection changed"), {
        code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
      });
    });
    firstLease.setThreadSessionRequestGuard(staleGuard);
    releaseLeasedSharedCodexAppServerClient(firstLease);

    await expect(
      readCodexComputerUseStatus({ pluginConfig: statusPluginConfig, agentDir: paths.agentDir }),
    ).resolves.toMatchObject({ ready: true });
    expect(staleGuard).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(original.stdinDestroyed).toBe(true);
    expect(readHarnessRequestMethods(original)).not.toContain("thread/start");
    expect(readHarnessRequestMethods(original)).not.toContain("mcpServer/tool/call");
    expect(readHarnessRequestMethods(original)).not.toContain("thread/unsubscribe");
    expect(
      readHarnessRequestMethods(replacement).filter((method) =>
        ["thread/start", "mcpServer/tool/call", "thread/unsubscribe"].includes(method ?? ""),
      ),
    ).toEqual(["thread/start", "mcpServer/tool/call", "thread/unsubscribe"]);
    const probe = await waitForRequest(replacement, "mcpServer/tool/call");
    const cleanup = await waitForRequest(replacement, "thread/unsubscribe");
    expect(cleanup.params).toEqual({
      threadId: requireRecord(probe.params, "readiness probe").threadId,
    });
  });

  it("charges initial client acquisition to the one-off status deadline", async () => {
    let elapsedMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    vi.spyOn(Date, "now").mockImplementation(() => elapsedMs);
    const harness = createStatusClient((method) => {
      if (method === "initialize") {
        elapsedMs = 800;
      } else if (method === "mcpServerStatus/list") {
        elapsedMs = 1_050;
      }
    });
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const requests = vi.spyOn(harness.client, "request");
    const paths = createAttemptPaths(tempRoots);
    const status = await readCodexComputerUseStatus({
      agentDir: paths.agentDir,
      timeoutMs: 1_000,
      pluginConfig: {
        ...pluginConfig,
        computerUse: { enabled: true, marketplaceName: "desktop-tools" },
      },
    });
    expect(status.ready).toBe(false);
    expect(requests).toHaveBeenCalledWith(
      "plugin/list",
      expect.anything(),
      expect.objectContaining({ timeoutMs: 200 }),
    );
    expect(readHarnessRequestMethods(harness)).not.toContain("thread/start");
    expect(readHarnessRequestMethods(harness)).not.toContain("mcpServer/tool/call");
  });

  it.each(["discovery", "probe"] as const)(
    "honors the one-off status deadline while preserving cleanup after %s",
    async (completedPhase) => {
      let elapsedMs = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
      vi.spyOn(Date, "now").mockImplementation(() => elapsedMs);
      const expiresAfter =
        completedPhase === "discovery" ? "mcpServerStatus/list" : "mcpServer/tool/call";
      const harness = createStatusClient((method) => {
        if (method === expiresAfter) {
          elapsedMs = 2_000;
        }
      });
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
      const requests = vi.spyOn(harness.client, "request");
      const paths = createAttemptPaths(tempRoots);
      const status = await readCodexComputerUseStatus({
        agentDir: paths.agentDir,
        timeoutMs: 1_000,
        pluginConfig: {
          ...pluginConfig,
          computerUse: {
            enabled: true,
            marketplaceName: "desktop-tools",
            liveTestTimeoutMs: 1_500,
            toolCallTimeoutMs: 100,
          },
        },
      });
      expect(status.ready).toBe(completedPhase === "probe");
      if (completedPhase === "discovery") {
        expect(readHarnessRequestMethods(harness)).not.toContain("thread/start");
        expect(readHarnessRequestMethods(harness)).not.toContain("mcpServer/tool/call");
      } else {
        expect(requests).toHaveBeenCalledWith(
          "thread/unsubscribe",
          { threadId: "computer-use-probe-thread-1" },
          expect.objectContaining({ timeoutMs: 1_500, signal: expect.any(AbortSignal) }),
        );
        expect(harness.stdinDestroyed).toBe(false);
        expect(requests).toHaveBeenCalledWith(
          "thread/start",
          expect.anything(),
          expect.objectContaining({ timeoutMs: 1_000 }),
        );
        expect(requests).toHaveBeenCalledWith(
          "mcpServer/tool/call",
          expect.anything(),
          expect.objectContaining({ timeoutMs: 100 }),
        );
      }
    },
  );

  it.each([false, true])(
    "does not await optional live probes at turn startup (strictReadiness: %s)",
    async (strictReadiness) => {
      vi.useFakeTimers();
      const probeStarts: number[] = [];
      const userStarts: number[] = [];
      const harness = createInferenceReadyClientHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line) as {
            id: number;
            method: string;
            params?: { ephemeral?: boolean };
          };
          switch (request.method) {
            case "configRequirements/read":
              send({ id: request.id, result: { requirements: null } });
              break;
            case "plugin/read":
              send({
                id: request.id,
                result: { plugin: { summary: { installed: true, enabled: true } } },
              });
              break;
            case "mcpServerStatus/list":
              send({
                id: request.id,
                result: {
                  data: [{ name: "computer-use", tools: { list_apps: {} } }],
                  nextCursor: null,
                },
              });
              break;
            case "thread/start":
              (request.params?.ephemeral ? probeStarts : userStarts).push(Date.now());
              send({ id: request.id, result: threadStartResult() });
              break;
            case "thread/unsubscribe":
              send({ id: request.id, result: { status: "unsubscribed" } });
              break;
            // Leave mcpServer/tool/call unanswered to exercise the real 60s timeout.
          }
        },
      });
      const { run } = startThreadWithHarness(180_000, new AbortController().signal, {
        harness,
        pluginConfig: {
          ...pluginConfig,
          computerUse: {
            enabled: true,
            marketplacePath: "/marketplaces/desktop-tools/marketplace.json",
            strictReadiness,
            autoRepair: false,
          },
        },
      });
      let settled = false;
      const outcome = run
        .then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        )
        .finally(() => {
          settled = true;
        });
      await answerInitialize(harness);
      if (strictReadiness) {
        await waitForRequest(harness, "mcpServer/tool/call");
        const firstProbeStart = probeStarts[0];
        if (firstProbeStart === undefined) {
          throw new Error("The strict readiness probe did not start");
        }
        await vi.advanceTimersByTimeAsync(firstProbeStart + 59_999 - Date.now());
        expect(settled).toBe(false);
        expect(probeStarts).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);
        expect(probeStarts).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => expect(settled).toBe(true), { interval: 1, timeout: 1_000 });
        const { error } = await outcome;
        expect(error).toBeInstanceOf(AgentHarnessPreflightError);
        expect(error).toMatchObject({
          cause: {
            status: {
              reason: "live_test_failed",
              liveTest: { attempts: 2, durationMs: 120_000 },
            },
          },
        });
        expect(userStarts).toHaveLength(0);
        expect(
          readHarnessRequestMethods(harness).filter((method) => method === "thread/unsubscribe"),
        ).toHaveLength(2);
      } else {
        await vi.waitFor(() => expect(settled).toBe(true), { interval: 1, timeout: 1_000 });
        const { result, error } = await outcome;
        expect(error).toBeUndefined();
        expect(userStarts).toHaveLength(1);
        expect(probeStarts).toHaveLength(0);
        expect(readHarnessRequestMethods(harness)).not.toContain("mcpServer/tool/call");
        result?.turnRoute.release();
        result?.releaseSharedClientLease();
      }
      expect(readHarnessRequestMethods(harness)).not.toContain("thread/archive");
      expect(readHarnessRequestMethods(harness)).not.toContain("config/mcpServer/reload");
    },
  );
});

function createStatusClient(afterResponse?: (method: string) => void) {
  const fixture = createComputerUseRequest({ installed: true });
  return createInferenceReadyClientHarness({
    onWrite(line, send) {
      const frame = JSON.parse(line) as { id?: number; method: string; params?: unknown };
      if (frame.id === undefined) {
        return;
      }
      const response =
        frame.method === "initialize"
          ? Promise.resolve({ userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` })
          : frame.method === "configRequirements/read"
            ? Promise.resolve({ requirements: null })
            : fixture(frame.method, frame.params);
      void response.then(
        (result) => {
          send({ id: frame.id, result: result ?? null });
          afterResponse?.(frame.method);
        },
        (error: unknown) => send({ id: frame.id, error: { code: -32000, message: String(error) } }),
      );
    },
  });
}
