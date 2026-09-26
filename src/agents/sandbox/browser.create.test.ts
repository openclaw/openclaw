import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSandboxBrowserTestHarness } from "./browser.create.test-helpers.js";
import { SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH } from "./config-hash.js";
import {
  SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH,
  SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
} from "./constants.js";
import { collectDockerFlagValues, findDockerArgsCall } from "./test-args.js";

describe("ensureSandboxBrowser create args", () => {
  const harness = createSandboxBrowserTestHarness();
  const {
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
  } = harness;

  it("rejects stale sandbox browser images without the relay auth contract", async () => {
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: "<no value>\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: harness.testWorkspaceDir,
        agentWorkspaceDir: harness.testWorkspaceDir,
        cfg: buildConfig(false),
      }),
    ).rejects.toThrow(
      "Sandbox browser image openclaw-sandbox-browser:bookworm-slim is stale or incompatible",
    );

    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create")).toBeUndefined();
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
    // noVNC password stays in the container environment; external access uses a
    // short-lived observer token so URLs do not carry the password.
    const configuredSentinel = "synthetic-browser-transport-value";
    const cfg = buildConfig(true);
    cfg.docker.env = { ...cfg.docker.env, BROWSER_TRANSPORT_SENTINEL: configuredSentinel };
    const result = await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg,
    });

    const createArgs = requireDockerCreateArgs();

    expect(createArgs.some((arg) => arg.includes(configuredSentinel))).toBe(false);
    expect(createArgs).toContain("127.0.0.1::6080");
    expect(collectDockerFlagValues(createArgs, "--env-file")).toHaveLength(1);
    expect(createArgs).not.toContain("-e");
    expect(createArgs).not.toContain("--env");
    const envEntries = requireDockerCreateEnvEntries();
    expect(envEntries).toContain(`BROWSER_TRANSPORT_SENTINEL=${configuredSentinel}`);
    expect(envEntries).toContain("OPENCLAW_BROWSER_NO_SANDBOX=1");
    const passwordEntry = envEntries.find((entry) =>
      entry.startsWith("OPENCLAW_BROWSER_NOVNC_PASSWORD="),
    );
    expect(passwordEntry).toMatch(/^OPENCLAW_BROWSER_NOVNC_PASSWORD=[A-Za-z0-9]{8}$/);
    const authEntry = envEntries.find((entry) =>
      entry.startsWith("OPENCLAW_BROWSER_CDP_AUTH_TOKEN="),
    );
    expect(authEntry).toMatch(/^OPENCLAW_BROWSER_CDP_AUTH_TOKEN=[0-9a-f]{48}$/);
    const noVncPassword = requireValue(passwordEntry, "noVNC password env").slice(
      "OPENCLAW_BROWSER_NOVNC_PASSWORD=".length,
    );
    const cdpAuthToken = requireValue(authEntry, "CDP auth env").slice(
      "OPENCLAW_BROWSER_CDP_AUTH_TOKEN=".length,
    );
    expect(createArgs.some((arg) => arg.includes(noVncPassword))).toBe(false);
    expect(createArgs.some((arg) => arg.includes(cdpAuthToken))).toBe(false);
    expect(result?.noVncUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sandbox\/novnc\?token=/);
    expect(result?.noVncUrl).not.toContain("password=");
  });

  it("creates browser containers with Docker init and the shared args epoch", async () => {
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
    });

    const createArgs = requireDockerCreateArgs();
    expect(createArgs.filter((arg) => arg === "--init")).toHaveLength(1);
    expect(createArgs).toContain(`openclaw.createArgsEpoch=${SANDBOX_DOCKER_CREATE_ARGS_EPOCH}`);
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
        cdpAuthToken = envEntries
          .find((entry) => entry.startsWith("OPENCLAW_BROWSER_CDP_AUTH_TOKEN="))
          ?.slice("OPENCLAW_BROWSER_CDP_AUTH_TOKEN=".length);
        configHash = collectDockerFlagValues(args, "--label")
          .find((entry) => entry.startsWith("openclaw.configHash="))
          ?.slice("openclaw.configHash=".length);
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const params = {
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
    };
    await expect(
      Promise.all([ensureTestSandboxBrowser(params), ensureTestSandboxBrowser(params)]),
    ).resolves.toHaveLength(2);

    expect(dockerMocks.execDocker.mock.calls.filter(([args]) => args[0] === "create")).toHaveLength(
      1,
    );
    expect(dockerMocks.execDocker.mock.calls.filter(([args]) => args[0] === "start")).toHaveLength(
      1,
    );
  });

  it("recreates a cold browser container when the shared args epoch changes", async () => {
    const cfg = buildConfig(false);
    const oldHash = await computeTestBrowserHash({
      cfg,
      createArgsEpoch: "pre-init",
    });
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue("existing-cdp-token");
    dockerMocks.readDockerContainerLabel.mockResolvedValue(oldHash);
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-browser-session-test-0661d10a",
          sessionKey: "session:test",
          createdAtMs: 1,
          lastUsedAtMs: 0,
          image: cfg.browser.image,
          configHash: oldHash,
          cdpPort: 49100,
        },
      ],
    });
    harness.BROWSER_BRIDGES.set("session:test", {
      containerName: "openclaw-sbx-browser-session-test-0661d10a",
      bridge: { server: { listening: true } },
    });

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg,
    });

    expect(dockerMocks.execDocker).toHaveBeenCalledWith(
      ["rm", "-f", "openclaw-sbx-browser-session-test-0661d10a"],
      { allowFailure: true },
    );
    const rmCallIndex = dockerMocks.execDocker.mock.calls.findIndex(([args]) => args[0] === "rm");
    expect(bridgeMocks.stopBrowserBridgeServer.mock.invocationCallOrder[0]).toBeLessThan(
      dockerMocks.execDocker.mock.invocationCallOrder[rmCallIndex] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(requireDockerCreateArgs()).toContain("--init");
  });

  it("keeps a hot pre-init browser running and emits the recreate hint", async () => {
    const cfg = buildConfig(false);
    const oldHash = await computeTestBrowserHash({
      cfg,
      createArgsEpoch: "pre-init",
    });
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue("existing-cdp-token");
    dockerMocks.readDockerContainerLabel.mockResolvedValue(oldHash);
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-browser-session-test-0661d10a",
          sessionKey: "session:test",
          createdAtMs: 1,
          lastUsedAtMs: Date.now(),
          image: cfg.browser.image,
          configHash: oldHash,
          cdpPort: 49100,
        },
      ],
    });

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg,
    });

    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "rm")).toBeUndefined();
    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create")).toBeUndefined();
    expect(runtimeMocks.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Recreate to apply: openclaw sandbox recreate --browser --session session:test",
      ),
    );
    expect(registryMocks.updateBrowserRegistry.mock.calls.at(-1)?.[0]?.configHash).toBe(oldHash);
  });

  it("does not inject noVNC password env when noVNC is disabled", async () => {
    const result = await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
    });

    const envEntries = requireDockerCreateEnvEntries();
    expect(
      envEntries.filter((entry) => entry.startsWith("OPENCLAW_BROWSER_NOVNC_PASSWORD=")),
    ).toStrictEqual([]);
    expect(result?.noVncUrl).toBeUndefined();
  });

  it.each([false, true])(
    "includes the explicit env policy epoch in the browser config hash with skill mount=%s",
    async (withSkillMount) => {
      const cfg = buildConfig(false);
      cfg.docker.env = {
        LANG: "C.UTF-8",
        GEMINI_API_KEY: "dummy-gemini",
      };
      const scopeKey = "session-1";
      const workspaceDir = harness.testWorkspaceDir;
      const agentWorkspaceDir = workspaceDir;
      if (withSkillMount) {
        mkdirSync(path.join(workspaceDir, "skills"));
      }
      const hashInputs = {
        cfg,
        dockerEnvPolicyEpoch: SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH,
        workspaceDir,
        agentWorkspaceDir,
        createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
      };
      const expectedHash = await computeTestBrowserHash(hashInputs);
      expect(expectedHash).not.toBe(
        await computeTestBrowserHash({ ...hashInputs, dockerEnvPolicyEpoch: undefined }),
      );

      await ensureTestSandboxBrowser({
        scopeKey,
        workspaceDir,
        agentWorkspaceDir,
        cfg,
      });

      const createArgs = requireDockerCreateArgs();
      expect(createArgs).toContain(`openclaw.configHash=${expectedHash}`);
      expect(requireDockerCreateEnvEntries()).toContain("GEMINI_API_KEY=dummy-gemini");
      expect(createArgs.some((arg) => arg.includes("dummy-gemini"))).toBe(false);
    },
  );

  it("fails before creating a browser container when Docker daemon is unavailable", async () => {
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "network" && args[1] === "inspect") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return {
          stdout: "",
          stderr:
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
          code: 1,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: harness.testWorkspaceDir,
        agentWorkspaceDir: harness.testWorkspaceDir,
        cfg: buildConfig(false),
      }),
    ).rejects.toThrow("Docker daemon is not available");

    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create")).toBeUndefined();
  });

  it("passes the browser SSRF policy to the sandbox bridge", async () => {
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });

    expect(latestBridgeResolved().ssrfPolicy).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
  });

  it("recreates a cached bridge when the SSRF policy changes", async () => {
    const existingBridge = {
      server: { listening: true } as never,
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: {
        resolved: {
          enabled: true,
          evaluateEnabled: true,
          controlPort: 0,
          cdpProtocol: "http",
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          cdpPortRangeStart: 18800,
          cdpPortRangeEnd: 18899,
          extensionRelayDefaultPort: 18799,
          extensionRelayPorts: {},
          remoteCdpTimeoutMs: 1500,
          remoteCdpHandshakeTimeoutMs: 3000,
          localLaunchTimeoutMs: 15_000,
          localCdpReadyTimeoutMs: 8_000,
          color: "#FF4500",
          headless: false,
          noSandbox: false,
          attachOnly: true,
          defaultProfile: "openclaw",
          extraArgs: [],
          tabCleanup: {
            enabled: true,
            idleMinutes: 120,
            maxTabsPerSession: 8,
            sweepMinutes: 5,
          },
          profiles: {
            openclaw: {
              cdpPort: 49100,
              color: "#FF4500",
            },
          },
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        },
      },
    };
    harness.BROWSER_BRIDGES.set("session:test", {
      bridge: existingBridge,
      containerName: "openclaw-sbx-browser-session-test-0661d10a",
      authToken: "test-bridge-token",
    });
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
      ssrfPolicy: { allowedHostnames: ["example.com"] },
    });

    expect(bridgeMocks.stopBrowserBridgeServer).toHaveBeenCalledWith(existingBridge.server);
    expect(latestBridgeResolved().ssrfPolicy).toEqual({
      allowedHostnames: ["example.com"],
    });
  });

  it("recreates a cached bridge when evaluate permission changes", async () => {
    const existingBridge = {
      server: { listening: true } as never,
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: {
        resolved: {
          enabled: true,
          evaluateEnabled: true,
          controlPort: 0,
          cdpProtocol: "http",
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          cdpPortRangeStart: 18800,
          cdpPortRangeEnd: 18899,
          extensionRelayDefaultPort: 18799,
          extensionRelayPorts: {},
          remoteCdpTimeoutMs: 1500,
          remoteCdpHandshakeTimeoutMs: 3000,
          localLaunchTimeoutMs: 15_000,
          localCdpReadyTimeoutMs: 8_000,
          color: "#FF4500",
          headless: false,
          noSandbox: false,
          attachOnly: true,
          defaultProfile: "openclaw",
          extraArgs: [],
          tabCleanup: {
            enabled: true,
            idleMinutes: 120,
            maxTabsPerSession: 8,
            sweepMinutes: 5,
          },
          profiles: {
            openclaw: {
              cdpPort: 49100,
              color: "#FF4500",
            },
          },
        },
      },
    };
    harness.BROWSER_BRIDGES.set("session:test", {
      bridge: existingBridge,
      containerName: "openclaw-sbx-browser-session-test-0661d10a",
      authToken: "test-bridge-token",
    });
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
      evaluateEnabled: false,
    });

    expect(bridgeMocks.stopBrowserBridgeServer).toHaveBeenCalledWith(existingBridge.server);
    expect(latestBridgeResolved().evaluateEnabled).toBe(false);
  });

  it("force-removes the browser container when CDP never becomes reachable", async () => {
    // A browser container that starts but never exposes CDP is unusable; remove
    // it immediately so the next attempt recreates from a clean state.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    bridgeMocks.startBrowserBridgeServer.mockImplementationOnce(async (params) => {
      await params.onEnsureAttachTarget?.({});
      return {
        server: {} as never,
        port: 19000,
        baseUrl: "http://127.0.0.1:19000",
        state: {
          server: null,
          port: 19000,
          resolved: { profiles: {} },
          profiles: new Map(),
        },
      };
    });

    const cfg = buildConfig(false);
    cfg.browser.autoStartTimeoutMs = 1;

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: harness.testWorkspaceDir,
        agentWorkspaceDir: harness.testWorkspaceDir,
        cfg,
      }),
    ).rejects.toThrow("hung container has been forcefully removed");

    expect(dockerMocks.execDocker).toHaveBeenCalledWith(
      ["rm", "-f", "openclaw-sbx-browser-session-test-0661d10a"],
      { allowFailure: true },
    );
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

      await expect(
        ensureTestSandboxBrowser({
          scopeKey: "session:test",
          workspaceDir: harness.testWorkspaceDir,
          agentWorkspaceDir: harness.testWorkspaceDir,
          cfg,
        }),
      ).rejects.toThrow(
        status === 200
          ? "probe completed before bridge creation"
          : "hung container has been forcefully removed",
      );

      expect(cancels).not.toHaveLength(0);
      for (const cancel of cancels) {
        expect(cancel).toHaveBeenCalledOnce();
      }
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
    dockerMocks.readDockerPort.mockImplementation(async (_containerName: string, port: number) => {
      if (port === 9222) {
        return cdpPort;
      }
      if (port === 6080) {
        return 49101;
      }
      return null;
    });
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
      const startup = ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: harness.testWorkspaceDir,
        agentWorkspaceDir: harness.testWorkspaceDir,
        cfg,
      });
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
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected stalled CDP startup to fail");
      }
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain(
        `within ${cfg.browser.autoStartTimeoutMs}ms. The hung container has been forcefully removed.`,
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

  it("requires auth for the sandbox CDP relay without auto-derived source ranges", async () => {
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
    });

    const envEntries = requireDockerCreateEnvEntries();
    const authEntry = envEntries.find((entry) =>
      entry.startsWith("OPENCLAW_BROWSER_CDP_AUTH_TOKEN="),
    );
    expect(authEntry).toMatch(/^OPENCLAW_BROWSER_CDP_AUTH_TOKEN=[0-9a-f]{48}$/);
    expect(envEntries).not.toContain("OPENCLAW_BROWSER_CDP_SOURCE_RANGE=172.21.0.1/32");

    const token = requireValue(authEntry, "CDP auth env").slice(
      "OPENCLAW_BROWSER_CDP_AUTH_TOKEN=".length,
    );
    const profiles = latestBridgeResolved().profiles as Record<
      string,
      { cdpPort?: number; cdpUrl?: string }
    >;
    expect(profiles.openclaw?.cdpPort).toBe(49100);
    expect(profiles.openclaw?.cdpUrl).toBe(`http://openclaw:${token}@127.0.0.1:49100`);
  });

  it("passes explicit cdpSourceRange as an additional relay filter", async () => {
    const cfg = buildConfig(false);
    cfg.browser.cdpSourceRange = "10.0.0.0/24";

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg,
    });

    const envEntries = requireDockerCreateEnvEntries();
    expect(envEntries).toContain("OPENCLAW_BROWSER_CDP_SOURCE_RANGE=10.0.0.0/24");
  });

  it("recreates existing browser containers that do not expose relay auth", async () => {
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(null);

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
    });

    expect(dockerMocks.execDocker).toHaveBeenCalledWith(
      ["rm", "-f", "openclaw-sbx-browser-session-test-0661d10a"],
      { allowFailure: true },
    );
    requireDockerCreateArgs();
  });

  it("retains a stale container and cached bridge until bridge cleanup can retry", async () => {
    const containerName = "openclaw-sbx-browser-session-test-0661d10a";
    const cached = {
      containerName,
      bridge: { server: { listening: true } },
    };
    harness.BROWSER_BRIDGES.set("session:test", cached);
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(null);
    bridgeMocks.stopBrowserBridgeServer.mockRejectedValueOnce(new Error("bridge cleanup failed"));

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: harness.testWorkspaceDir,
        agentWorkspaceDir: harness.testWorkspaceDir,
        cfg: buildConfig(false),
      }),
    ).rejects.toThrow("bridge cleanup failed");

    expect(harness.BROWSER_BRIDGES.get("session:test")).toBe(cached);
    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "rm")).toBeUndefined();

    bridgeMocks.stopBrowserBridgeServer.mockClear();
    dockerMocks.execDocker.mockClear();
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
    });

    const rmCallIndex = dockerMocks.execDocker.mock.calls.findIndex(([args]) => args[0] === "rm");
    expect(bridgeMocks.stopBrowserBridgeServer.mock.invocationCallOrder[0]).toBeLessThan(
      dockerMocks.execDocker.mock.invocationCallOrder[rmCallIndex] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(harness.BROWSER_BRIDGES.get("session:test")).not.toBe(cached);
  });

  it("rejects network=none before Docker inspection or browser bridge startup", async () => {
    const cfg = buildConfig(false);
    cfg.browser.network = "none";

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: harness.testWorkspaceDir,
        agentWorkspaceDir: harness.testWorkspaceDir,
        cfg,
      }),
    ).rejects.toThrow(
      'Sandbox browser network mode "none" is unsupported because browser control requires a host-reachable published CDP port.',
    );
    expect(dockerMocks.dockerContainerState).not.toHaveBeenCalled();
    expect(dockerMocks.execDocker).not.toHaveBeenCalled();
    expect(dockerMocks.readDockerPort).not.toHaveBeenCalled();
    expect(bridgeMocks.startBrowserBridgeServer).not.toHaveBeenCalled();
  });
});
