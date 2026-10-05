import { once } from "node:events";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setManagedCodexPluginRoot } from "./app-server/managed-binary.js";
import {
  createCodexNodeAppServerInvokePolicy,
  createCodexNodeExecServerCommand,
  createCodexNodeExecServerInvokePolicy,
} from "./node-exec-server.js";
import {
  createManagedWorkspaceInvocation,
  createNodeFrames,
  readNodeResponse,
  readNodeProcessNotifications,
} from "./node-exec-server.test-support.js";

const CODEX_NODE_EXEC_SERVER_COMMAND = "codex.exec-server.stdio.v1";

let pendingNodeProof: Promise<void> | undefined;
beforeEach(() => {
  setManagedCodexPluginRoot(fileURLToPath(new URL("../", import.meta.url)));
});

afterEach(async () => {
  // A timed-out test aborts its signal; join native cleanup before restoring
  // the shared environment or allowing the next test to start another child.
  await pendingNodeProof?.catch(() => {});
  pendingNodeProof = undefined;
  setManagedCodexPluginRoot(undefined);
  vi.unstubAllEnvs();
});

describe("Codex node exec-server", () => {
  it("uses admitted Full launch authority without asking for a human decision", async () => {
    const { placement } = createManagedWorkspaceInvocation(process.cwd());
    const request = vi.fn(async () => ({ decision: "deny" as const }));
    const invokeNode = vi.fn();
    const invokeNodeWithSessionFull = vi.fn(async () => ({ ok: true as const }));
    await expect(
      createCodexNodeExecServerInvokePolicy().handle({
        nodeId: "paired-node",
        command: CODEX_NODE_EXEC_SERVER_COMMAND,
        params: placement,
        config: {},
        risk: { level: "high", family: "codex.exec-server" },
        approvals: { request },
        invokeNode,
        invokeNodeWithSessionFull,
      }),
    ).resolves.toEqual({ ok: true });
    expect(request).not.toHaveBeenCalled();
    expect(invokeNode).not.toHaveBeenCalled();
    expect(invokeNodeWithSessionFull).toHaveBeenCalledOnce();
  });

  it("carries a validated GitHub binding only through the approved node launch", async () => {
    const { placement } = createManagedWorkspaceInvocation(process.cwd());
    const github = {
      token: "synthetic-node-installation-token",
      login: "worker-bot",
      branch: "openclaw/session-worker",
      host: "microsoft.ghe.com",
      remoteUrl: "https://microsoft.ghe.com/bic/lobster.git",
    };
    const invokeNodeWithSessionFull = vi.fn(async ({ createParams }) => ({
      ok: true as const,
      payload: createParams(),
    }));

    await expect(
      createCodexNodeExecServerInvokePolicy().handle({
        nodeId: "paired-node",
        command: CODEX_NODE_EXEC_SERVER_COMMAND,
        params: {
          ...placement,
          github,
          resourcePreparationRequired: true,
          repositoryPreparationRequired: true,
        },
        config: {},
        risk: { level: "high", family: "codex.exec-server" },
        invokeNode: vi.fn(),
        invokeNodeWithSessionFull,
      }),
    ).resolves.toEqual({
      ok: true,
      payload: {
        placement,
        authorization: "session-full",
        github,
        resourcePreparationRequired: true,
        repositoryPreparationRequired: true,
      },
    });
    await expect(
      createCodexNodeExecServerInvokePolicy().handle({
        nodeId: "paired-node",
        command: CODEX_NODE_EXEC_SERVER_COMMAND,
        params: {
          ...placement,
          github: { ...github, remoteUrl: "https://outside.test/bic/lobster.git" },
        },
        config: {},
        risk: { level: "high", family: "codex.exec-server" },
        invokeNode: vi.fn(),
        invokeNodeWithSessionFull,
      }),
    ).resolves.toMatchObject({ ok: false, code: "CODEX_NODE_EXEC_GITHUB_BINDING_INVALID" });
  });

  it("checks node-local authorization before starting the pinned process", async () => {
    const frames = createNodeFrames();
    const workspace = createManagedWorkspaceInvocation(process.cwd());
    const prepareExecAuthorization = vi.fn(() => {
      throw new Error("node-local execution denied");
    });
    const invocation = createCodexNodeExecServerCommand().handle(
      JSON.stringify({ placement: workspace.placement, authorization: "human-approved" }),
      frames.io,
      { ...workspace.context, prepareExecAuthorization },
    );
    void invocation.catch(() => {});
    try {
      await expect(Promise.race([frames.ready, invocation])).rejects.toThrow(
        "node-local execution denied",
      );
      expect(prepareExecAuthorization).toHaveBeenCalledOnce();
    } finally {
      frames.controller.abort(new Error("policy fixture closed"));
      await invocation.catch(() => {});
    }
  });

  it("rejects forged launch authorization at the public policy boundary", async () => {
    const { placement } = createManagedWorkspaceInvocation(process.cwd());
    const request = vi.fn();
    const invokeNode = vi.fn();
    const invokeNodeWithSessionFull = vi.fn();
    for (const params of [
      { ...placement, authorization: "session-full" },
      { placement, authorization: "human-approved" },
      { placement, authorization: "session-full" },
    ]) {
      await expect(
        createCodexNodeExecServerInvokePolicy().handle({
          nodeId: "paired-node",
          command: CODEX_NODE_EXEC_SERVER_COMMAND,
          params,
          config: {},
          risk: { level: "high", family: "codex.exec-server" },
          approvals: { request },
          invokeNode,
          invokeNodeWithSessionFull,
        }),
      ).resolves.toMatchObject({ ok: false, code: "CODEX_NODE_EXEC_WORKSPACE_INVALID" });
    }
    expect(request).not.toHaveBeenCalled();
    expect(invokeNode).not.toHaveBeenCalled();
    expect(invokeNodeWithSessionFull).not.toHaveBeenCalled();
  });

  it("revalidates local policy after awaited binary setup and fails closed without node support", async () => {
    const transport = await import("./app-server/transport-stdio.js");
    const spawn = vi.spyOn(transport, "createStdioTransport");
    const workspace = createManagedWorkspaceInvocation(process.cwd());
    const frames = createNodeFrames();
    const encoded = JSON.stringify({
      placement: workspace.placement,
      authorization: "session-full",
    });
    const assertCurrent = vi.fn(() => {
      throw new Error("node policy tightened");
    });
    try {
      await expect(
        createCodexNodeExecServerCommand().handle(encoded, frames.io, {
          ...workspace.context,
          prepareExecAuthorization: () => assertCurrent,
        }),
      ).rejects.toThrow("node policy tightened");
      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      const acquire = workspace.context.acquireManagedWorkspaceAsync;
      const revokedEnvironment = {
        assertCurrent: () => {
          throw new Error("workspace provider custody revoked");
        },
        prepare: vi.fn((env: NodeJS.ProcessEnv) => env),
        redactOutput: (text: string) => text,
      };
      await expect(
        createCodexNodeExecServerCommand().handle(encoded, frames.io, {
          ...workspace.context,
          acquireManagedWorkspaceAsync: async (request) => ({
            ...(await acquire(request)),
            processEnvironment: revokedEnvironment,
          }),
        }),
      ).rejects.toThrow("workspace provider custody revoked");
      expect(revokedEnvironment.prepare).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      await expect(
        createCodexNodeExecServerCommand().handle(encoded, frames.io, {
          ...workspace.context,
          prepareExecAuthorization: undefined,
        }),
      ).rejects.toThrow("update the node");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  it("requires critical scoped approval on the node placement", async () => {
    const nodeId = "paired-node";
    const policy = createCodexNodeExecServerInvokePolicy();
    expect(policy.commands).toEqual([CODEX_NODE_EXEC_SERVER_COMMAND]);
    expect(policy.dangerous).toBe(true);
    expect(policy.standingApproval).toEqual({ kind: "placement", scope: "codex.exec-server" });
    expect(policy.defaultPlatforms).toBeUndefined();
    expect(policy.classifyRisk?.({ command: CODEX_NODE_EXEC_SERVER_COMMAND, params: {} })).toEqual({
      level: "high",
      family: "codex.exec-server",
    });

    const invokeNode = vi.fn(async () => ({ ok: true as const, payload: { connected: true } }));
    const request = vi.fn();
    const { placement } = createManagedWorkspaceInvocation(
      path.join(process.cwd(), "long-session-workspace-".repeat(20)),
    );
    const context = {
      nodeId,
      command: CODEX_NODE_EXEC_SERVER_COMMAND,
      params: placement,
      config: {},
      risk: { level: "high", family: "codex.exec-server" },
      approvals: { request },
      invokeNode,
    } satisfies OpenClawPluginNodeInvokePolicyContext;

    for (const { decision, result } of [
      {
        decision: "deny",
        result: {
          ok: false,
          code: "CODEX_NODE_EXEC_APPROVAL_DENIED",
          message:
            "Codex node execution was denied. Retry the action and choose Allow once or Allow always to continue.",
        },
      },
      {
        decision: null,
        result: {
          ok: false,
          code: "CODEX_NODE_EXEC_APPROVAL_EXPIRED",
          message:
            "Codex node execution approval expired before a decision. Retry the action and approve the new request.",
        },
      },
    ] as const) {
      request.mockResolvedValueOnce({ decision });
      await expect(policy.handle(context)).resolves.toEqual(result);
      expect(invokeNode).not.toHaveBeenCalled();
    }
    await expect(policy.handle({ ...context, approvals: undefined })).resolves.toMatchObject({
      ok: false,
      code: "CODEX_NODE_EXEC_APPROVAL_REQUIRED",
    });
    expect(invokeNode).not.toHaveBeenCalled();

    await expect(
      policy.handle({ ...context, params: { cwd: process.cwd() } }),
    ).resolves.toMatchObject({
      ok: false,
      code: "CODEX_NODE_EXEC_WORKSPACE_INVALID",
    });
    expect(invokeNode).not.toHaveBeenCalled();

    request.mockResolvedValueOnce({ decision: "allow-always" });
    await expect(policy.handle(context)).resolves.toEqual({
      ok: true,
      payload: { connected: true },
    });
    expect(invokeNode).toHaveBeenCalledOnce();
    invokeNode.mockClear();

    const approvedPlacement = { ...placement };
    request.mockImplementationOnce(async () => {
      placement.cwd = path.parse(process.cwd()).root;
      return { decision: "allow-once" };
    });
    await expect(policy.handle(context)).resolves.toEqual({
      ok: true,
      payload: { connected: true },
    });
    expect(invokeNode).toHaveBeenCalledOnce();
    expect(invokeNode).toHaveBeenCalledWith({
      workspace: {
        workspaceDir: approvedPlacement.cwd,
        environmentId: approvedPlacement.environmentId,
        sessionId: approvedPlacement.sessionId,
        ownerEpoch: approvedPlacement.ownerEpoch,
        sessionKey: approvedPlacement.sessionKey,
      },
      params: { placement: approvedPlacement, authorization: "human-approved" },
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Run Codex on this node placement",
        description: expect.stringContaining(`${nodeId}: ${approvedPlacement.cwd}`),
        severity: "critical",
        allowedDecisions: ["allow-once", "allow-always"],
      }),
    );
    // Gateway approval descriptions are bounded to 256 characters.
    expect(request.mock.lastCall?.[0].description.slice(0, 256)).toContain(
      "arbitrary processes and filesystem access across the node account, not only this workspace",
    );
    expect(request.mock.lastCall?.[0].description.slice(0, 256)).toContain(
      "Allow always applies only while this exact placement remains active",
    );
  });

  it("dispatches the worker app-server through its exact Full placement owner", async () => {
    const policy = createCodexNodeAppServerInvokePolicy();
    const { placement } = createManagedWorkspaceInvocation(process.cwd());
    const github = {
      token: "synthetic-node-installation-token",
      login: "worker-bot",
      branch: "openclaw/session-worker",
      host: "microsoft.ghe.com",
      remoteUrl: "https://microsoft.ghe.com/bic/lobster.git",
    };
    const dispatched = { ok: true as const, payload: { started: true } };
    const invokeNode = vi.fn(async () => dispatched);
    const invokeNodeWithSessionFull: NonNullable<
      OpenClawPluginNodeInvokePolicyContext["invokeNodeWithSessionFull"]
    > = vi.fn(async ({ workspace, createParams }) => {
      expect(workspace).toEqual({
        workspaceDir: placement.cwd,
        environmentId: placement.environmentId,
        sessionId: placement.sessionId,
        ownerEpoch: placement.ownerEpoch,
        sessionKey: placement.sessionKey,
      });
      expect(createParams()).toEqual({
        placement,
        authorization: "session-full",
        github,
        repositoryPreparationRequired: true,
        resourcePreparationRequired: true,
      });
      return dispatched;
    });
    const context = {
      nodeId: "cloud-worker-node",
      command: policy.commands[0]!,
      params: {
        placement,
        authorization: "session-full",
        github,
        repositoryPreparationRequired: true,
        resourcePreparationRequired: true,
      },
      config: {},
      risk: { level: "high", family: "codex.app-server" },
      invokeNode,
      invokeNodeWithSessionFull,
    } satisfies OpenClawPluginNodeInvokePolicyContext;

    await expect(policy.handle(context)).resolves.toEqual(dispatched);
    expect(invokeNodeWithSessionFull).toHaveBeenCalledOnce();
    expect(invokeNode).not.toHaveBeenCalled();

    await expect(
      policy.handle({ ...context, invokeNodeWithSessionFull: undefined }),
    ).resolves.toMatchObject({ ok: false, code: "CODEX_NODE_APP_SERVER_APPROVAL_REQUIRED" });
    await expect(
      policy.handle({
        ...context,
        params: { placement: { cwd: placement.cwd }, authorization: "session-full" },
      }),
    ).resolves.toMatchObject({ ok: false, code: "CODEX_NODE_APP_SERVER_WORKSPACE_INVALID" });
    await expect(
      policy.handle({
        ...context,
        params: { placement, authorization: "session-full", github: {} },
      }),
    ).resolves.toMatchObject({ ok: false, code: "CODEX_NODE_APP_SERVER_GITHUB_BINDING_INVALID" });
    expect(invokeNodeWithSessionFull).toHaveBeenCalledOnce();
  });

  it("rejects unmanaged placement identities before launch and malformed or oversized frames", async () => {
    const command = createCodexNodeExecServerCommand();
    const frames = createNodeFrames();
    const workspace = createManagedWorkspaceInvocation(process.cwd());
    const encodedPlacement = JSON.stringify({
      placement: workspace.placement,
      authorization: "human-approved",
    });
    await expect(command.handle(encodedPlacement)).rejects.toThrow("requires duplex frames");
    await expect(
      command.handle(
        JSON.stringify({ ...workspace.placement, env: { TOKEN: "canary" } }),
        frames.io,
        workspace.context,
      ),
    ).rejects.toThrow("managed placement workspace");
    await expect(command.handle(encodedPlacement, frames.io)).rejects.toThrow(
      "active managed placement authority",
    );
    await expect(
      command.handle(encodedPlacement, frames.io, {
        ...workspace.context,
        sessionKey: "agent:main:different-session",
      }),
    ).rejects.toThrow("active managed placement authority");
    expect(workspace.acquireManagedWorkspaceAsync).not.toHaveBeenCalled();
    for (const replacement of [
      { cwd: path.parse(process.cwd()).root },
      { environmentId: "other-environment" },
      { sessionId: "other-session" },
      { ownerEpoch: 2 },
    ]) {
      await expect(
        command.handle(
          JSON.stringify({
            placement: { ...workspace.placement, ...replacement },
            authorization: "human-approved",
          }),
          frames.io,
          workspace.context,
        ),
      ).rejects.toThrow("node placement does not own the requested workspace");
    }
    expect(workspace.release).not.toHaveBeenCalled();

    const invocation = command.handle(encodedPlacement, frames.io, workspace.context);
    void invocation.catch(() => {});
    await Promise.race([frames.ready, invocation]);
    await expect(frames.sendRaw(Buffer.from('{"id":1}\n{"id":2}'))).rejects.toThrow(
      "exactly one message",
    );
    await expect(frames.sendRaw(Uint8Array.of(0xff, 0xfe))).rejects.toThrow("malformed UTF-8");
    const oversized = new Uint8Array(64 * 1024 * 1024 + 1);
    oversized[0] = 0x7b;
    await expect(frames.sendRaw(oversized)).rejects.toThrow("64 MiB");
    frames.controller.abort(new Error("malformed-frame fixture closed"));
    await expect(invocation).rejects.toThrow("malformed-frame fixture closed");
    expect(workspace.release).toHaveBeenCalledOnce();
    expect(command.hasActiveWork?.() ?? false).toBe(false);
  });

  it.for(["all", "none"] as const)(
    "uses prepared HOME and trusted Bash transport with inherit:%s while keeping Codex state private",
    async (inherit, { signal }) => {
      pendingNodeProof = withTempWorkspace(
        { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "codex-prepared-home-" },
        async ({ dir }) => {
          const cwd = await realpath(dir);
          const homeDir = path.join(cwd, "prepared-home");
          await mkdir(homeDir);
          await writeFile(path.join(homeDir, "prepared-cache"), "retained build state");
          const frames = createNodeFrames(signal);
          const command = createCodexNodeExecServerCommand();
          const workspace = createManagedWorkspaceInvocation(cwd, homeDir);
          const endpoint = "http://127.0.0.1:43210/synthetic-identity";
          const header = "synthetic-exec-identity-header";
          const acquire = workspace.context.acquireManagedWorkspaceAsync;
          workspace.context.acquireManagedWorkspaceAsync = async (request) => ({
            ...(await acquire(request)),
            processEnvironment: {
              assertCurrent: () => frames.io.signal.throwIfAborted(),
              prepare: (env: NodeJS.ProcessEnv) => ({
                ...env,
                IDENTITY_ENDPOINT: endpoint,
                IDENTITY_HEADER: header,
              }),
              redactOutput: (text: string) => text.replaceAll(header, "[REDACTED]"),
            },
          });
          const bashEnv = path.join(cwd, "worker-env.sh");
          await writeFile(
            bashEnv,
            '[ -n "$IDENTITY_ENDPOINT" ] && [ -n "$IDENTITY_HEADER" ] || exit 71\n',
          );
          const github = {
            token: "synthetic-node-installation-token",
            login: "worker-bot",
            branch: "openclaw/session-worker",
            host: "microsoft.ghe.com",
            remoteUrl: "https://microsoft.ghe.com/bic/lobster.git",
          };
          const invocation = command.handle(
            JSON.stringify({
              placement: workspace.placement,
              authorization: "human-approved",
              github,
            }),
            frames.io,
            workspace.context,
          );
          void invocation.catch((error: unknown) => frames.controller.abort(error));
          let isolatedCodexHome: string | undefined;
          let isolatedGitHubProfile: string | undefined;
          try {
            await Promise.race([frames.ready, invocation]);
            await frames.send({
              id: 1,
              method: "initialize",
              params: { clientName: "openclaw-node" },
            });
            await readNodeResponse(frames, 1);
            await frames.send({ method: "initialized", params: {} });
            const script = `const fs = require('node:fs'); const path = require('node:path');
const observation = {home: process.env.HOME, codexHome: process.env.CODEX_HOME,
  githubProfile: process.env.GH_CONFIG_DIR, githubHost: process.env.GH_HOST,
  githubTokenEmpty: process.env.GH_TOKEN === '', enterpriseTokenEmpty: process.env.GH_ENTERPRISE_TOKEN === '',
  cached: fs.existsSync(path.join(process.env.HOME ?? '.', 'prepared-cache'))};
process.stdout.write(Buffer.concat([Buffer.from([255]), Buffer.from(JSON.stringify(observation) + '\\n')]));`;
            const shellProbe = `test -n "$IDENTITY_ENDPOINT" && test -n "$IDENTITY_HEADER" || exit 72; exec "$1" -e "$2"`;
            await frames.send({
              id: 2,
              method: "process/start",
              params: {
                processId: "prepared-home",
                argv: [
                  "/bin/bash",
                  "-c",
                  shellProbe,
                  "probe",
                  process.execPath,
                  script.replace(
                    "cached:",
                    `identityMatches: process.env.IDENTITY_ENDPOINT === ${JSON.stringify(endpoint)} && process.env.IDENTITY_HEADER === ${JSON.stringify(header)}, headerEcho: process.env.IDENTITY_HEADER, cached:`,
                  ),
                ],
                cwd: pathToFileURL(cwd).href,
                env: {
                  BASH_ENV: bashEnv,
                  IDENTITY_ENDPOINT: "http://caller.invalid/identity",
                  IDENTITY_HEADER: "synthetic-forged-header",
                  GH_CONFIG_DIR: "/synthetic-other-profile",
                  GH_HOST: "other-host.example",
                  GH_TOKEN: "synthetic-caller-token",
                  GH_ENTERPRISE_TOKEN: "synthetic-caller-enterprise-token",
                },
                envPolicy: {
                  inherit,
                  ignoreDefaultExcludes: true,
                  exclude: [],
                  set: {},
                  includeOnly: ["HOME", "CODEX_HOME"],
                },
                tty: false,
                pipeStdin: false,
                arg0: null,
              },
            });
            await readNodeResponse(frames, 2);
            const notifications = await readNodeProcessNotifications(frames, "prepared-home", 3);
            const output = notifications.find(
              (message) => message.method === "process/output",
            )?.params;
            if (!isRecord(output) || typeof output.chunk !== "string") {
              throw new Error("Pinned exec-server omitted process output");
            }
            const observed: unknown = JSON.parse(
              Buffer.from(output.chunk, "base64").subarray(1).toString("utf8"),
            );
            expect(Buffer.from(output.chunk, "base64")[0]).toBe(255);
            expect(observed).toMatchObject({
              ...(inherit === "all" ? { home: homeDir, cached: true } : { cached: false }),
              identityMatches: true,
              headerEcho: "[REDACTED]",
              githubHost: "microsoft.ghe.com",
              githubTokenEmpty: true,
              enterpriseTokenEmpty: true,
            });
            if (
              !isRecord(observed) ||
              (inherit === "all" && typeof observed.codexHome !== "string")
            ) {
              throw new Error("Pinned exec-server omitted its private Codex home");
            }
            if (typeof observed.githubProfile !== "string") {
              throw new Error("Pinned exec-server omitted its private GitHub profile");
            }
            isolatedGitHubProfile = observed.githubProfile;
            const hosts = await readFile(path.join(isolatedGitHubProfile, "hosts.yml"), "utf8");
            expect(hosts).toContain(github.host);
            expect(hosts).toContain(github.token);
            isolatedCodexHome =
              typeof observed.codexHome === "string" ? observed.codexHome : undefined;
            expect(isolatedCodexHome).not.toBe(path.join(homeDir, ".codex"));
          } finally {
            frames.controller.abort(new Error("prepared-home proof completed"));
            await expect(invocation).rejects.toBe(frames.io.signal.reason);
            await command.onDisconnect?.();
            expect(workspace.release).toHaveBeenCalledOnce();
          }
          expect(await readFile(path.join(homeDir, "prepared-cache"), "utf8")).toBe(
            "retained build state",
          );
          if (!isolatedCodexHome && inherit === "all") {
            throw new Error("Private Codex home was not observed");
          }
          if (isolatedCodexHome) {
            await expect(access(isolatedCodexHome)).rejects.toMatchObject({ code: "ENOENT" });
          }
          if (!isolatedGitHubProfile) {
            throw new Error("Private GitHub profile was not observed");
          }
          await expect(access(isolatedGitHubProfile)).rejects.toMatchObject({ code: "ENOENT" });
        },
      );
      await pendingNodeProof;
    },
  );

  it("relays the actual pinned Codex binary, isolates credentials, and removes its private home", async (context) => {
    const { signal } = context;
    vi.stubEnv("OPENAI_API_KEY", "node-provider-canary");
    vi.stubEnv("IDENTITY_ENDPOINT", "http://unadmitted.invalid/identity");
    vi.stubEnv("IDENTITY_HEADER", "synthetic-unadmitted-identity-header");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "node-cloud-canary");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/node-cloud-canary.json");
    vi.stubEnv("GITHUB_TOKEN", "node-forge-canary");
    vi.stubEnv("SSH_AUTH_SOCK", "/node-ssh-canary.sock");
    vi.stubEnv("NODE_OPTIONS", "--no-warnings");

    pendingNodeProof = withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "codex-node-exec-contract-" },
      async ({ dir }) => {
        const cwd = await realpath(dir);
        const workspaceUri = pathToFileURL(cwd).href;
        const frames = createNodeFrames(signal);
        const command = createCodexNodeExecServerCommand();
        const workspace = createManagedWorkspaceInvocation(cwd);
        const invocation = command.handle(
          JSON.stringify({ placement: workspace.placement, authorization: "human-approved" }),
          frames.io,
          workspace.context,
        );
        void invocation.then(
          () => frames.controller.abort(new Error("Codex exec-server invocation ended")),
          (error: unknown) => frames.controller.abort(error),
        );
        let isolatedHome: string | undefined;
        const outputGate = createServer((_request, response) => {
          void frames
            .waitForMessage(
              (message) =>
                message.method === "process/exited" &&
                (message.params as { processId?: string }).processId === "node-proof",
            )
            .then(
              () => response.end(),
              () => response.destroy(),
            );
        });

        try {
          outputGate.listen(0, "127.0.0.1");
          await once(outputGate, "listening");
          const gateAddress = outputGate.address();
          if (!gateAddress || typeof gateAddress === "string") {
            throw new Error("Late-output fixture did not bind a TCP port.");
          }
          const lateOutputScript = `require('node:http').get(
            'http://127.0.0.1:${gateAddress.port}/', response => {
              response.resume();
              response.once('end', () => process.stdout.write(process.argv[1] + '\\n'));
            });`;
          await Promise.race([frames.ready, invocation]);
          // Codex deliberately omits jsonrpc:"2.0" from every wire envelope.
          await frames.send({
            id: 1,
            method: "initialize",
            params: { clientName: "openclaw-node" },
          });
          expect(await readNodeResponse(frames, 1)).toMatchObject({
            sessionId: expect.any(String),
          });
          await frames.send({ method: "initialized", params: {} });

          const script = [
            "process.stdin.once('data', input => {",
            "const output = JSON.stringify({",
            "input: input.toString().trim(),",
            "ordinary: process.env.NODE_EXEC_ORDINARY ?? null,",
            "home: process.env.HOME ?? null,",
            "codexHome: process.env.CODEX_HOME ?? null,",
            "userProfile: process.env.USERPROFILE ?? null,",
            "provider: process.env.OPENAI_API_KEY ?? null,",
            "identityPresent: Boolean(process.env.IDENTITY_ENDPOINT || process.env.IDENTITY_HEADER),",
            "cloud: process.env.AWS_ACCESS_KEY_ID ?? null,",
            "cloudFile: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null,",
            "forge: process.env.GITHUB_TOKEN ?? null,",
            "ssh: process.env.SSH_AUTH_SOCK ?? null,",
            "injection: process.env.NODE_OPTIONS ?? null",
            "})",
            // Keep the inherited output pipes open until the test observes the parent's exit.
            `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(lateOutputScript)}, output],`,
            "{ stdio: ['ignore', 'inherit', 'inherit'] }).once('spawn', () => process.exit(0))",
            "})",
          ].join("\n");
          await frames.send({
            id: 8,
            method: "process/start",
            params: {
              processId: "node-proof",
              argv: [process.execPath, "-e", script],
              cwd: workspaceUri,
              env: { NODE_EXEC_ORDINARY: "visible" },
              envPolicy: {
                inherit: "all",
                ignoreDefaultExcludes: true,
                exclude: [],
                set: {},
                includeOnly: [],
              },
              tty: false,
              pipeStdin: true,
              arg0: null,
            },
          });
          expect(await readNodeResponse(frames, 8)).toMatchObject({ processId: "node-proof" });
          await frames.send({
            id: 9,
            method: "process/write",
            params: {
              processId: "node-proof",
              chunk: Buffer.from("node carrier\n").toString("base64"),
              writeId: "node-proof-write",
            },
          });
          await readNodeResponse(frames, 9);
          const notifications = await readNodeProcessNotifications(frames, "node-proof", 3);
          // Codex drains output independently of exit; only closed is terminal in seq order.
          expect(
            notifications
              .map((message) => message.method)
              .toSorted((left, right) => String(left).localeCompare(String(right))),
          ).toEqual(["process/closed", "process/exited", "process/output"]);
          expect(
            notifications.find((message) => message.method === "process/exited"),
          ).toMatchObject({
            params: { exitCode: 0, sandboxDenied: false },
          });
          const output = notifications.find((message) => message.method === "process/output")
            ?.params as { chunk: string };
          const observed = JSON.parse(Buffer.from(output.chunk, "base64").toString("utf8")) as {
            input: string;
            ordinary: string;
            home: string;
            codexHome: string;
            userProfile: string | null;
            provider: string | null;
            cloud: string | null;
            cloudFile: string | null;
            forge: string | null;
            ssh: string | null;
            injection: string | null;
          };
          expect(observed).toMatchObject({
            input: "node carrier",
            ordinary: "visible",
            provider: null,
            identityPresent: false,
            cloud: null,
            cloudFile: null,
            forge: null,
            ssh: null,
            injection: null,
          });
          expect(observed.codexHome).toBe(path.join(observed.home, ".codex"));
          expect(observed.home).not.toBe(process.env.HOME);
          if (process.platform === "win32") {
            expect(observed.userProfile).toBe(observed.home);
          }
          isolatedHome = observed.home;

          // A response spanning many pipe chunks must arrive as one intact frame.
          const chunkedUri = pathToFileURL(path.join(cwd, "chunked.txt")).href;
          const chunkedDataBase64 = Buffer.alloc(256 * 1024, 0x61).toString("base64");
          await frames.send({
            id: 10,
            method: "fs/writeFile",
            params: { path: chunkedUri, dataBase64: chunkedDataBase64, sandbox: null },
          });
          expect(await readNodeResponse(frames, 10)).toEqual({});
          await frames.send({
            id: 11,
            method: "fs/readFile",
            params: { path: chunkedUri, sandbox: null },
          });
          expect(await readNodeResponse(frames, 11)).toEqual({ dataBase64: chunkedDataBase64 });

          const policyScript = [
            "const net = require('node:net')",
            "const proxy = new URL(process.env.HTTP_PROXY)",
            "const socket = net.connect(Number(proxy.port), proxy.hostname, () => {",
            "socket.write('CONNECT 8.8.8.8:443 HTTP/1.1\\r\\nHost: 8.8.8.8:443\\r\\n\\r\\n')",
            "})",
            "socket.once('data', chunk => {",
            "const line = chunk.toString().split('\\r\\n')[0]",
            "process.stdout.write(line + '\\n', () => { socket.end(); process.exit(0) })",
            "})",
          ].join("\n");
          await frames.send({
            id: 20,
            method: "process/start",
            params: {
              processId: "node-policy",
              argv: [process.execPath, "-e", policyScript],
              cwd: workspaceUri,
              env: {},
              tty: false,
              pipeStdin: false,
              arg0: null,
              networkProxy: {
                proxy: {
                  enabled: true,
                  enableSocks5: false,
                  enableSocks5Udp: false,
                  allowUpstreamProxy: false,
                  dangerouslyAllowAllUnixSockets: false,
                  mode: "full",
                  domains: null,
                  unixSockets: null,
                  allowLocalBinding: false,
                },
                environmentId: "node-policy-environment",
                executionId: "node-policy-execution",
                policyDecisionTimeoutMs: 3_000,
              },
            },
          });
          expect(await readNodeResponse(frames, 20)).toMatchObject({ processId: "node-policy" });
          const policyRequest = await frames.waitForMessage(
            (message) => message.method === "network/policyRequest",
          );
          expect(policyRequest).toMatchObject({
            id: expect.any(Number),
            params: {
              processId: "node-policy",
              request: { protocol: "https_connect", host: "8.8.8.8", port: 443 },
            },
          });
          await frames.send({
            id: policyRequest.id,
            result: { decision: { type: "deny", reason: "node-policy-proof" } },
          });
          await frames.waitForMessage(
            (message) =>
              message.method === "process/closed" &&
              (message.params as { processId?: string }).processId === "node-policy",
          );
          expect(frames.outbound).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ method: "network/policyDecision" }),
              expect.objectContaining({
                method: "process/output",
                params: expect.objectContaining({
                  processId: "node-policy",
                  chunk: Buffer.from("HTTP/1.1 403 Forbidden\n").toString("base64"),
                }),
              }),
            ]),
          );
          const pendingResponse = readNodeResponse(frames, 21);
          const closed = new Error("paired-device attempt completed");
          frames.controller.abort(closed);
          await expect(pendingResponse).rejects.toMatchObject({
            name: "AbortError",
            cause: closed,
          });
        } finally {
          outputGate.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            outputGate.close((error) => (error ? reject(error) : resolve()));
          });
          frames.controller.abort(new Error("paired-device attempt completed"));
          await expect(invocation).rejects.toBe(frames.io.signal.reason);
          await command.onDisconnect?.();
          expect(workspace.release).toHaveBeenCalledOnce();
        }

        expect(isolatedHome).toEqual(expect.any(String));
        await expect(access(isolatedHome!)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
    await pendingNodeProof;
  });
});
