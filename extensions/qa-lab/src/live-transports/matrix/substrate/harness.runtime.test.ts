import { readFile } from "node:fs/promises";
import type { QaDockerRunCommand as RunCommand } from "openclaw/plugin-sdk/qa-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../../docker-runtime.js";
import {
  MATRIX_QA_CLEANUP_TIMEOUT_MS,
  isMatrixVersionsReachable as isMatrixVersionsReachableDefault,
  waitForReachableMatrixBaseUrl as waitForReachableMatrixBaseUrlDefault,
  writeMatrixQaHarnessFiles,
} from "./harness.runtime-internals.js";
import { startMatrixQaHarness as startMatrixQaHarnessDefault } from "./harness.runtime.js";
import type { MatrixQaRecordingProxy, startMatrixQaRecordingProxy } from "./recording-proxy.js";

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

type MatrixQaHarnessDeps = {
  fetchImpl?: FetchLike;
  runCommand?: RunCommand;
  sleepImpl?: (ms: number) => Promise<unknown>;
  startRecordingProxyImpl?: typeof startMatrixQaRecordingProxy;
};

async function startMatrixQaHarness(
  params: Parameters<typeof startMatrixQaHarnessDefault>[0],
  deps?: MatrixQaHarnessDeps,
) {
  const actual = await vi.importActual<typeof import("../../../docker-runtime.js")>(
    "../../../docker-runtime.js",
  );
  io.execCommand.mockReset().mockImplementation(deps?.runCommand ?? actual.execCommand);
  io.fetchHealthUrl.mockReset().mockImplementation(deps?.fetchImpl ?? actual.fetchHealthUrl);
  io.sleep.mockReset().mockImplementation(deps?.sleepImpl ?? (async () => {}));
  if (deps?.startRecordingProxyImpl) {
    io.startRecordingProxy.mockReset().mockImplementation(deps.startRecordingProxyImpl);
  }
  return await startMatrixQaHarnessDefault(params);
}

function isMatrixVersionsReachable(
  baseUrl: string,
  fetchImpl: FetchLike,
  timeoutSignal?: AbortSignal,
  signal?: AbortSignal,
) {
  io.fetchHealthUrl.mockImplementation(fetchImpl);
  return isMatrixVersionsReachableDefault(baseUrl, timeoutSignal, signal);
}

function waitForReachableMatrixBaseUrl(
  params: Parameters<typeof waitForReachableMatrixBaseUrlDefault>[0] & {
    fetchImpl: FetchLike;
    sleepImpl: (ms: number) => Promise<unknown>;
  },
) {
  const { fetchImpl, sleepImpl, ...options } = params;
  io.fetchHealthUrl.mockImplementation(fetchImpl);
  io.sleep.mockImplementation(sleepImpl);
  return waitForReachableMatrixBaseUrlDefault(options);
}
type MatrixQaHarnessResult = Awaited<ReturnType<typeof startMatrixQaHarness>>;
const host = "http://127.0.0.1:28008/";
const container = "http://172.18.0.10:8008/";
const awake = async () => {};
function recordingProxy(targetBaseUrl: string, setTargetBaseUrl = vi.fn()) {
  return {
    baseUrl: targetBaseUrl,
    buildManifest: vi.fn(),
    installFaultRule: vi.fn(() => ({ hits: () => [], remove: vi.fn() })),
    records: () => [],
    setScenarioId: vi.fn(),
    setTargetBaseUrl,
    stop: vi.fn(awake),
  };
}

async function withStartedMatrixHarness(
  deps: MatrixQaHarnessDeps,
  verify: (params: { outputDir: string; result: MatrixQaHarnessResult }) => Promise<void> | void,
  options?: { dynamicPort?: boolean },
) {
  await withTempDir("matrix-qa-harness-", async (outputDir) => {
    const startRecordingProxyImpl =
      deps?.startRecordingProxyImpl ??
      (async ({ targetBaseUrl }: { targetBaseUrl: string }) =>
        recordingProxy(targetBaseUrl) as unknown as MatrixQaRecordingProxy);
    const result = await startMatrixQaHarness(
      {
        outputDir,
        repoRoot: "/repo/openclaw",
        ...(options?.dynamicPort ? {} : { homeserverPort: 28008 }),
      },
      { ...deps, startRecordingProxyImpl },
    );
    await verify({ outputDir, result });
  });
}

