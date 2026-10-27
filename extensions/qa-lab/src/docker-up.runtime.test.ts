import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  QaDockerFetchLike as FetchLike,
  QaDockerRunCommand as RunCommand,
} from "openclaw/plugin-sdk/qa-runtime";
import { shellEscape as shellQuote } from "openclaw/plugin-sdk/string-normalization-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runQaDockerUp as runQaDockerUpDefault } from "./docker-up.runtime.js";

const io = vi.hoisted(() => ({
  execCommand: vi.fn<RunCommand>(),
  fetchHealthUrl: vi.fn<FetchLike>(),
  resolveHostPort: vi.fn<(preferredPort: number, pinned: boolean) => Promise<number>>(),
  sleep: vi.fn<(ms: number) => Promise<unknown>>(),
}));

vi.mock("./docker-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker-runtime.js")>()),
  execCommand: io.execCommand,
  fetchHealthUrl: io.fetchHealthUrl,
  resolveHostPort: io.resolveHostPort,
}));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: io.sleep,
}));

afterAll(() => {
  vi.doUnmock("./docker-runtime.js");
  vi.doUnmock("node:timers/promises");
  vi.resetModules();
});

type QaDockerUpDeps = {
  runCommand?: RunCommand;
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<unknown>;
  resolveHostPortImpl?: (preferredPort: number, pinned: boolean) => Promise<number>;
};

async function runQaDockerUp(
  params: Parameters<typeof runQaDockerUpDefault>[0],
  deps: QaDockerUpDeps,
) {
  const actual = await vi.importActual<typeof import("./docker-runtime.js")>("./docker-runtime.js");
  io.execCommand.mockReset().mockImplementation(deps.runCommand ?? actual.execCommand);
  io.fetchHealthUrl.mockReset().mockImplementation(deps.fetchImpl ?? actual.fetchHealthUrl);
  io.resolveHostPort
    .mockReset()
    .mockImplementation(deps.resolveHostPortImpl ?? actual.resolveHostPort);
  io.sleep.mockReset().mockImplementation(deps.sleepImpl ?? (async () => {}));
  return await runQaDockerUpDefault(params);
}

const repoRoot = path.resolve("/repo/openclaw");
const healthy = { stdout: '{"Health":"healthy","State":"running"}\n', stderr: "" };
const empty = { stdout: "", stderr: "" };

function createHealthyDockerDeps(calls: string[] = []): QaDockerUpDeps {
  return {
    async runCommand(command, args, cwd) {
      calls.push([command, ...args, `@${cwd}`].join(" "));
      if (args.join(" ").includes("ps --format json openclaw-qa-gateway")) {
        return healthy;
      }
      return empty;
    },
    fetchImpl: vi.fn(async () => ({ ok: true })),
    sleepImpl: vi.fn(async () => {}),
  };
}

function withDocker(
  run: (fixture: {
    outputDir: string;
    composeFile: string;
    calls: string[];
    up: (
      params?: Parameters<typeof runQaDockerUpDefault>[0],
      deps?: QaDockerUpDeps,
    ) => ReturnType<typeof runQaDockerUpDefault>;
  }) => Promise<void>,
) {
  return withTempDir("qa-docker-up-", async (outputDir) => {
    const calls: string[] = [];
    await run({
      outputDir,
      composeFile: path.join(outputDir, "docker-compose.qa.yml"),
      calls,
      up: (params = {}, deps = {}) =>
        runQaDockerUp(
          { repoRoot, outputDir, ...params },
          { ...createHealthyDockerDeps(calls), ...deps },
        ),
    });
  });
}

