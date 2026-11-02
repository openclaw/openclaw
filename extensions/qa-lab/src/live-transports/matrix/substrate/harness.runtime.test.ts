import { readFile } from "node:fs/promises";
import type {
  QaDockerFetchLike as FetchLike,
  QaDockerRunCommand as RunCommand,
} from "openclaw/plugin-sdk/qa-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MATRIX_QA_CLEANUP_TIMEOUT_MS,
  isMatrixVersionsReachable,
  waitForReachableMatrixBaseUrl,
  writeMatrixQaHarnessFiles,
} from "./harness.runtime-internals.js";
import { startMatrixQaHarness } from "./harness.runtime.js";
import type { startMatrixQaRecordingProxy } from "./recording-proxy.js";

const io = vi.hoisted(() => ({
  execCommand: vi.fn<RunCommand>(),
  fetchHealthUrl: vi.fn<FetchLike>(),
  sleep: vi.fn<(ms: number) => Promise<unknown>>(),
  startRecordingProxy: vi.fn<typeof startMatrixQaRecordingProxy>(),
}));

vi.mock("../../../docker-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../docker-runtime.js")>()),
  execCommand: io.execCommand,
  fetchHealthUrl: io.fetchHealthUrl,
}));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: io.sleep,
}));
vi.mock("./recording-proxy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./recording-proxy.js")>()),
  startMatrixQaRecordingProxy: io.startRecordingProxy,
}));

afterAll(() => {
  vi.doUnmock("../../../docker-runtime.js");
  vi.doUnmock("node:timers/promises");
  vi.doUnmock("./recording-proxy.js");
  vi.resetModules();
});

type MatrixQaHarnessResult = Awaited<ReturnType<typeof startMatrixQaHarness>>;
const host = "http://127.0.0.1:28008/";
const container = "http://172.18.0.10:8008/";
const awake = async () => {};
function recordingProxy(targetBaseUrl: string, setTargetBaseUrl = vi.fn()) {
  return {
    baseUrl: targetBaseUrl,
    installFaultRule: vi.fn(() => ({ hits: () => [], remove: vi.fn() })),
    records: () => [],
    setTargetBaseUrl,
    stop: vi.fn(awake),
  };
}

beforeEach(() => {
  io.execCommand.mockReset().mockImplementation(
    runCommands({
      "ps --format json": () => '[{"State":"running"}]\n',
    }),
  );
  io.fetchHealthUrl.mockReset().mockResolvedValue({ ok: true });
  io.sleep.mockReset().mockImplementation(awake);
  io.startRecordingProxy
    .mockReset()
    .mockImplementation(async ({ targetBaseUrl }) => recordingProxy(targetBaseUrl));
});

async function withStartedMatrixHarness(
  verify: (params: { outputDir: string; result: MatrixQaHarnessResult }) => Promise<void> | void,
) {
  await withTempDir("matrix-qa-harness-", async (outputDir) => {
    const result = await startMatrixQaHarness({ outputDir, repoRoot: "/repo/openclaw" });
    await verify({ outputDir, result });
  });
}

function runCommands(responses: Record<string, () => string | Promise<never>>, calls?: string[]) {
  return async function runCommand(command: string, args: string[], cwd?: string) {
    calls?.push([command, ...args, `@${cwd}`].join(" "));
    const rendered = args.join(" ");
    const response = Object.entries(responses).find(([match]) => rendered.includes(match));
    const stdout = response
      ? await response[1]()
      : rendered.includes("port matrix-qa-homeserver 8008")
        ? "127.0.0.1:28008\n"
        : "";
    return { stdout, stderr: "" };
  };
}

function createStalledVersionsFetch(healthyBaseUrl?: string) {
  const probeSignals: AbortSignal[] = [];
  const fetchImpl = vi.fn(async (input: string, init?: Pick<RequestInit, "signal">) => {
    if (healthyBaseUrl && input.startsWith(healthyBaseUrl)) {
      return { ok: true };
    }
    return await new Promise<never>((_resolve, reject) => {
      const probeSignal = init?.signal ?? undefined;
      if (!probeSignal) {
        reject(new Error("versions probe signal missing"));
        return;
      }
      probeSignals.push(probeSignal);
      const rejectAborted = () => reject(new Error("versions probe aborted"));
      if (probeSignal.aborted) {
        rejectAborted();
        return;
      }
      probeSignal.addEventListener("abort", rejectAborted, { once: true });
    });
  });
  return { fetchImpl, probeSignals };
}