function runCommands(responses: Record<string, () => string | Promise<never>>, calls?: string[]) {
  return async function runCommand(command: string, args: string[], cwd?: string) {
    calls?.push([command, ...args, `@${cwd}`].join(" "));
    const rendered = args.join(" ");
    const response = Object.entries(responses).find(([match]) => rendered.includes(match));
    return { stdout: response ? await response[1]() : "", stderr: "" };
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
      const result = await writeMatrixQaHarnessFiles({
        outputDir,
        homeserverPort: 28008,
        registrationToken: "secret-token",
        serverName: "matrix-qa.test",
      });

      const compose = await readFile(result.composeFile, "utf8");
      expect(compose).toContain(
        "image: ghcr.io/matrix-construct/tuwunel:v1.9.3@sha256:678b7f5350e06a41614444497c587da9dddf66767e4068a27480402f3c1367d0",
      );
      expect(compose).toContain('      - "127.0.0.1:28008:8008"');
      expect(compose).toContain('TUWUNEL_ALLOW_ENCRYPTION: "true"');
      expect(compose).toContain('TUWUNEL_ALLOW_REGISTRATION: "true"');
      expect(compose).toContain('TUWUNEL_REGISTRATION_TOKEN: "secret-token"');
      expect(compose).toContain('TUWUNEL_SERVER_NAME: "matrix-qa.test"');
      expect(result.registrationToken).toBe("secret-token");
    });
  });

  it("bounds the full homeserver restart and readiness phase", async () => {
    vi.useFakeTimers();
    try {
      await withStartedMatrixHarness(
        {
          runCommand: runCommands({
            "restart matrix-qa-homeserver": () => new Promise<never>(() => {}),
            "ps --format json": () => '[{"State":"running"}]\n',
          }),
          fetchImpl: vi.fn(async () => ({ ok: true })),
          sleepImpl: vi.fn(awake),
        },
        async ({ result }) => {
          const restarting = result.restartService();
          const rejection = expect(restarting).rejects.toThrow(
            `Matrix homeserver restart timed out after ${MATRIX_QA_CLEANUP_TIMEOUT_MS}ms`,
          );
          await vi.advanceTimersByTimeAsync(MATRIX_QA_CLEANUP_TIMEOUT_MS);
          await rejection;
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets Docker atomically assign an unpinned loopback port", async () => {
    const calls: string[] = [];
    const setTargetBaseUrl = vi.fn();
    let portReadCount = 0;
    await withStartedMatrixHarness(
      {
        runCommand: runCommands(
          {
            "port matrix-qa-homeserver 8008": () =>
              `127.0.0.1:${++portReadCount === 1 ? 49_152 : 49_153}\n`,
            "ps --format json": () => '[{"State":"running"}]\n',
          },
          calls,
        ),
        fetchImpl: vi.fn(async () => ({ ok: true })),
        sleepImpl: vi.fn(awake),
        startRecordingProxyImpl: vi.fn(async ({ targetBaseUrl }) => ({
          ...recordingProxy(targetBaseUrl, setTargetBaseUrl),
          createExchangeContext: vi.fn(),
          onExchange: vi.fn(),
        })),
      },
      async ({ outputDir, result }) => {
        expect(result).toMatchObject({ homeserverPort: 49152, baseUrl: "http://127.0.0.1:49152/" });
        expect(calls).toContain(
          `docker compose -f ${outputDir}/docker-compose.matrix-qa.yml port matrix-qa-homeserver 8008 @/repo/openclaw`,
        );
        const compose = await readFile(result.composeFile, "utf8");
        expect(compose).toContain("      - target: 8008\n        host_ip: 127.0.0.1");
        await result.restartService();
        expect(setTargetBaseUrl).toHaveBeenCalledWith("http://127.0.0.1:49153/");
      },
      { dynamicPort: true },
    );
  });

  it("stops Tuwunel when post-start health setup fails", async () => {
    const calls: string[] = [];
    await withTempDir("matrix-qa-harness-", async (outputDir) => {
      await expect(
        startMatrixQaHarness(
          { outputDir, repoRoot: "/repo/openclaw", homeserverPort: 28008 },
          {
            runCommand: runCommands({}, calls),
            sleepImpl: vi.fn(async () => {
              throw new Error("health setup failed");
            }),
          },
        ),
      ).rejects.toThrow("health setup failed");
      expect(calls.filter((call) => call.includes("down --remove-orphans"))).toHaveLength(2);
    });
  });

  it("cancels Matrix versions probe response bodies", async () => {
    const cancel = vi.fn(awake);
    const fetchImpl = vi.fn(async () => ({ ok: true, body: { cancel } }));

    await expect(isMatrixVersionsReachable(host, fetchImpl)).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledWith(`${host}_matrix/client/versions`, {
      signal: expect.any(AbortSignal),
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a stalled versions request when its deadline signal aborts", async () => {
    const { fetchImpl, probeSignals } = createStalledVersionsFetch();
    const controller = new AbortController();
    const pending = isMatrixVersionsReachable(host, fetchImpl, controller.signal);
    controller.abort(new DOMException("Deadline expired", "TimeoutError"));
    await expect(pending).resolves.toBe(false);
    expect(probeSignals[0]?.aborted).toBe(true);
  });

  it.each([
    [container, 25],
    [host, 1_000],
  ] as const)("returns %s without waiting for a stalled peer", async (healthy, timeoutMs) => {
    const { fetchImpl, probeSignals } = createStalledVersionsFetch(healthy);
    await expect(
      waitForReachableMatrixBaseUrl({
        composeFile: "/tmp/docker-compose.matrix-qa.yml",
        containerBaseUrl: container,
        fetchImpl,
        hostBaseUrl: host,
        sleepImpl: vi.fn(awake),
        timeoutMs,
      }),
    ).resolves.toBe(healthy);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(probeSignals).toHaveLength(1);
    expect(probeSignals[0]?.aborted).toBe(true);
  });

  it("keeps probing the container URL until it becomes reachable", async () => {
    const fetchCalls: string[] = [];

    await withStartedMatrixHarness(
      {
        runCommand: runCommands({
          "ps --format json": () => '{"State":"running"}\n',
          "ps -q": () => "container-123\n",
          "inspect --format": () => "172.18.0.10\n",
        }),
        fetchImpl: vi.fn(async (input: string) => {
          fetchCalls.push(input);
          return {
            ok:
              input === `${container}_matrix/client/versions` &&
              fetchCalls.filter((url) => url === input).length > 1,
          };
        }),
        sleepImpl: vi.fn(awake),
      },
      ({ result }) => {
        expect(result.baseUrl).toBe(container);
        expect(fetchCalls).toEqual(
          [host, host, container, host, container, container].map(
            (url) => `${url}_matrix/client/versions`,
          ),
        );
      },
    );
  });
});
