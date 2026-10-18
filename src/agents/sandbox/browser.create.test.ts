import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSandboxBrowserTestHarness } from "./browser.create.test-helpers.js";
import {
  SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH,
  SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
} from "./constants.js";
import { collectDockerFlagValues, findDockerArgsCall } from "./test-args.js";

describe("ensureSandboxBrowser create args", () => {
  const harness = createSandboxBrowserTestHarness();
  const {
    execContainer,
    tempDirs,
    dockerMocks,
    registryMocks,
    bridgeMocks,
    runtimeMocks,
    buildConfig,
    computeTestBrowserHash,
    ensureTestSandboxBrowser,
    requireDockerCreateArgs,
    snapshotDockerCreateEnvEntries,
    requireDockerCreateEnvEntries,
    requireValue,
    latestBridgeResolved,
    envValue,
    bridgeFixture,
  } = harness;

  const dockerArgs = (command: string) =>
    findDockerArgsCall(dockerMocks.execDocker.mock.calls, command);
  const dockerCalls = (command: string) =>
    dockerMocks.execDocker.mock.calls.filter(([args]) => args[0] === command);
  function expectBridgeStoppedBeforeRemoval() {
    const index = dockerMocks.execDocker.mock.calls.findIndex(([args]) => args[0] === "rm");
    expect(bridgeMocks.stopBrowserBridgeServer.mock.invocationCallOrder[0]).toBeLessThan(
      dockerMocks.execDocker.mock.invocationCallOrder[index] ?? Number.MAX_SAFE_INTEGER,
    );
  }

  it.each([
    {
      stdout: "<no value>\n",
      stderr: "",
      code: 0,
      error:
        "Sandbox browser image openclaw-sandbox-browser:bookworm-slim is stale or incompatible",
    },
    {
      stdout: "",
      stderr:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      code: 1,
      error: "Docker daemon is not available",
    },
  ])("rejects image inspection before creation: $error", async ({ error, ...result }) => {
    dockerMocks.execDocker.mockImplementation(async (args: string[]) =>
      args[0] === "image" && args[1] === "inspect" ? result : { stdout: "", stderr: "", code: 0 },
    );
    await expect(ensureTestSandboxBrowser()).rejects.toThrow(error);
    expect(dockerArgs("create")).toBeUndefined();
  });

  it("keeps the browser Dockerfile contract label aligned with the runtime constant", () => {
    const dockerfile = readFileSync(
      new URL("../../../scripts/docker/sandbox/Dockerfile.browser", import.meta.url),
      "utf8",
    );
    const label = dockerfile.match(
      /^LABEL org\.openclaw\.sandbox-browser\.contract="([^"]+)"$/m,
    )?.[1];

    expect(label).toBe(SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH);
  });

  it("delivers configured browser and generated CDP/noVNC environment without exposing values in Docker argv", async () => {
    const configuredSentinel = "synthetic-browser-transport-value";
    const cfg = buildConfig(true);
    cfg.docker.env = { ...cfg.docker.env, BROWSER_TRANSPORT_SENTINEL: configuredSentinel };
    const result = await ensureTestSandboxBrowser({ cfg });

    const createArgs = requireDockerCreateArgs();
    expect(createArgs.filter((arg) => arg === "--init")).toHaveLength(1);
    expect(createArgs).toContain(`openclaw.createArgsEpoch=${SANDBOX_DOCKER_CREATE_ARGS_EPOCH}`);

    expect(createArgs.some((arg) => arg.includes(configuredSentinel))).toBe(false);
    expect(createArgs).toContain("127.0.0.1::6080");
    expect(collectDockerFlagValues(createArgs, "--env-file")).toHaveLength(1);
    expect(createArgs).not.toContain("-e");
    expect(createArgs).not.toContain("--env");
    const envEntries = requireDockerCreateEnvEntries();
    expect(envEntries).toContain(`BROWSER_TRANSPORT_SENTINEL=${configuredSentinel}`);
    expect(envEntries).toContain("OPENCLAW_BROWSER_NO_SANDBOX=1");
    const noVncPassword = envValue("OPENCLAW_BROWSER_NOVNC_PASSWORD");
    const cdpAuthToken = envValue("OPENCLAW_BROWSER_CDP_AUTH_TOKEN");
    expect(noVncPassword).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(cdpAuthToken).toMatch(/^[0-9a-f]{48}$/);
    expect(createArgs.some((arg) => arg.includes(noVncPassword))).toBe(false);
    expect(createArgs.some((arg) => arg.includes(cdpAuthToken))).toBe(false);
    expect(envEntries).not.toContain("OPENCLAW_BROWSER_CDP_SOURCE_RANGE=172.21.0.1/32");
    expect(latestBridgeResolved().profiles).toMatchObject({
      openclaw: { cdpPort: 49100, cdpUrl: `http://openclaw:${cdpAuthToken}@127.0.0.1:49100` },
    });
    expect(result?.noVncUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sandbox\/novnc\?token=/);
    expect(result?.noVncUrl).not.toContain("password=");
  });

  it("serializes concurrent provisioning for the same browser container", async () => {
    let created = false;
    let cdpAuthToken: string | undefined;
    let configHash: string | undefined;
    dockerMocks.dockerContainerState.mockImplementation(async () => ({
      exists: created,
      running: created,
    }));
    dockerMocks.readDockerContainerEnvVar.mockImplementation(async (_containerName, key) =>
      key === "OPENCLAW_BROWSER_CDP_AUTH_TOKEN" ? (cdpAuthToken ?? null) : null,
    );
    dockerMocks.readDockerContainerLabel.mockImplementation(async () => configHash ?? null);
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: `${SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "create") {
        if (created) {
          throw new Error("docker name conflict");
        }
        created = true;
        const envEntries = requireValue(
          snapshotDockerCreateEnvEntries(args),
          "docker create environment file",
        );
        cdpAuthToken = envValue("OPENCLAW_BROWSER_CDP_AUTH_TOKEN", envEntries);
        configHash = envValue("openclaw.configHash", collectDockerFlagValues(args, "--label"));
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    await expect(
      Promise.all([ensureTestSandboxBrowser(), ensureTestSandboxBrowser()]),
    ).resolves.toHaveLength(2);

    expect(dockerCalls("create")).toHaveLength(1);
    expect(dockerCalls("start")).toHaveLength(1);
  });

  it.each([false, true])("handles a pre-init browser epoch (hot=%s)", async (hot) => {
    const cfg = buildConfig(false);
    const oldHash = await computeTestBrowserHash({ cfg, createArgsEpoch: "pre-init" });
    const containerName = "openclaw-sbx-browser-session-test-0661d10a";
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue("existing-cdp-token");
    dockerMocks.readDockerContainerLabel.mockResolvedValue(oldHash);
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        {
          containerName,
          sessionKey: "session:test",
          createdAtMs: 1,
          lastUsedAtMs: hot ? Date.now() : 0,
          image: cfg.browser.image,
          configHash: oldHash,
          cdpPort: 49100,
        },
      ],
    });
    if (!hot) {
      harness.BROWSER_BRIDGES.set("session:test", {
        containerName,
        bridge: { server: { listening: true } },
      });
    }
    const result = await ensureTestSandboxBrowser({ cfg });
    if (hot) {
      expect(dockerArgs("rm")).toBeUndefined();
      expect(dockerArgs("create")).toBeUndefined();
      expect(runtimeMocks.log).toHaveBeenCalledWith(
        expect.stringContaining(
          "Recreate to apply: openclaw sandbox recreate --browser --session session:test",
        ),
      );
      expect(registryMocks.updateBrowserRegistry.mock.calls.at(-1)?.[0]?.configHash).toBe(oldHash);
    } else {
      expect(dockerMocks.execDocker).toHaveBeenCalledWith(["rm", "-f", containerName], {
        allowFailure: true,
      });
      expectBridgeStoppedBeforeRemoval();
      expect(requireDockerCreateArgs()).toContain("--init");
      expect(
        requireDockerCreateEnvEntries().filter((entry) =>
          entry.startsWith("OPENCLAW_BROWSER_NOVNC_PASSWORD="),
        ),
      ).toStrictEqual([]);
      expect(result?.noVncUrl).toBeUndefined();
    }
  });

  it.each([
    { policy: "SSRF", change: { ssrfPolicy: { allowedHostnames: ["example.com"] } } },
    { policy: "evaluate", change: { evaluateEnabled: false } },
  ])("recreates a reusable bridge when its $policy policy changes", async ({ change }) => {
    bridgeMocks.startBrowserBridgeServer.mockImplementation(async ({ resolved }) =>
      bridgeFixture(resolved),
    );
    const common = { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } };

    await ensureTestSandboxBrowser(common);
    const initialBridge = await requireValue(
      bridgeMocks.startBrowserBridgeServer.mock.results[0],
      "bridge startup",
    ).value;
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(
      envValue("OPENCLAW_BROWSER_CDP_AUTH_TOKEN"),
    );
    dockerMocks.readDockerContainerLabel.mockResolvedValue(
      envValue("openclaw.configHash", requireDockerCreateArgs()),
    );

    await ensureTestSandboxBrowser(common);
    expect(bridgeMocks.startBrowserBridgeServer).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.stopBrowserBridgeServer).not.toHaveBeenCalled();

    await ensureTestSandboxBrowser({ ...common, ...change });
    expect(bridgeMocks.stopBrowserBridgeServer).toHaveBeenCalledExactlyOnceWith(
      initialBridge.server,
    );
    expect(bridgeMocks.startBrowserBridgeServer).toHaveBeenCalledTimes(2);
    expect(latestBridgeResolved()).toMatchObject(change);
    expect(dockerArgs("rm")).toBeUndefined();
  });

  it.each([200, 503])(
    "cancels the CDP probe response body after a %i startup probe",
    async (status) => {
      const cancels: Array<ReturnType<typeof vi.fn>> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        const cancel = vi.fn().mockResolvedValue(undefined);
        cancels.push(cancel);
        return {
          ok: status === 200,
          body: { cancel },
        } as never;
      });
      bridgeMocks.startBrowserBridgeServer.mockImplementationOnce(async (params) => {
        await params.onEnsureAttachTarget?.({});
        throw new Error("probe completed before bridge creation");
      });

      const cfg = buildConfig(false);
      cfg.browser.autoStartTimeoutMs = 50;

      await expect(ensureTestSandboxBrowser({ cfg })).rejects.toThrow(
        status === 200
          ? "probe completed before bridge creation"
          : "hung container has been forcefully removed",
      );

      expect(cancels).not.toHaveLength(0);
      cancels.forEach((cancel) => expect(cancel).toHaveBeenCalledOnce());
    },
  );

  it("keeps a stalled CDP request inside the browser startup deadline", async () => {
    const sockets = new Set<Socket>();
    const requestReceived = createDeferredCore();
    const responseClosed = createDeferredCore();
    const probeAdmitted = createDeferredCore();
    const realSetTimeout = setTimeout;
    const realClearTimeout = clearTimeout;
    const waitForNetwork = async <T>(pending: Promise<T>, message: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timer = realSetTimeout(() => reject(new Error(message)), 2_000);
            timer.unref();
          }),
        ]);
      } finally {
        if (timer) {
          realClearTimeout(timer);
        }
      }
    };
    let requestPath: string | undefined;
    const server = createServer((req, res) => {
      requestPath = req.url;
      req.resume();
      res.on("close", () => responseClosed.resolve());
      requestReceived.resolve();
      // Accept the actual CDP request but never send response headers.
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const cdpPort = (server.address() as AddressInfo).port;
    dockerMocks.readDockerPort.mockImplementation(async (_containerName: string, port: number) =>
      port === 9222 ? cdpPort : port === 6080 ? 49101 : null,
    );
    bridgeMocks.startBrowserBridgeServer.mockImplementationOnce(async (params) => {
      probeAdmitted.resolve();
      await params.onEnsureAttachTarget?.({});
      throw new Error("expected CDP startup to time out before bridge creation");
    });

    const cfg = buildConfig(false);
    cfg.browser.autoStartTimeoutMs = 250;
    let settled = false;
    const errors: unknown[] = [];
    let startupResult: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    try {
      // Keep the production deadline clock still while native HTTP establishes
      // the fixture's stalled request. Advance that same 250ms deadline only
      // after real request admission; never replace fetch or its abort signal.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const startup = ensureTestSandboxBrowser({ cfg });
      startupResult = startup.then(
        () => {
          settled = true;
          return { ok: true as const };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false as const, error };
        },
      );
      const earlySettlement = startupResult.then((result) => {
        throw result.ok
          ? new Error("Sandbox browser startup completed before the stalled request")
          : result.error;
      });
      // Do not charge mount/container preparation to the network-admission
      // guard, or hide an actual startup error behind an absent request.
      await Promise.race([probeAdmitted.promise, earlySettlement]);
      await waitForNetwork(
        Promise.race([requestReceived.promise, earlySettlement]),
        "CDP request was not received",
      );

      expect(requestPath).toBe("/json/version");
      await vi.advanceTimersByTimeAsync(cfg.browser.autoStartTimeoutMs - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await waitForNetwork(
        startupResult,
        "CDP startup did not settle at its deadline",
      );
      if (result.ok) {
        throw new Error("expected stalled CDP startup to fail");
      }
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain(
        `within ${cfg.browser.autoStartTimeoutMs}ms. The hung container has been forcefully removed.`,
      );
      expect(dockerMocks.execDocker).toHaveBeenCalledWith(
        ["rm", "-f", "openclaw-sbx-browser-session-test-0661d10a"],
        { allowFailure: true },
      );
      await waitForNetwork(responseClosed.promise, "Aborted CDP response did not close");
    } catch (error) {
      errors.push(error);
    }
    try {
      if (startupResult && !settled) {
        await vi.advanceTimersByTimeAsync(cfg.browser.autoStartTimeoutMs);
        await waitForNetwork(startupResult, "CDP startup did not settle during fixture cleanup");
      }
    } catch (error) {
      errors.push(error);
    } finally {
      vi.useRealTimers();
      for (const socket of sockets) {
        socket.destroy();
      }
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "CDP test and fixture cleanup failed");
    }
  });

  it("passes explicit cdpSourceRange as an additional relay filter", async () => {
    const cfg = buildConfig(false);
    cfg.browser.cdpSourceRange = "10.0.0.0/24";

    await ensureTestSandboxBrowser({ cfg });

    expect(requireDockerCreateEnvEntries()).toContain(
      "OPENCLAW_BROWSER_CDP_SOURCE_RANGE=10.0.0.0/24",
    );
  });

  it("retains a stale container and cached bridge until bridge cleanup can retry", async () => {
    const containerName = "openclaw-sbx-browser-session-test-0661d10a";
    const cached = { containerName, bridge: { server: { listening: true } } };
    harness.BROWSER_BRIDGES.set("session:test", cached);
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(null);
    bridgeMocks.stopBrowserBridgeServer.mockRejectedValueOnce(new Error("bridge cleanup failed"));

    await expect(ensureTestSandboxBrowser()).rejects.toThrow("bridge cleanup failed");

    expect(harness.BROWSER_BRIDGES.get("session:test")).toBe(cached);
    expect(dockerArgs("rm")).toBeUndefined();

    bridgeMocks.stopBrowserBridgeServer.mockClear();
    dockerMocks.execDocker.mockClear();
    await ensureTestSandboxBrowser();

    expectBridgeStoppedBeforeRemoval();
    expect(harness.BROWSER_BRIDGES.get("session:test")).not.toBe(cached);
  });

  it("rejects network=none before Docker inspection or browser bridge startup", async () => {
    const cfg = buildConfig(false);
    cfg.browser.network = "none";

    await expect(ensureTestSandboxBrowser({ cfg })).rejects.toThrow(
      'Sandbox browser network mode "none" is unsupported because browser control requires a host-reachable published CDP port.',
    );
    expect(dockerMocks.dockerContainerState).not.toHaveBeenCalled();
    expect(dockerMocks.execDocker).not.toHaveBeenCalled();
    expect(dockerMocks.readDockerPort).not.toHaveBeenCalled();
    expect(bridgeMocks.startBrowserBridgeServer).not.toHaveBeenCalled();
  });

  it("preserves a hot browser and bridge when a descendant tmpfs was removed", async () => {
    const containerName = "openclaw-sbx-browser-session-test-0661d10a";
    const bridge = { containerName, bridge: { server: { listening: true } } };
    harness.BROWSER_BRIDGES.set("session:test", bridge);
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue("existing-cdp-token");
    dockerMocks.readDockerContainerLabel.mockResolvedValue("old-tmpfs-config");
    vi.mocked(execContainer).mockResolvedValue({
      stdout: JSON.stringify({
        Mounts: [
          { Type: "bind", Source: harness.testWorkspaceDir, Destination: "/workspace", RW: true },
        ],
        Tmpfs: { "/workspace/cache": "rw" },
      }),
      stderr: "",
      code: 0,
    });
    const cfg = buildConfig(false);
    cfg.docker.tmpfs = [];
    await expect(ensureTestSandboxBrowser({ cfg })).rejects.toThrow(
      "openclaw sandbox recreate --browser --session session:test",
    );
    expect(dockerArgs("rm")).toBeUndefined();
    expect(dockerArgs("create")).toBeUndefined();
    expect(bridgeMocks.stopBrowserBridgeServer).not.toHaveBeenCalled();
    expect(harness.BROWSER_BRIDGES.get("session:test")).toBe(bridge);
  });

  it("skips browser user binds that conflict with protected skill overlay container paths", async () => {
    const workspaceDir = tempDirs.make("openclaw-browser-mounts-");
    const customRoot = tempDirs.make("openclaw-browser-mounts-");
    mkdirSync(path.join(workspaceDir, "skills", "demo"), { recursive: true });
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "rw";
    cfg.docker.dangerouslyAllowExternalBindSources = true;
    cfg.docker.dangerouslyAllowReservedContainerTargets = true;
    cfg.browser.binds = [`${customRoot}:/workspace/skills:rw`];

    await ensureTestSandboxBrowser({ cfg, workspaceDir });

    const bindArgs = collectDockerFlagValues(requireDockerCreateArgs(), "-v");
    const workspaceMountIdx = bindArgs.indexOf(`${workspaceDir}:/workspace:z`);
    const customMount = `${customRoot}:/workspace/skills:rw`;
    const protectedMount = `${path.join(workspaceDir, "skills")}:/workspace/skills:ro,z`;
    const protectedMountIdx = bindArgs.indexOf(protectedMount);

    expect(workspaceMountIdx).toBeGreaterThanOrEqual(0);
    expect(bindArgs).not.toContain(customMount);
    expect(protectedMountIdx).toBeGreaterThan(workspaceMountIdx);
  });
});