describe("runQaDockerUp", () => {
  it("builds the QA UI, writes the harness, starts compose, and waits for health", async () => {
    const fetchCalls: string[] = [];
    const responseQueue = [false, true, true];
    await withDocker(async ({ composeFile, calls, up }) => {
      const result = await up(
        { gatewayPort: 18889, qaLabPort: 43124 },
        {
          async runCommand(command, args, cwd) {
            calls.push([command, ...args, `@${cwd}`].join(" "));
            if (args.join(" ").includes("ps --format json openclaw-qa-gateway")) {
              return { stdout: '[{"Health":"healthy","State":"running"}]\n', stderr: "" };
            }
            return empty;
          },
          fetchImpl: vi.fn(async (input: string) => {
            fetchCalls.push(input);
            return { ok: responseQueue.shift() ?? true };
          }),
        },
      );

      expect(calls).toEqual([
        `pnpm qa:lab:build @${repoRoot}`,
        `docker compose -f ${composeFile} down --remove-orphans @${repoRoot}`,
        `docker compose -f ${composeFile} up --build -d @${repoRoot}`,
        `docker compose -f ${composeFile} ps --format json openclaw-qa-gateway @${repoRoot}`,
      ]);
      expect(fetchCalls).toEqual([
        "http://127.0.0.1:43124/healthz",
        "http://127.0.0.1:43124/healthz",
        "http://127.0.0.1:18889/healthz",
      ]);
      expect(result).toMatchObject({
        qaLabUrl: "http://127.0.0.1:43124",
        gatewayUrl: "http://127.0.0.1:18889/",
        composeFile,
        stopCommand: `docker compose -f ${shellQuote(composeFile)} down`,
      });
    });
  });

  it("runs prebuilt images with a bound UI and shell-safe stop command", async () => {
    await withDocker(async ({ outputDir: tempRoot, calls, up }) => {
      const outputDir = path.join(tempRoot, "mac path's qa lab");
      const composeFile = path.join(outputDir, "docker-compose.qa.yml");
      const result = await up({
        outputDir,
        usePrebuiltImage: true,
        bindUiDist: true,
        skipUiBuild: true,
      });
      expect(result.stopCommand).toBe(`docker compose -f ${shellQuote(composeFile)} down`);

      expect(calls).toEqual([
        `docker compose -f ${composeFile} down --remove-orphans @${repoRoot}`,
        `docker compose -f ${composeFile} up -d @${repoRoot}`,
        `docker compose -f ${composeFile} ps --format json openclaw-qa-gateway @${repoRoot}`,
      ]);
      const compose = await readFile(composeFile, "utf8");
      expect(compose).toContain(":/opt/openclaw-qa-lab-ui:ro");
      expect(compose).toContain("--ui-dist-dir /opt/openclaw-qa-lab-ui");
    });
  });

  it("falls back to Corepack for the QA UI build when pnpm is unavailable", async () => {
    await withDocker(async ({ composeFile, calls, up }) => {
      await up(
        { usePrebuiltImage: true },
        {
          async runCommand(command, args, cwd) {
            calls.push([command, ...args, `@${cwd}`].join(" "));
            if (command === "pnpm") {
              throw Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" });
            }
            if (args.join(" ").includes("ps --format json openclaw-qa-gateway")) {
              return healthy;
            }
            return empty;
          },
        },
      );

      expect(calls).toEqual([
        `pnpm qa:lab:build @${repoRoot}`,
        `corepack pnpm qa:lab:build @${repoRoot}`,
        `docker compose -f ${composeFile} down --remove-orphans @${repoRoot}`,
        `docker compose -f ${composeFile} up -d @${repoRoot}`,
        `docker compose -f ${composeFile} ps --format json openclaw-qa-gateway @${repoRoot}`,
      ]);
    });
  });

  it("does not hide real QA UI build failures behind the Corepack fallback", async () => {
    await withDocker(async ({ calls, up }) => {
      await expect(
        up(
          { usePrebuiltImage: true },
          {
            async runCommand(command, args, cwd) {
              calls.push([command, ...args, `@${cwd}`].join(" "));
              throw Object.assign(new Error("qa lab build failed"), { code: 1 });
            },
          },
        ),
      ).rejects.toThrow("qa lab build failed");

      expect(calls).toEqual([`pnpm qa:lab:build @${repoRoot}`]);
    });
  });

  it("uses a repo-root-relative default output dir when none is provided", async () => {
    const calls: string[] = [];
    await withTempDir("qa-docker-root-", async (tempRepoRoot) => {
      const result = await runQaDockerUp(
        {
          repoRoot: tempRepoRoot,
          usePrebuiltImage: true,
          skipUiBuild: true,
        },
        createHealthyDockerDeps(calls),
      );

      expect(result.outputDir).toBe(path.join(tempRepoRoot, ".artifacts/qa-docker"));
      expect(result.composeFile).toBe(
        path.join(tempRepoRoot, ".artifacts/qa-docker/docker-compose.qa.yml"),
      );
      expect(calls).toEqual([
        `docker compose -f ${path.join(tempRepoRoot, ".artifacts/qa-docker/docker-compose.qa.yml")} down --remove-orphans @${tempRepoRoot}`,
        `docker compose -f ${path.join(tempRepoRoot, ".artifacts/qa-docker/docker-compose.qa.yml")} up -d @${tempRepoRoot}`,
        `docker compose -f ${path.join(tempRepoRoot, ".artifacts/qa-docker/docker-compose.qa.yml")} ps --format json openclaw-qa-gateway @${tempRepoRoot}`,
      ]);
    });
  });

  it("falls back to free host ports when defaults are already occupied", async () => {
    await withDocker(async ({ up }) => {
      const gatewayPort = 18789;
      const qaLabPort = 43124;
      const resolveHostPort = vi.fn(async (preferredPort: number, pinned: boolean) => {
        expect(pinned).toBe(false);
        if (preferredPort === gatewayPort) {
          return 28001;
        }
        if (preferredPort === qaLabPort) {
          return 28002;
        }
        return preferredPort;
      });

      const result = await up(
        { skipUiBuild: true, usePrebuiltImage: true },
        { resolveHostPortImpl: resolveHostPort },
      );

      expect(result).toMatchObject({
        gatewayUrl: "http://127.0.0.1:28001/",
        qaLabUrl: "http://127.0.0.1:28002",
      });
      expect(resolveHostPort).toHaveBeenCalledWith(gatewayPort, false);
      expect(resolveHostPort).toHaveBeenCalledWith(qaLabPort, false);
    });
  });

  it("rejects explicit host port collisions before touching Docker", async () => {
    await withDocker(async ({ calls, up }) => {
      await expect(
        up({
          gatewayPort: 43124,
          qaLabPort: 43124,
          skipUiBuild: true,
          usePrebuiltImage: true,
        }),
      ).rejects.toThrow(
        "QA Lab gateway and UI host ports must be different. Both resolved to 43124.",
      );

      expect(calls).toEqual([]);
    });
  });

  it("rejects resolved host port collisions before writing the harness", async () => {
    await withDocker(async ({ composeFile, up }) => {
      const resolveHostPort = vi.fn(async () => 28001);

      await expect(
        up({ skipUiBuild: true, usePrebuiltImage: true }, { resolveHostPortImpl: resolveHostPort }),
      ).rejects.toThrow(
        "QA Lab gateway and UI host ports must be different. Both resolved to 28001.",
      );

      await expect(readFile(composeFile, "utf8")).rejects.toThrow("ENOENT");
    });
  });

  it("falls back to the container IP when the host gateway port is unreachable", async () => {
    const fetchCalls: string[] = [];
    const fetchSignals: AbortSignal[] = [];
    await withDocker(async ({ composeFile, calls, up }) => {
      const result = await up(
        {
          gatewayPort: 18889,
          qaLabPort: 43124,
          skipUiBuild: true,
          usePrebuiltImage: true,
        },
        {
          async runCommand(command, args, cwd) {
            calls.push([command, ...args, `@${cwd}`].join(" "));
            const joined = args.join(" ");
            if (joined.includes("ps --format json openclaw-qa-gateway")) {
              return healthy;
            }
            if (joined.includes("ps -q openclaw-qa-gateway")) {
              return { stdout: "gateway-container\n", stderr: "" };
            }
            if (command === "docker" && args[0] === "inspect") {
              return { stdout: "192.168.165.4\n", stderr: "" };
            }
            return empty;
          },
          fetchImpl: vi.fn(async (input: string, init?: Pick<RequestInit, "signal">) => {
            fetchCalls.push(input);
            if (init?.signal) {
              fetchSignals.push(init.signal);
            }
            if (input === "http://127.0.0.1:18889/healthz") {
              return { ok: false };
            }
            return {
              ok:
                input === "http://127.0.0.1:43124/healthz" ||
                input === "http://192.168.165.4:18789/healthz",
            };
          }),
        },
      );

      expect(calls).toEqual([
        `docker compose -f ${composeFile} down --remove-orphans @${repoRoot}`,
        `docker compose -f ${composeFile} up -d @${repoRoot}`,
        `docker compose -f ${composeFile} ps --format json openclaw-qa-gateway @${repoRoot}`,
        `docker compose -f ${composeFile} ps -q openclaw-qa-gateway @${repoRoot}`,
        `docker inspect --format {{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}} gateway-container @${repoRoot}`,
      ]);
      expect(fetchCalls).toEqual([
        "http://127.0.0.1:43124/healthz",
        "http://127.0.0.1:18889/healthz",
        "http://192.168.165.4:18789/healthz",
      ]);
      expect(fetchSignals).toHaveLength(3);
      expect(result.gatewayUrl).toBe("http://192.168.165.4:18789/");
    });
  });
});
