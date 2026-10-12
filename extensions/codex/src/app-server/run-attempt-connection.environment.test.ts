import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { codexAppServerStartOptionsKey } from "./config-options.js";
import { isJsonObject } from "./protocol.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import {
  createParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  testCodexAppServerBindingStore,
  registerCodexTestSessionIdentity,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  createThreadRequestAppServerOptions,
  createThreadRequestAttemptParams,
  startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";
import { buildThreadResumeParams, buildThreadStartParams } from "./thread-requests.js";

setupRunAttemptTestHooks();

describe("Codex local tool environment placement", () => {
  it.each([
    { requestPath: undefined, gitOnly: false },
    { requestPath: "/request/bin", gitOnly: false },
    { requestPath: undefined, gitOnly: true },
  ])(
    "preserves native shell policy with request PATH $requestPath and gitOnly=$gitOnly",
    async ({ requestPath, gitOnly }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method: string) => {
          if (method === "config/read") {
            return {
              config: {
                shell_environment_policy: {
                  inherit: "none",
                  set: {
                    PATH: "/native/bin",
                    KEEP: "yes",
                    ...(gitOnly ? { GIT_CONFIG_PARAMETERS: "'user.name=Native'" } : {}),
                  },
                },
              },
              origins: {},
              layers: [],
            };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "thread/start") {
            return threadStartResult("thread-1");
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.config = undefined;
      registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
      await startOrResumeThread({
        client: fixture.client,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: {
          ...createAppServerOptions(),
          connectionClass: "local-loopback",
        },
        ...(gitOnly
          ? {
              shellGitConfigParameters: "'maintenance.auto=false' 'gc.auto=0'",
            }
          : {
              shellEnvironment: { PATH: "/tools:/gateway/bin" },
              shellPathPrepend: ["/tools"],
              disableLoginShell: true,
            }),
        config:
          requestPath === undefined
            ? undefined
            : { "shell_environment_policy.set.PATH": requestPath },
      });
      expect(
        fixture.request.mock.calls.find(([method]) => method === "thread/start")?.[1],
      ).toMatchObject({
        config: {
          ...(!gitOnly ? { allow_login_shell: false } : {}),
          shell_environment_policy: {
            inherit: "none",
            set: {
              PATH: gitOnly
                ? "/native/bin"
                : ["/tools", requestPath ?? "/native/bin"].join(path.delimiter),
              KEEP: "yes",
              ...(gitOnly
                ? {
                    GIT_CONFIG_PARAMETERS:
                      "'user.name=Native' 'maintenance.auto=false' 'gc.auto=0'",
                  }
                : {}),
            },
          },
        },
      });
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "config/read"),
      ).toHaveLength(1);
    },
  );

  it.each(["local", "unconfigured-local", "unix", "proxy", "remote-root", "sandbox"])(
    "places the prepared environment only on owned local execution: %s",
    async (placement) => {
      vi.stubEnv("GIT_CONFIG_PARAMETERS", "'user.name=Ambient'");
      const params = createParams(
        path.join(tempDir, `path-${placement}.jsonl`),
        path.join(tempDir, `path-${placement}`),
      );
      const localToolEnv = { PATH: ["/fixture/tools", "/fixture/system"].join(path.delimiter) };
      params.hostCapabilities = {
        ...params.hostCapabilities,
        preparedEnvironment: () => ({
          credentialScrubEnv: {},
          localIdentityEnv: {},
          managedLocalIdentity: false,
          localGitConfigParameters: "'maintenance.auto=false' 'gc.auto=0'",
          ...(placement === "unconfigured-local"
            ? {}
            : { localToolEnv, localToolPathPrepend: ["/fixture/tools"] }),
        }),
      };
      if (placement === "sandbox") {
        params.sandbox = createSandboxContext({});
      }
      const connection = await prepareCodexAttemptConnection({
        params,
        options: {
          bindingStore: testCodexAppServerBindingStore,
          pluginConfig: {
            appServer:
              placement === "unix"
                ? { transport: "unix", homeScope: "user", url: "unix:///fixture/native.sock" }
                : {
                    transport: "stdio",
                    ...(placement === "remote-root"
                      ? { remoteWorkspaceRoot: "/remote/workspace" }
                      : {}),
                    ...(placement === "proxy"
                      ? { args: ["app-server", "proxy", "--sock", "/fixture/native.sock"] }
                      : {}),
                  },
          },
        },
      });
      try {
        const expected = placement === "local" ? localToolEnv : undefined;
        expect(connection.shellEnvironment).toEqual(expected);
        expect(connection.shellPathPrepend).toEqual(expected ? ["/fixture/tools"] : undefined);
        const ownedLocal = placement === "local" || placement === "unconfigured-local";
        const parameters = "'maintenance.auto=false' 'gc.auto=0'";
        expect(connection.shellGitConfigParameters).toBe(ownedLocal ? parameters : undefined);
        expect(connection.appServer.start.env?.PATH).toBe(expected?.PATH);
        const expectedParameters = ownedLocal ? `'user.name=Ambient' ${parameters}` : undefined;
        expect(connection.appServer.start.env?.GIT_CONFIG_PARAMETERS).toBe(expectedParameters);
        expect(connection.disableLoginShell).toBe(false);
        const refreshed = await connection.resolveRuntimeOptionsForCurrentBinding({
          modelProvider: "openai",
          model: params.modelId,
        });
        expect(refreshed.start.env?.PATH).toBe(expected?.PATH);
        expect(refreshed.start.env?.GIT_CONFIG_PARAMETERS).toBe(expectedParameters);
        if (expected) {
          expect(codexAppServerStartOptionsKey(refreshed.start)).not.toBe(
            codexAppServerStartOptionsKey({
              ...refreshed.start,
              env: { ...refreshed.start.env, PATH: "/fixture/old" },
            }),
          );
        }
      } finally {
        connection.cancellation.dispose();
        connection.releaseModelExecution();
      }
    },
  );

  it("keeps an invalid GitHub selection off another account for native start and resume", async () => {
    const root = tempDir;
    const otherConfig = path.join(root, "other-gh");
    const xdg = path.join(root, "xdg");
    const hosts = `github.com:\n  user: other-account\n  oauth_token: ${OTHER_ACCOUNT_TOKEN}\n`;
    await fs.mkdir(path.join(xdg, "gh"), { recursive: true, mode: 0o700 });
    await fs.mkdir(otherConfig, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(otherConfig, "hosts.yml"), hosts, { mode: 0o600 });
    await fs.writeFile(path.join(xdg, "gh", "hosts.yml"), hosts, { mode: 0o600 });
    const stubPath = path.join(root, "gh-stub.mjs");
    await fs.writeFile(stubPath, GH_CLIENT_STUB_SOURCE);
    vi.stubEnv("GH_TOKEN", OTHER_ACCOUNT_TOKEN);
    vi.stubEnv("GITHUB_TOKEN", OTHER_ACCOUNT_TOKEN);
    vi.stubEnv("GH_ENTERPRISE_TOKEN", OTHER_ACCOUNT_TOKEN);
    vi.stubEnv("GITHUB_ENTERPRISE_TOKEN", OTHER_ACCOUNT_TOKEN);
    vi.stubEnv("GH_CONFIG_DIR", otherConfig);
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));

    const admitted = await createAdmittedHostCapabilityTestFixture({
      runId: "invalid-github-native",
      agentId: "main",
      sessionKey: "agent:main:session-1",
      config: {
        tools: { github: { profileId: `ghp_${"A".repeat(36)}`, kind: "oauth" } },
      },
    });
    const workspaceDir = path.join(root, "workspace");
    const params = createParams(path.join(root, "session.jsonl"), workspaceDir);
    params.hostCapabilities = {
      ...params.hostCapabilities,
      preparedEnvironment: () => {
        const prepared = admitted.hostCapabilities.preparedEnvironment?.();
        if (!prepared) {
          throw new Error("expected a prepared native environment");
        }
        return prepared;
      },
    };
    registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });
    try {
      expect(connection.disableLoginShell).toBe(true);
      const shellEnvironment = connection.shellEnvironment;
      expect(shellEnvironment?.GH_TOKEN).toBe("openclaw-invalid-github-profile");
      expect(shellEnvironment?.GH_CONFIG_DIR).toEqual(expect.any(String));
      expect(shellEnvironment?.GH_CONFIG_DIR).not.toBe(otherConfig);
      await expect(fs.access(shellEnvironment?.GH_CONFIG_DIR ?? "")).rejects.toThrow();

      const hostile: NodeJS.ProcessEnv = {
        GH_TOKEN: OTHER_ACCOUNT_TOKEN,
        GITHUB_TOKEN: OTHER_ACCOUNT_TOKEN,
        GH_ENTERPRISE_TOKEN: OTHER_ACCOUNT_TOKEN,
        GITHUB_ENTERPRISE_TOKEN: OTHER_ACCOUNT_TOKEN,
        GH_CONFIG_DIR: otherConfig,
        XDG_CONFIG_HOME: xdg,
        HOME: root,
      };
      expectUnavailableClient(
        await runGitHubClientStub(stubPath, { ...hostile, ...connection.appServer.start.env }),
      );

      const threadOptions = {
        appServer: createThreadRequestAppServerOptions(),
        shellEnvironment,
        disableLoginShell: connection.disableLoginShell,
      };
      const started = buildThreadStartParams(
        createThreadRequestAttemptParams({ provider: "openai" }),
        {
          ...threadOptions,
          cwd: workspaceDir,
          dynamicTools: [],
        },
      );
      const resumed = buildThreadResumeParams(
        createThreadRequestAttemptParams({ provider: "openai" }),
        {
          ...threadOptions,
          threadId: "thread-invalid-github",
        },
      );
      for (const request of [started, resumed]) {
        const config = request.config;
        if (!config) {
          throw new Error("expected thread config");
        }
        const policy = config.shell_environment_policy;
        if (!isJsonObject(policy) || !isJsonObject(policy.set)) {
          throw new Error("expected a shell environment policy set");
        }
        expectUnavailableClient(
          await runGitHubClientStub(stubPath, { ...hostile, ...stringEnv(policy.set) }),
        );
      }
    } finally {
      connection.cancellation.dispose();
      connection.releaseModelExecution();
      admitted.closeHost();
      admitted.closeAdmission();
    }
  });
});

