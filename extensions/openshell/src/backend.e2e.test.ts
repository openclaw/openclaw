import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import type { CreateSandboxBackendParams, SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import {
  buildOpenShellPolicyYaml,
  cleanupOpenShellWorkspace,
  runCommand,
  runBackendExec,
  runPreparedBackendExec,
  stressBackend,
  verifyRemoteExecOverlap,
} from "./backend.e2e.test-support.js";
import {
  createOpenShellSandboxBackendFactory,
  createOpenShellSandboxBackendManager,
} from "./backend.js";
import { resolveOpenShellPluginConfig } from "./config.js";
import {
  createOpenShellBackendSandboxConfig,
  createOpenShellRuntimeEntryFixture,
} from "./openshell.test-support.js";

const OPENCLAW_OPENSHELL_E2E = process.env.OPENCLAW_E2E_OPENSHELL === "1";
const OPENCLAW_OPENSHELL_E2E_TIMEOUT_MS = 12 * 60_000;
const OPENCLAW_OPENSHELL_COMMAND =
  process.env.OPENCLAW_E2E_OPENSHELL_COMMAND?.trim() || "openshell";
const OPENCLAW_OPENSHELL_CONFIG_HOME =
  process.env.OPENCLAW_E2E_OPENSHELL_CONFIG_HOME?.trim() || null;
const OPENCLAW_OPENSHELL_HOST_IP = process.env.OPENCLAW_E2E_OPENSHELL_HOST_IP;

const CUSTOM_IMAGE_DOCKERFILE = `FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
    coreutils curl findutils iproute2 nftables \\
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1000660000 sandbox && \\
    useradd -m -u 1000660000 -g sandbox sandbox && \\
    install -d -o sandbox -g sandbox /sandbox

RUN echo "openclaw-openshell-e2e" > /opt/openshell-e2e-marker.txt

USER sandbox
WORKDIR /sandbox
CMD ["sleep", "infinity"]
`;

async function commandSucceeds(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  try {
    const result = await runCommand({
      command,
      args,
      env,
      allowFailure: true,
      timeoutMs: 20_000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

function parseActiveLocalOpenShellGateway(stdout: string): string | null {
  let gateways: unknown;
  try {
    gateways = JSON.parse(stdout);
  } catch {
    return null;
  }
  return Array.isArray(gateways)
    ? (gateways.find(
        (gateway) =>
          gateway !== null &&
          typeof gateway === "object" &&
          gateway.active === true &&
          typeof gateway.name === "string" &&
          typeof gateway.endpoint === "string" &&
          /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/u.test(
            gateway.endpoint,
          ),
      )?.name ?? null)
    : null;
}

async function activeOpenShellGateway(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const result = await runCommand({
      command,
      args: ["gateway", "list", "--output", "json"],
      env,
      allowFailure: true,
      timeoutMs: 20_000,
    });
    if (result.code !== 0) {
      return null;
    }
    const gateway = parseActiveLocalOpenShellGateway(result.stdout);
    if (!gateway) {
      return null;
    }
    return (await commandSucceeds(command, ["--gateway", gateway, "sandbox", "list"], env))
      ? gateway
      : null;
  } catch {
    return null;
  }
}

async function allocatePort(): Promise<number> {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await closeServer(server);
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate local port");
  }
  return address.port;
}

const closeServer = (server: net.Server) => promisify(server.close.bind(server))();

function openshellEnv(rootDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: path.join(rootDir, "home"),
    XDG_CONFIG_HOME: path.join(rootDir, "xdg"),
    XDG_CACHE_HOME: path.join(rootDir, "xdg-cache"),
  };
}

function createBridge(backend: SandboxBackendHandle, workspaceDir: string) {
  const sandbox = createSandboxTestContext({
    overrides: {
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      containerWorkdir: backend.workdir,
      backend,
    },
  });
  return expectDefined(backend.createFsBridge?.({ sandbox }), "OpenShell filesystem bridge");
}

const readFile = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8");
const writeFile = (root: string, file: string, data: string) =>
  fs.writeFile(path.join(root, file), data, "utf8");
const expectFile = (root: string, file: string, data: string) =>
  expect(readFile(root, file)).resolves.toBe(data);
const exec = (
  backend: SandboxBackendHandle,
  command: string,
  options: Omit<Parameters<typeof runBackendExec>[0], "backend" | "command"> = {},
) => runBackendExec({ backend, command, timeoutMs: 60_000, ...options });
async function expectExec(
  backend: SandboxBackendHandle,
  command: string,
  stdout: string,
  timeoutMs?: number,
) {
  await expect(runBackendExec({ backend, command, timeoutMs })).resolves.toMatchObject({
    code: 0,
    stdout,
  });
}

function prepareExec(
  backend: SandboxBackendHandle,
  command: string,
  env: Record<string, string> = {},
) {
  return backend.buildExecSpec({ command, env, usePty: false });
}
function failExec(backend: SandboxBackendHandle, token: unknown) {
  return backend.finalizeExec?.({ status: "failed", exitCode: 1, timedOut: false, token });
}

async function startHostPolicyServer(gatewayName: string) {
  const port = await allocatePort();
  const responseBody = JSON.stringify({ ok: true, message: "hello-from-host" });
  const serverScript = `from http.server import BaseHTTPRequestHandler, HTTPServer
import os

BODY = os.environ["RESPONSE_BODY"].encode()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def log_message(self, _format, *_args):
        pass

HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
`;
  const startResult = await runCommand({
    command: "docker",
    args: [
      "run",
      "--detach",
      "--rm",
      "--label",
      `openclaw.ai/openshell-e2e-gateway=${gatewayName}`,
      "-e",
      `RESPONSE_BODY=${responseBody}`,
      "-p",
      `${port}:8000`,
      "python:3.13-alpine",
      "python3",
      "-c",
      serverScript,
    ],
    timeoutMs: 60_000,
  });
  const containerId = startResult.stdout.trim();
  if (!containerId) {
    throw new Error("failed to start docker-backed host policy server");
  }
  const stop = { command: "docker", args: ["rm", "-f", containerId], timeoutMs: 30_000 };
  const readinessScript =
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000', timeout=1).read()";

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const readyResult = await runCommand({
      command: "docker",
      args: ["exec", containerId, "python3", "-c", readinessScript],
      allowFailure: true,
      timeoutMs: 15_000,
    });
    if (readyResult.code === 0) {
      return {
        port,
        async close() {
          await runCommand(stop);
        },
      };
    }
    await delay(500);
  }

  await runCommand({ ...stop, allowFailure: true });
  throw new Error("docker-backed host policy server did not become ready");
}

const gateway = (name: string, endpoint: string, active: boolean) => ({ name, endpoint, active });
it.each<[string, string, string | null]>([
  [
    "active local",
    JSON.stringify([
      gateway("remote", "https://gateway.example.com", false),
      gateway("openshell", "https://127.0.0.1:17670", true),
    ]),
    "openshell",
  ],
  ["malformed output", "not json", null],
  ["active remote", JSON.stringify([gateway("remote", "https://gateway.example.com", true)]), null],
])("discovers OpenShell gateways: %s", (_name, output, expected) => {
  expect(parseActiveLocalOpenShellGateway(output)).toBe(expected);
});

it
  .runIf(process.platform !== "win32" && OPENCLAW_OPENSHELL_E2E)
  .each(["mirror", "remote"] as const)(
  "runs remote and mirrored sandboxes in a non-default OpenShell workspace with %s stress",
  { timeout: OPENCLAW_OPENSHELL_E2E_TIMEOUT_MS },
  async (stressMode) => {
    if (!(await commandSucceeds("docker", ["version"]))) {
      throw new Error("OpenShell E2E requires a working Docker daemon");
    }
    if (!(await commandSucceeds(OPENCLAW_OPENSHELL_COMMAND, ["--help"]))) {
      throw new Error(`OpenShell CLI is unavailable: ${OPENCLAW_OPENSHELL_COMMAND}`);
    }
    if (!OPENCLAW_OPENSHELL_CONFIG_HOME) {
      throw new Error(
        "OpenShell E2E requires OPENCLAW_E2E_OPENSHELL_CONFIG_HOME because tests isolate HOME and XDG_CONFIG_HOME",
      );
    }
    const openshellConfigHome = OPENCLAW_OPENSHELL_CONFIG_HOME;
    const gatewayName = await activeOpenShellGateway(OPENCLAW_OPENSHELL_COMMAND, {
      ...process.env,
      XDG_CONFIG_HOME: openshellConfigHome,
    });
    if (!gatewayName) {
      throw new Error("OpenShell E2E requires an active local registered gateway");
    }

    // macOS sockaddr_un cannot hold the test runner's nested temporary path, and the
    // mirror socket under this root would exceed it.
    const rootDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "oc-osh-e2e-"));
    const env = openshellEnv(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const mirrorWorkspaceDir = path.join(rootDir, "mirror");
    const overlapWorkspaceDir = path.join(rootDir, "overlap-primary");
    const overlapAgentWorkspaceDir = path.join(rootDir, "overlap-agent");
    const dockerfileDir = path.join(rootDir, "custom-image");
    const dockerfilePath = path.join(dockerfileDir, "Dockerfile");
    const denyPolicyPath = path.join(rootDir, "deny-policy.yaml");
    const allowPolicyPath = path.join(rootDir, "allow-policy.yaml");
    const scopeSuffix = `${process.pid}-${Date.now()}`;
    const scopeKey = `session:openshell-e2e-deny:${scopeSuffix}`;
    const testRunId = `${process.pid.toString(36)}${Date.now().toString(36)}`;
    const openShellWorkspace = `oc-w-${testRunId.slice(-14)}`;
    let hostPolicyServer: Awaited<ReturnType<typeof startHostPolicyServer>> | undefined;
    let mirrorSocketServer: net.Server | undefined;
    let workspaceCreated = false;
    const defaults = createOpenShellBackendSandboxConfig();
    const sandboxCfg = {
      ...defaults,
      workspaceRoot: path.join(rootDir, "sandboxes"),
      docker: {
        ...defaults.docker,
        readOnlyRoot: true,
        tmpfs: ["/tmp"],
        capDrop: ["ALL"],
      },
      tools: { allow: [], deny: [] },
    };

    const pluginConfig = resolveOpenShellPluginConfig({
      command: OPENCLAW_OPENSHELL_COMMAND,
      gateway: gatewayName,
      workspace: openShellWorkspace,
      from: dockerfilePath,
      mode: "remote",
      autoProviders: false,
      policy: denyPolicyPath,
    });
    const createBackend = (
      key: string,
      localDir: string,
      config = pluginConfig,
      agentWorkspaceDir = localDir,
      cfg: CreateSandboxBackendParams["cfg"] = sandboxCfg,
    ) =>
      createOpenShellSandboxBackendFactory({ pluginConfig: config })({
        sessionKey: key,
        scopeKey: key,
        workspaceDir: localDir,
        agentWorkspaceDir,
        cfg,
      });
    const backend = await createBackend(scopeKey, workspaceDir);
    const mirrorPluginConfig = {
      ...pluginConfig,
      mode: "mirror" as const,
      remoteWorkspaceDir: "/sandbox/project",
      remoteAgentWorkspaceDir: "/sandbox/agent",
    };
    const mirrorKey = `session:openshell-e2e-mirror:${scopeSuffix}`;
    const mirrorBackend = await createBackend(mirrorKey, mirrorWorkspaceDir, mirrorPluginConfig);
    const overlapBackend = await createBackend(
      `session:openshell-e2e-overlap:${scopeSuffix}`,
      overlapWorkspaceDir,
      {
        ...mirrorPluginConfig,
        remoteWorkspaceDir: "/sandbox/agent/project",
      },
      overlapAgentWorkspaceDir,
      { ...sandboxCfg, workspaceAccess: "ro" },
    );
    const allowBackend = await createBackend(
      `session:openshell-e2e-allow:${scopeSuffix}`,
      workspaceDir,
      { ...pluginConfig, policy: allowPolicyPath },
    );

    const failures: unknown[] = [];
    try {
      for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
        vi.stubEnv(key, env[key]);
      }
      hostPolicyServer = await startHostPolicyServer(gatewayName);
      for (const directory of [
        workspaceDir,
        mirrorWorkspaceDir,
        overlapWorkspaceDir,
        overlapAgentWorkspaceDir,
        dockerfileDir,
      ]) {
        await fs.mkdir(directory, { recursive: true });
      }
      const isolatedConfigHome = env.XDG_CONFIG_HOME;
      if (!isolatedConfigHome) {
        throw new Error("OpenShell E2E could not create an isolated XDG config home");
      }
      await fs.mkdir(isolatedConfigHome, { recursive: true });
      await fs.cp(
        path.join(openshellConfigHome, "openshell"),
        path.join(isolatedConfigHome, "openshell"),
        { recursive: true },
      );
      await runCommand({
        command: OPENCLAW_OPENSHELL_COMMAND,
        args: ["workspace", "create", "--name", openShellWorkspace],
        env,
        timeoutMs: 30_000,
      });
      workspaceCreated = true;
      await writeFile(workspaceDir, "seed.txt", "seed-from-local\n");
      await writeFile(mirrorWorkspaceDir, "mirror-seed.txt", "mirror-from-local\n");
      await writeFile(overlapWorkspaceDir, "primary-only.txt", "primary-preserved\n");
      await writeFile(overlapAgentWorkspaceDir, "agent-only.txt", "agent-preserved\n");
      for (const protectedDirectory of [".git", "hooks", "git-hooks"]) {
        const protectedPath = path.join(mirrorWorkspaceDir, protectedDirectory);
        await fs.mkdir(protectedPath, { recursive: true });
        await fs.writeFile(path.join(protectedPath, "host-only.txt"), "private\n", "utf8");
      }
      const hostLinkTarget = path.join(rootDir, "host-link-target.txt");
      await fs.writeFile(hostLinkTarget, "host-only-link-target\n");
      const hostLinks = [
        "host-link",
        "links/nested/link",
        "links/removed/link",
        "links/conflict/link",
      ];
      for (const relativePath of hostLinks) {
        const linkPath = path.join(mirrorWorkspaceDir, relativePath);
        await fs.mkdir(path.dirname(linkPath), { recursive: true });
        await fs.symlink(hostLinkTarget, linkPath);
      }
      await fs.link(hostLinkTarget, path.join(mirrorWorkspaceDir, "links", "hardlinked.txt"));
      const mirrorFifoPath = path.join(mirrorWorkspaceDir, "host.fifo");
      const mirrorSocketPath = path.join(mirrorWorkspaceDir, "host.sock");
      const mkfifoResult = await runCommand({
        command: "mkfifo",
        args: [mirrorFifoPath],
        timeoutMs: 10_000,
      });
      expect(mkfifoResult.code).toBe(0);
      const socketServer = net.createServer();
      mirrorSocketServer = socketServer;
      socketServer.listen(mirrorSocketPath);
      await once(socketServer, "listening");
      await fs.writeFile(dockerfilePath, CUSTOM_IMAGE_DOCKERFILE, "utf8");
      const policyPort = hostPolicyServer.port;
      const writePolicy = (file: string, binaryPath: string) =>
        fs.writeFile(
          file,
          buildOpenShellPolicyYaml({
            port: policyPort,
            binaryPath,
            hostIp: OPENCLAW_OPENSHELL_HOST_IP,
          }),
          "utf8",
        );
      await writePolicy(denyPolicyPath, "/usr/bin/false");
      await writePolicy(allowPolicyPath, "/usr/bin/curl");
      const execResult = await exec(
        backend,
        "pwd && cat /opt/openshell-e2e-marker.txt && cat seed.txt",
        { timeoutMs: 2 * 60_000 },
      );

      expect(execResult.code).toBe(0);
      const stdout = execResult.stdout.trim();
      expect(stdout).toContain("/sandbox");
      expect(stdout).toContain("openclaw-openshell-e2e");
      expect(stdout).toContain("seed-from-local");

      const manager = createOpenShellSandboxBackendManager({ pluginConfig });
      const registryEntry = createOpenShellRuntimeEntryFixture(
        backend.runtimeId,
        pluginConfig.from,
      );
      await expect(
        manager.describeRuntime({ entry: registryEntry, config: {} }),
      ).resolves.toMatchObject({
        running: true,
        configLabelMatch: true,
      });

      const bridge = createBridge(backend, workspaceDir);

      await bridge.writeFile({ filePath: "nested/remote-only.txt", data: "hello-remote\n" });
      const hostRead = readFile(workspaceDir, "nested/remote-only.txt");
      await expect(hostRead).rejects.toBeInstanceOf(Error);
      await expect(hostRead).rejects.toMatchObject({ code: "ENOENT" });
      await expect(bridge.readFile({ filePath: "nested/remote-only.txt" })).resolves.toEqual(
        Buffer.from("hello-remote\n"),
      );

      const verifyResult = await runCommand({
        command: OPENCLAW_OPENSHELL_COMMAND,
        args: ["--workspace", openShellWorkspace, "sandbox", "ssh-config", backend.runtimeId],
        env,
        timeoutMs: 60_000,
      });
      expect(verifyResult.code).toBe(0);
      expect(verifyResult.stdout.replace(/\r?\n$/, "")).toContain("Host ");

      const policyRequest = `curl --fail --silent --show-error --max-time 15 "http://host.openshell.internal:${hostPolicyServer.port}/policy-test"`;
      const blockedGetResult = await exec(backend, policyRequest, { allowFailure: true });
      expect(blockedGetResult.code).not.toBe(0);
      expect(`${blockedGetResult.stdout}\n${blockedGetResult.stderr}`).toMatch(/403|deny/i);

      const mirrorExecResult = await exec(
        mirrorBackend,
        "pwd && cat mirror-seed.txt && test ! -e .git && test ! -e hooks && test ! -e git-hooks",
        { timeoutMs: 2 * 60_000 },
      );
      expect(mirrorExecResult.stdout).toContain("/sandbox/project");
      expect(mirrorExecResult.stdout).toContain("mirror-from-local");
      expect((await fs.lstat(mirrorFifoPath)).isFIFO()).toBe(true);
      expect((await fs.lstat(mirrorSocketPath)).isSocket()).toBe(true);
      if (stressMode === "mirror") {
        await expectExec(
          overlapBackend,
          "cat primary-only.txt ../agent-only.txt && printf 'agent-remote\\n' > ../agent-only.txt",
          "primary-preserved\nagent-preserved\n",
          2 * 60_000,
        );
        await expectFile(overlapAgentWorkspaceDir, "agent-only.txt", "agent-preserved\n");
      }
      const expectHostLinks = async () => {
        for (const relativePath of hostLinks) {
          await expect(fs.readlink(path.join(mirrorWorkspaceDir, relativePath))).resolves.toBe(
            hostLinkTarget,
          );
        }
      };
      await expectHostLinks();
      await exec(
        mirrorBackend,
        "test ! -e host-link && test ! -L host-link && test ! -e links/nested/link && test ! -L links/nested/link && rm -rf links/removed links/conflict && printf remote-file > links/conflict && printf remote-write > links/hardlinked.txt && ln -s /etc/passwd links/remote-link",
      );
      await expectHostLinks();
      await expect(fs.readFile(hostLinkTarget, "utf8")).resolves.toBe("host-only-link-target\n");
      await expectFile(mirrorWorkspaceDir, "links/hardlinked.txt", "remote-write");
      await expect(
        fs.lstat(path.join(mirrorWorkspaceDir, "links", "remote-link")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      for (const protectedDirectory of [".git", "hooks", "git-hooks"]) {
        await expectFile(mirrorWorkspaceDir, `${protectedDirectory}/host-only.txt`, "private\n");
      }

      const mirrorBridge = createBridge(mirrorBackend, mirrorWorkspaceDir);
      await mirrorBridge.writeFile({
        filePath: "nested/mirror-note.txt",
        data: "mirror-write\n",
        mkdir: true,
      });
      await expectFile(mirrorWorkspaceDir, "nested/mirror-note.txt", "mirror-write\n");
      await expectExec(mirrorBackend, "cat nested/mirror-note.txt", "mirror-write\n");

      const allowedGetResult = await exec(allowBackend, policyRequest);
      expect(allowedGetResult.code).toBe(0);
      expect(allowedGetResult.stdout).toContain('"message":"hello-from-host"');

      const overlappingExec = await prepareExec(
        mirrorBackend,
        "sleep 0.2; printf 'exec-write\\n' > overlapping-exec.txt",
      );
      const overlappingResults = await Promise.allSettled([
        mirrorBridge.writeFile({ filePath: "overlapping-file.txt", data: "file-write\n" }),
        runPreparedBackendExec({
          backend: mirrorBackend,
          execSpec: overlappingExec,
          timeoutMs: 60_000,
        }),
      ]);
      for (const result of overlappingResults) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
      await expectFile(mirrorWorkspaceDir, "overlapping-file.txt", "file-write\n");
      await expectExec(mirrorBackend, "cat overlapping-file.txt", "file-write\n");

      const mirrorTwin = await createBackend(mirrorKey, mirrorWorkspaceDir, mirrorPluginConfig);
      const remoteTwin = await createBackend(scopeKey, workspaceDir);
      if (stressMode === "remote") {
        await verifyRemoteExecOverlap({ backend, twin: remoteTwin, bridge });
      }
      const mirrorStress = stressMode === "mirror";
      await stressBackend({
        backends: mirrorStress ? [mirrorBackend, mirrorTwin] : [backend, remoteTwin],
        bridge: mirrorStress ? mirrorBridge : bridge,
        mode: stressMode,
        workspaceDir: mirrorStress ? mirrorWorkspaceDir : workspaceDir,
      });

      for (const [candidate, candidateBridge] of [
        [mirrorBackend, mirrorBridge],
        [backend, bridge],
      ] as const) {
        await expect(exec(candidate, "exit 23")).rejects.toThrow("exit: 23");
        await candidateBridge.writeFile({ filePath: "after-failed-exec.txt", data: "recovered" });
        await expectExec(candidate, "cat after-failed-exec.txt", "recovered");
        await expect(prepareExec(candidate, "true", { "INVALID-NAME": "fixture" })).rejects.toThrow(
          "Invalid sandbox environment variable name",
        );
        await expect(
          candidate.validateWorkdir?.(`${candidate.workdir}/missing-directory`),
        ).resolves.toBeNull();
        await expect(candidate.validateWorkdir?.(candidate.workdir)).resolves.toBe(
          candidate.workdir,
        );
        const unspawned = await prepareExec(candidate, "exit 99");
        await failExec(candidate, unspawned.finalizeToken);
        const sshConfigPath = unspawned.argv[unspawned.argv.indexOf("-F") + 1];
        expect(sshConfigPath).toBeTruthy();
        await expect(fs.stat(sshConfigPath!)).rejects.toMatchObject({ code: "ENOENT" });
        await expectExec(
          candidate,
          "test -z \"$(find /tmp -maxdepth 1 -name 'openclaw-sandbox-exec-*' -print)\" && printf recovered",
          "recovered",
        );
      }

      const held = await prepareExec(mirrorBackend, "true");
      try {
        await expectExec(backend, "printf independent", "independent", 60_000);
      } finally {
        await failExec(mirrorBackend, held.finalizeToken);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      for (const cleanup of [
        async () => {
          if (workspaceCreated) {
            await cleanupOpenShellWorkspace({
              command: OPENCLAW_OPENSHELL_COMMAND,
              env,
              workspace: openShellWorkspace,
              sandboxNames: [backend, mirrorBackend, overlapBackend, allowBackend].map(
                (b) => b.runtimeId,
              ),
            });
          }
        },
        async () => {
          const socketServer = mirrorSocketServer;
          if (socketServer) {
            await closeServer(socketServer);
          }
        },
        () => hostPolicyServer?.close(),
        () => fs.rm(rootDir, { recursive: true, force: true }),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      vi.unstubAllEnvs();
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "OpenShell E2E or cleanup failed");
    }
  },
);