describe("matrix harness runtime", () => {
  it("writes a pinned Tuwunel compose file", async () => {
    await withTempDir("matrix-qa-harness-", async (outputDir) => {
      const result = await writeMatrixQaHarnessFiles({ outputDir });

      const compose = await readFile(result.composeFile, "utf8");
      expect(compose).toContain(
        "image: ghcr.io/matrix-construct/tuwunel:v1.9.3@sha256:678b7f5350e06a41614444497c587da9dddf66767e4068a27480402f3c1367d0",
      );
      expect(compose).toContain("      - target: 8008\n        host_ip: 127.0.0.1");
      expect(compose).toContain('TUWUNEL_ALLOW_ENCRYPTION: "true"');
      expect(compose).toContain('TUWUNEL_ALLOW_REGISTRATION: "true"');
      expect(compose).toContain(`TUWUNEL_REGISTRATION_TOKEN: "${result.registrationToken}"`);
      expect(compose).toContain('TUWUNEL_SERVER_NAME: "matrix-qa.test"');
      expect(result.registrationToken).toMatch(/^matrix-qa-[0-9a-f-]{36}$/);
    });
  });

  it("bounds the full homeserver restart and readiness phase", async () => {
    vi.useFakeTimers();
    io.execCommand.mockImplementation(
      runCommands({
        "restart matrix-qa-homeserver": () => new Promise<never>(() => {}),
        "ps --format json": () => '[{"State":"running"}]\n',
      }),
    );
    try {
      await withStartedMatrixHarness(async ({ result }) => {
        const restarting = result.restartService();
        const rejection = expect(restarting).rejects.toThrow(
          `Matrix homeserver restart timed out after ${MATRIX_QA_CLEANUP_TIMEOUT_MS}ms`,
        );
        await vi.advanceTimersByTimeAsync(MATRIX_QA_CLEANUP_TIMEOUT_MS);
        await rejection;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets Docker atomically assign an unpinned loopback port", async () => {
    const calls: string[] = [];
    const setTargetBaseUrl = vi.fn();
    let portReadCount = 0;
    io.execCommand.mockImplementation(
      runCommands(
        {
          "port matrix-qa-homeserver 8008": () =>
            `127.0.0.1:${++portReadCount === 1 ? 49_152 : 49_153}\n`,
          "ps --format json": () => '[{"State":"running"}]\n',
        },
        calls,
      ),
    );
    io.startRecordingProxy.mockImplementation(async ({ targetBaseUrl }) =>
      recordingProxy(targetBaseUrl, setTargetBaseUrl),
    );
    await withStartedMatrixHarness(async ({ outputDir, result }) => {
      expect(result).toMatchObject({ baseUrl: "http://127.0.0.1:49152/" });
      expect(io.fetchHealthUrl).toHaveBeenCalledWith(
        "http://127.0.0.1:49152/_matrix/client/versions",
        {
          signal: expect.any(AbortSignal),
        },
      );
      expect(calls).toContain(
        `docker compose -f ${outputDir}/docker-compose.matrix-qa.yml port matrix-qa-homeserver 8008 @/repo/openclaw`,
      );
      await result.restartService();
      expect(setTargetBaseUrl).toHaveBeenCalledWith("http://127.0.0.1:49153/");
    });
  });

  it("stops Tuwunel when post-start health setup fails", async () => {
    const calls: string[] = [];
    io.execCommand.mockImplementation(runCommands({}, calls));
    io.sleep.mockRejectedValue(new Error("health setup failed"));
    await withTempDir("matrix-qa-harness-", async (outputDir) => {
      await expect(startMatrixQaHarness({ outputDir, repoRoot: "/repo/openclaw" })).rejects.toThrow(
        "health setup failed",
      );
      expect(calls.filter((call) => call.includes("down --remove-orphans"))).toHaveLength(2);
    });
  });

  it("cancels a stalled versions request when its deadline signal aborts", async () => {
    const { fetchImpl, probeSignals } = createStalledVersionsFetch();
    io.fetchHealthUrl.mockImplementation(fetchImpl);
    const controller = new AbortController();
    const pending = isMatrixVersionsReachable(host, controller.signal);
    controller.abort(new DOMException("Deadline expired", "TimeoutError"));
    await expect(pending).resolves.toBe(false);
    expect(probeSignals[0]?.aborted).toBe(true);
  });

  it.each([container, host])("returns %s without waiting for a stalled peer", async (healthy) => {
    const { fetchImpl, probeSignals } = createStalledVersionsFetch(healthy);
    io.fetchHealthUrl.mockImplementation(fetchImpl);
    await expect(
      waitForReachableMatrixBaseUrl({
        composeFile: "/tmp/docker-compose.matrix-qa.yml",
        containerBaseUrl: container,
        hostBaseUrl: host,
      }),
    ).resolves.toBe(healthy);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(probeSignals).toHaveLength(1);
    expect(probeSignals[0]?.aborted).toBe(true);
  });

  it("keeps probing the container URL until it becomes reachable", async () => {
    const fetchCalls: string[] = [];

    io.execCommand.mockImplementation(
      runCommands({
        "ps --format json": () => '{"State":"running"}\n',
        "ps -q": () => "container-123\n",
        "inspect --format": () => "172.18.0.10\n",
      }),
    );
    io.fetchHealthUrl.mockImplementation(async (input: string) => {
      fetchCalls.push(input);
      return {
        ok:
          input === `${container}_matrix/client/versions` &&
          fetchCalls.filter((url) => url === input).length > 1,
      };
    });
    await withStartedMatrixHarness(({ result }) => {
      expect(result.baseUrl).toBe(container);
      expect(fetchCalls).toEqual(
        [host, host, container, host, container].map((url) => `${url}_matrix/client/versions`),
      );
    });
  });
});