const OTHER_ACCOUNT_TOKEN = "fixture-other-github-account";
const GH_CLIENT_STUB_SOURCE = String.raw`
import fs from "node:fs";
import path from "node:path";

const other = "fixture-other-github-account";
const sentinel = "openclaw-invalid-github-profile";
const tokenNames = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const selected = tokenNames.find((name) => process.env[name]);
const configured = process.env.GH_CONFIG_DIR;
const configDir = configured
  ? configured
  : path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config"), "gh");
let hosts = "";
try {
  hosts = fs.readFileSync(path.join(configDir, "hosts.yml"), "utf8");
} catch {
  hosts = "";
}
const fallthrough = hosts.includes(other)
  ? "other-account"
  : hosts.includes("oauth_token:")
    ? "configured"
    : "none";
if (selected) {
  const value = process.env[selected];
  if (value === sentinel) {
    process.stdout.write("AUTH=sentinel\nFALLTHROUGH=" + fallthrough + "\n");
    process.exit(1);
  }
  if (value === other) {
    process.stdout.write("AUTH=other-account\nFALLTHROUGH=" + fallthrough + "\n");
    process.exit(0);
  }
  process.stdout.write("AUTH=unexpected-env\nFALLTHROUGH=" + fallthrough + "\n");
  process.exit(0);
}
const auth = fallthrough === "other-account" ? "other-account" : "none";
process.stdout.write("AUTH=" + auth + "\nFALLTHROUGH=" + fallthrough + "\n");
process.exit(fallthrough === "none" ? 1 : 0);
`;

function githubClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Drop the test runner and app-server process hooks. The client only needs
  // the GitHub account variables the shell would actually pass through.
  const client: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  for (const name of [
    "GH_CONFIG_DIR",
    "GH_ENTERPRISE_TOKEN",
    "GH_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GITHUB_TOKEN",
    "HOME",
    "XDG_CONFIG_HOME",
  ]) {
    if (typeof env[name] === "string") {
      client[name] = env[name];
    }
  }
  return client;
}

function runGitHubClientStub(
  stubPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [stubPath],
      { env: githubClientEnv(env) },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`;
        if (!error) {
          resolve({ status: 0, output });
          return;
        }
        const exitCode =
          typeof error === "object" && error && "code" in error && typeof error.code === "number"
            ? error.code
            : undefined;
        if (exitCode !== undefined) {
          resolve({ status: exitCode, output });
          return;
        }
        reject(error);
      },
    );
  });
}

function expectUnavailableClient(result: { status: number | null; output: string }) {
  expect(result.status).toBe(1);
  expect(result.output).toContain("AUTH=sentinel");
  expect(result.output).toContain("FALLTHROUGH=none");
  expect(result.output).not.toContain(OTHER_ACCOUNT_TOKEN);
  expect(result.output).not.toContain("AUTH=other-account");
}

function stringEnv(record: Record<string, unknown> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}
