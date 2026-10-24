// Qa Lab tests cover docker up plugin behavior.
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

function createHealthyDockerDeps(calls: string[]): QaDockerUpDeps {
  return {
    async runCommand(command, args, cwd) {
      calls.push([command, ...args, `@${cwd}`].join(" "));
      if (args.join(" ").includes("ps --format json openclaw-qa-gateway")) {
        return { stdout: '{"Health":"healthy","State":"running"}\n', stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    fetchImpl: vi.fn(async () => ({ ok: true })),
    sleepImpl: vi.fn(async () => {}),
  };
}

describe("runQaDockerUp", () => {
  it("builds the QA UI, writes the harness, starts compose, and waits for health", async () => {
    const calls: string[] = [];
    const fetchCalls: string[] = [];
    const responseQueue = [false, true, true];
    await withTempDir("qa-docker-up-", async (outputDir) => {
      const repoRoot = path.resolve("/repo/openclaw");
      const composeFile = path.join(outputDir, "docker-compose.qa.yml");

      const result = await runQaDockerUp(
        {
          repoRoot,
          outputDir,
          gatewayPort: 18889,
          qaLabPort: 43124,
        },
        {
          async runCommand(command, args, cwd) {
            calls.push([command, ...args, `@${cwd}`].join(" "));
            if (args.join(" ").includes("ps --format json openclaw-qa-gateway")) {
              return { stdout: '[{"Health":"healthy","State":"running"}]\n', stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
          fetchImpl: vi.fn(async (input: string) => {
            fetchCalls.push(input);
            return { ok: responseQueue.shift() ?? true };
          }),
          sleepImpl: vi.fn(async () => {}),
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
      expect(result.qaLabUrl).toBe("http://127.0.0.1:43124");
      expect(result.gatewayUrl).toBe("http://127.0.0.1:18889/");
      expect(result.composeFile).toBe(composeFile);
      expect(result.stopCommand).toBe(`docker compose -f ${shellQuote(composeFile)} down`);
    });
  });

  it("quotes the printed stop command when the compose path is shell-sensitive", async () => {
    const calls: string[] = [];
    await withTempDir("qa-docker-up-", async (tempRoot) => {
      const outputDir = path.join(tempRoot, "mac path's qa lab");
      const repoRoot = path.resolve("/repo/openclaw");
      const composeFile = path.join(outputDir, "docker-compose.qa.yml");

      const result = await runQaDockerUp(
        {
          repoRoot,
          outputDir,
          usePrebuiltImage: true,
          skipUiBuild: true,
        },
        createHealthyDockerDeps(calls),
      );

      expect(result.stopCommand).toBe(`docker compose -f ${shellQuote(composeFile)} down`);
      expect(calls).toContain(
        `docker compose -f ${composeFile} down --remove-orphans @${repoRoot}`,
      );
    });
  });

  it("skips UI build and compose --build for prebuilt images", async () => {
    const calls: string[] = [];
    await withTempDir("qa-docker-up-", async (outputDir) => {
      const repoRoot = path.resolve("/repo/openclaw");
      const composeFile = path.join(outputDir, "docker-compose.qa.yml");

      await runQaDockerUp(
        {
          repoRoot,
          outputDir,
          usePrebuiltImage: true,
          bindUiDist: true,
          skipUiBuild: true,
        },
        createHealthyDockerDeps(calls),
      );

      expect(calls).toEqual([
        `docker compose -f ${composeFile} down --remove-orphans @${repoRoot}`,
        `docker compose -f ${composeFile} up -d @${repoRoot}`,
        `docker compose -f ${composeFile} ps --format json openclaw-qa-gateway @${repoRoot}`,
      ]);
      const compose = await readFile(path.join(outputDir, "docker-compose.qa.yml"), "utf8");
      expect(compose).toContain(":/opt/openclaw-qa-lab-ui:ro");
      expect(compose).toContain("--ui-dist-dir /opt/openclaw-qa-lab-ui");
    });
  });

  it("falls back to Corepack for the QA UI build when pnpm is unavailable", async () => {
    const calls: string[] = [];
    await withTempDir("qa-docker-up-", async (outputDir) => {
      const repoRoot = path.resolve("/repo/openclaw");
      const composeFile = path.join(outputDir, "docker-compose.qa.yml");

      await runQaDockerUp(
        {
          repoRoot,
          outputDir,
          usePrebuiltImage: true,
        },
        {
          async runCommand(command, args, cwd) {
            calls.push([command, ...args, `@${cwd}`].join(" "));
            if (command === "pnpm") {
              throw Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" });
            }
            if (args.join(" ").includes("ps --format json openclaw-qa-gateway")) {
              return { stdout: '{"Health":"healthy","State":"running"}\n', stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
          fetchImpl: vi.fn(async () => ({ ok: true })),
          sleepImpl: vi.fn(async () => {}),
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
    const calls: string[] = [];
    await withTempDir("qa-docker-up-", async (outputDir) => {
      const repoRoot = path.resolve("/repo/openclaw");

      await expect(
        runQaDockerUp(
          {
            repoRoot,
            outputDir,
            usePrebuiltImage: true,
          },
          {
            async runCommand(command, args, cwd) {
              calls.push([command, ...args, `@${cwd}`].join(" "));
              throw Object.assign(new Error("qa lab build failed"), { code: 1 });
            },
            fetchImpl: vi.fn(async () => ({ ok: true })),
            sleepImpl: vi.fn(async () => {}),
          },
        ),
      ).rejects.toThrow("qa lab build failed");

      expect(calls).toEqual([`pnpm qa:lab:build @${repoRoot}`]);
    });
  });

  it("uses a repo-root-relative default output dir when none is provided", async () => {
    const calls: string[] = [];
    await withTempDir("qa-docker-root-", async (repoRoot) => {
      const result = await runQaDockerUp(
        {
          repoRoot,
          usePrebuiltImage: true,
          skipUiBuild: true,
        },
        createHealthyDockerDeps(calls),
      );

      expect(result.outputDir).toBe(path.join(repoRoot, ".artifacts/qa-docker"));
      expect(result.composeFile).toBe(
        path.join(repoRoot, ".artifacts/qa-docker/docker-compose.qa.yml"),
      );
      expect(calls).toEqual([
        `docker compose -f ${path.join(repoRoot, ".artifacts/qa-docker/docker-compose.qa.yml")} down --remove-orphans @${repoRoot}`,
        `docker compose -f ${path.join(repoRoot, ".artifacts/qa-docker/docker-compose.qa.yml")} up -d @${repoRoot}`,
        `docker compose -f ${path.join(repoRoot, ".artifacts/qa-docker/docker-compose.qa.yml")} ps --format json openclaw-qa-gateway @${repoRoot}`,
      ]);
    });
  });

  it("falls back to free host ports when defaults are already occupied", async () => {
    await withTempDir("qa-docker-up-", async (outputDir) => {
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

      const result = await runQaDockerUp(
        {
          repoRoot: "/repo/openclaw",
          outputDir,
          skipUiBuild: true,
          usePrebuiltImage: true,
        },
        {
          async runCommand() {
            return {
              stdout: '{"Health":"healthy","State":"running"}\n',
              stderr: "",
            };
          },
          fetchImpl: vi.fn(async () => ({ ok: true })),
          sleepImpl: vi.fn(async () => {}),
          resolveHostPortImpl: resolveHostPort,
        },
      );

      expect(result.gatewayUrl).not.toBe(`http://127.0.0.1:${gatewayPort}/`);
      expect(result.qaLabUrl).not.toBe(`http://127.0.0.1:${qaLabPort}`);
      expect(result.gatewayUrl).toBe("http://127.0.0.1:28001/");
      expect(result.qaLabUrl).toBe("http://127.0.0.1:28002");
      expect(resolveHostPort).toHaveBeenCalledWith(gatewayPort, false);
      expect(resolveHostPort).toHaveBeenCalledWith(qaLabPort, false);
    });
  });

  it("rejects explicit host port collisions before touching Docker", async () => {
    const calls: string[] = [];
    await withTempDir("qa-docker-up-", async (outputDir) => {
      await expect(
        runQaDockerUp(
          {
            repoRoot: "/repo/openclaw",
            outputDir,
            gatewayPort: 43124,
            qaLabPort: 43124,
            skipUiBuild: true,
            usePrebuiltImage: true,
          },
          createHealthyDockerDeps(calls),
        ),
      ).rejects.toThrow(
        "QA Lab gateway and UI host ports must be different. Both resolved to 43124.",
      );

      expect(calls).toEqual([]);
    });
  });

  it("rejects resolved host port collisions before writing the harness", async () => {
    await withTempDir("qa-docker-up-", async (outputDir) => {
      const resolveHostPort = vi.fn(async () => 28001);

      await expect(
        runQaDockerUp(
          {
            repoRoot: "/repo/openclaw",
            outputDir,
            skipUiBuild: true,
            usePrebuiltImage: true,
          },
          {
            ...createHealthyDockerDeps([]),
            resolveHostPortImpl: resolveHostPort,
          },
        ),
      ).rejects.toThrow(
        "QA Lab gateway and UI host ports must be different. Both resolved to 28001.",
      );

      await expect(readFile(path.join(outputDir, "docker-compose.qa.yml"), "utf8")).rejects.toThrow(
        "ENOENT",
      );
    });
  });

  it("falls back to the container IP when the host gateway port is unreachable", async () => {
    const calls: string[] = [];
    const fetchCalls: string[] = [];
    const fetchSignals: AbortSignal[] = [];
    await withTempDir("qa-docker-up-", async (outputDir) => {
      const repoRoot = path.resolve("/repo/openclaw");
      const composeFile = path.join(outputDir, "docker-compose.qa.yml");

      const result = await runQaDockerUp(
        {
          repoRoot,
          outputDir,
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
              return { stdout: '{"Health":"healthy","State":"running"}\n', stderr: "" };
            }
            if (joined.includes("ps -q openclaw-qa-gateway")) {
              return { stdout: "gateway-container\n", stderr: "" };
            }
            if (command === "docker" && args[0] === "inspect") {
              return { stdout: "192.168.165.4\n", stderr: "" };
            }
            return { stdout: "", stderr: "" };
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
          sleepImpl: vi.fn(async () => {}),
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
