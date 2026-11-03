import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { setupStartupLifecycle } from "./attempt-startup-lifecycle.test-support.js";
import {
  answerInitialize,
  createAttemptPaths,
  createAttemptThreadStarter,
  readHarnessRequestMethods,
  waitForRequest,
} from "./attempt-startup.test-support.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { readCodexComputerUseStatus } from "./computer-use.js";
import { createComputerUseRequest } from "./computer-use.test-support.js";
import type { CodexPluginConfig } from "./config.js";
import { createInferenceReadyClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.mock("./desktop-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./desktop-generation.js")>()),
  waitForCodexDesktopGeneration: async () => undefined,
}));

const tempRoots = new Set<string>();
const pluginConfig: CodexPluginConfig = { appServer: { command: "codex" } };
const startThreadWithHarness = createAttemptThreadStarter(tempRoots, pluginConfig);

describe("Computer Use attempt startup", () => {
  setupStartupLifecycle(tempRoots, () => vi.useRealTimers());

  it("charges initial client acquisition to the one-off status deadline", async () => {
    const { harness, timeout, status } = await statusProbe({
      initialize: 800,
      "mcpServerStatus/list": 1_050,
    });
    expect(status.ready).toBe(false);
    expect(timeout("plugin/list")).toBe(200);
    expect(readHarnessRequestMethods(harness)).not.toContain("thread/start");
    expect(readHarnessRequestMethods(harness)).not.toContain("mcpServer/tool/call");
  });

  it("preserves cleanup after the one-off status probe exhausts its deadline", async () => {
    const { harness, requests, timeout, status } = await statusProbe(
      { "mcpServer/tool/call": 2_000 },
      { liveTestTimeoutMs: 1_500, toolCallTimeoutMs: 100 },
    );
    expect(status.ready).toBe(true);
    expect(requests).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "computer-use-probe-thread-1" },
      expect.objectContaining({ timeoutMs: 1_500, signal: expect.any(AbortSignal) }),
    );
    expect(harness.stdinDestroyed).toBe(false);
    expect(["thread/start", "mcpServer/tool/call"].map(timeout)).toEqual([1_000, 100]);
  });

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
          if (request.method === "thread/start") {
            (request.params?.ephemeral ? probeStarts : userStarts).push(Date.now());
          }
          const results: Record<string, unknown> = {
            "configRequirements/read": { requirements: null },
            "plugin/read": { plugin: { summary: { installed: true, enabled: true } } },
            "mcpServerStatus/list": {
              data: [{ name: "computer-use", tools: { list_apps: {} } }],
              nextCursor: null,
            },
            "thread/start": threadStartResult("thread-1", "/repo"),
            "thread/unsubscribe": { status: "unsubscribed" },
          };
          // Leave mcpServer/tool/call unanswered to exercise the real 60s timeout.
          if (Object.hasOwn(results, request.method)) {
            send({ id: request.id, result: results[request.method] });
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
              liveTest: { attempts: 2 },
            },
          },
        });
        expect(userStarts).toHaveLength(0);
        expect(
          readHarnessRequestMethods(harness).filter((method) => method === "thread/unsubscribe"),
        ).toHaveLength(2);
      } else {
        // The unadvanced clock and held probe response prove startup does not await it.
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

async function statusProbe(
  elapsedByMethod: Record<string, number>,
  overrides: NonNullable<CodexPluginConfig["computerUse"]> = {},
) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let elapsedMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
  vi.spyOn(Date, "now").mockImplementation(() => elapsedMs);
  const fixture = createComputerUseRequest({ installed: true });
  const harness = createInferenceReadyClientHarness({
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
          elapsedMs = elapsedByMethod[frame.method] ?? elapsedMs;
        },
        (error: unknown) => send({ id: frame.id, error: { code: -32000, message: String(error) } }),
      );
    },
  });
  vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
  const requests = vi.spyOn(harness.client, "request");
  const status = await readCodexComputerUseStatus({
    agentDir: createAttemptPaths(tempRoots).agentDir,
    timeoutMs: 1_000,
    pluginConfig: {
      ...pluginConfig,
      computerUse: { enabled: true, marketplaceName: "desktop-tools", ...overrides },
    },
  });
  const timeout = (method: string) =>
    requests.mock.calls.find(([called]) => called === method)?.[2]?.timeoutMs;
  return { harness, requests, timeout, status };
}
