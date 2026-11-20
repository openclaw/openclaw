import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { respondWorkerDispatchError } from "../gateway/server-methods/sessions-dispatch-response.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
  requestFrame,
} from "../gateway/server/ws-connection/authenticated-request-dispatch.test-support.js";
import { createNodeWorkerRepositoryPreparation } from "../gateway/worker-environments/node-worker-repository-preparation.js";
import { logWs } from "../gateway/ws-log.js";
import {
  runWithDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { NodeWorkerWorkspaceRuntime } from "../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { prepareAppGitHubIdentity } from "./github-app-identity.js";
import type { GitHubAppSelection } from "./github-credential-reader.js";
import { GitHubIdentityError } from "./github-read-identity.js";
import {
  resolveGitHubToolIdentityStatus,
  prepareGitHubPublicationIdentity,
  prepareGitHubReadIdentity,
  prepareGitHubToolEnvironment,
} from "./github-tool-identity.js";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const host = "engineering.ghe.com";
const apiBaseUrl = "https://api.engineering.ghe.com";
const permissions = { contents: "write", metadata: "read" } as const;
const installation = {
  id: 202,
  app_id: 101,
  account: { id: 303 },
  suspended_at: null,
  permissions,
};
let selected: GitHubAppSelection;
let config: OpenClawConfig;
async function prepare() {
  const { prepared, readToken } = await prepareAppGitHubIdentity(
    { config, agentId: "main", allowAppInstallation: true, assertCurrent() {} },
    selected,
    "system-configured",
    {},
    host,
    apiBaseUrl,
  );
  return { ...prepared, readToken };
}
function prepareRead(options: Partial<Parameters<typeof prepareGitHubReadIdentity>[0]> = {}) {
  return prepareGitHubReadIdentity({
    config,
    agentId: "main",
    assertActive: () => {},
    getCurrentConfig: () => config,
    refresh: async () => {},
    ...options,
  });
}
let onRequest: ((path: string) => void) | undefined;
let overrides: Record<string, unknown>;
let fetcher: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  selected = {
    profileId: "ghp_00000000000000000000000000000001",
    kind: "app-installation",
    app: {
      appId: 101,
      installationId: 202,
      accountId: 303,
      repositories: [{ id: 404, fullName: "example/project" }],
      permissions,
      privateKey: key,
      keyVersion: "synthetic-v1",
    },
  };
  config = {
    gateway: { github: { host, apiBaseUrl } },
    tools: { github: selected },
  };
  setRuntimeConfigSnapshot(config);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
  overrides = {};
  onRequest = undefined;
  fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const endpoint = url.slice(apiBaseUrl.length);
    onRequest?.(endpoint);
    const bodies: Record<string, unknown> = {
      "/app": { id: 101, slug: "factory", permissions },
      "/app/installations/202": installation,
      "/users/factory%5Bbot%5D": { id: 9001, login: "factory[bot]", type: "Bot", avatar_url: null },
      "/installation/repositories?per_page=100": {
        total_count: 1,
        repositories: [{ id: 404, full_name: "example/project" }],
      },
      "/app/installations/202/access_tokens": {
        token: "synthetic-installation",
        expires_at: "2026-10-10T11:00:00.000Z",
        permissions,
      },
    };
    if (init.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    const body = bodies[endpoint];
    if (!body) {
      throw new Error("Unexpected endpoint");
    }
    return Response.json(overrides[endpoint] ?? body);
  });
  vi.stubGlobal("fetch", fetcher);
  integrationState.enabled = false;
  integrationState.real = false;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setRuntimeConfigSnapshot({});
});

it("rejects a suspended installation before minting and never reads human credentials", async () => {
  overrides["/app/installations/202"] = {
    ...installation,
    suspended_at: "2026-10-10T09:00:00Z",
  };
  await expect(prepare()).rejects.toThrow();
  expect(
    fetcher.mock.calls.some(([url]) => url.endsWith("/access_tokens") || url.endsWith("/user")),
  ).toBe(false);
});
it("settles invalid-token revocation and retires token reads", async () => {
  const issued = await prepare();
  expect(issued.account).toEqual({ accountId: 9001, login: "factory[bot]", avatarUrl: null });
  expect(issued.env.GH_HOST).toBe(host);
  fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(issued.revoke()).resolves.toBeUndefined();
  await expect(issued.readToken()).rejects.toThrow("changed");
});
it("reports the selected App contract without minting an execution token during status", async () => {
  expect(
    (await resolveGitHubToolIdentityStatus({ config, agentId: "main", selectedScope: "system" }))
      .effective,
  ).toMatchObject({
    source: "system-configured",
    credentialKind: "app-installation",
    credentialState: "unverified",
    account: null,
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  [prepareGitHubPublicationIdentity, "unavailable"],
  [() => prepareRead(), "unavailable"],
] as const)(
  "refuses unsupported App preparation before credential lookup: %s",
  async (attempt, reason) => {
    integrationState.enabled = true;
    await expect(async () => attempt({ config, agentId: "main" })).rejects.toThrow(reason);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it("logs safe App refusal origins in the existing request trace without changing responses or cleanup", async () => {
  integrationState.enabled = true;
  const traceId = "1".repeat(32);
  const privateResponses: { origin: unknown; traceId: string | undefined }[] = [];
  vi.mocked(logWs).mockImplementation((direction, event, metadata) => {
    if (direction === "out" && event === "res") {
      const fields = typeof metadata === "function" ? metadata() : metadata;
      privateResponses.push({
        origin: fields?.githubIdentityOrigin,
        traceId: getActiveDiagnosticTraceContext()?.traceId,
      });
    }
  });
  const originalKey = selected.app.privateKey;
  for (const origin of [
    "app-not-admitted",
    "repository-not-selected",
    "native-reader-missing",
    "issuer-key-unresolved",
    "native-reader-failed",
    "issuer-failed",
  ] as const) {
    fetcher.mockClear();
    privateResponses.length = 0;
    selected.app.privateKey = origin === "issuer-key-unresolved" ? "" : originalKey;
    overrides =
      origin === "issuer-failed"
        ? { "/users/factory%5Bbot%5D": { id: 9001, login: "wrong", type: "Bot", avatar_url: null } }
        : {};
    const readerError = new GitHubIdentityError("unavailable");
    const admission = vi.fn(async () => {
      if (origin === "native-reader-failed") {
        throw readerError;
      }
      return undefined;
    });
    const harness = createDispatchTestHarness({
      extraHandlers: {
        "test.githubAdmission": async ({ respond }) => {
          try {
            await prepareRead({
              allowAppInstallation: origin !== "app-not-admitted",
              requestedRepository:
                origin === "repository-not-selected" ? "other/repository" : "example/project",
              readNativeCredential: origin === "native-reader-missing" ? undefined : admission,
            });
            throw new Error("Expected App refusal");
          } catch (error) {
            if (origin === "native-reader-failed") {
              expect(error).toBe(readerError);
            }
            respondWorkerDispatchError(error, respond);
          }
        },
      },
      buildRequestContext: () => ({ getRuntimeConfig: () => config }),
    });
    await runWithDiagnosticTraceContext({ traceId, spanId: "2".repeat(16) }, () =>
      harness.dispatcher.dispatch(
        requestFrame(origin, "test.githubAdmission"),
        createOperatorWsClient(),
      ),
    );
    const response = await harness.awaitResponseFrame(origin);
    expect(response).toEqual({
      type: "res",
      id: origin,
      ok: false,
      payload: undefined,
      error: {
        code: "UNAVAILABLE",
        message:
          origin === "issuer-failed"
            ? "The effective GitHub identity could not be verified; retry or reconnect the agent's GitHub identity."
            : "The selected GitHub credential is unavailable; reconnect the agent's GitHub identity in Settings.",
      },
    });
    expect(privateResponses).toEqual([{ origin, traceId }]);
    expect(JSON.stringify(response)).not.toContain("githubIdentityOrigin");
    if (["app-not-admitted", "repository-not-selected", "native-reader-missing"].includes(origin)) {
      expect(admission).not.toHaveBeenCalled();
    } else {
      expect(admission).toHaveBeenCalledOnce();
    }
    if (origin === "issuer-failed") {
      expect(fetcher.mock.calls.at(-1)).toMatchObject([
        `${apiBaseUrl}/installation/token`,
        { method: "DELETE" },
      ]);
    } else {
      expect(fetcher).not.toHaveBeenCalled();
    }
  }
  const spoofed = Object.assign(new GitHubIdentityError("unavailable"), {
    githubIdentityOrigin: "arbitrary-secret",
  });
  const respond = vi.fn();
  respondWorkerDispatchError(spoofed, respond);
  expect(respond.mock.calls[0]?.[3]).toBeUndefined();
});

it("prepares the selected App tool environment without exposing signing keys", () => {
  const sourceConfig: OpenClawConfig = {
    ...config,
    tools: {
      github: {
        ...selected,
        app: {
          ...selected.app,
          privateKey: { source: "env", provider: "default", id: "SYNTHETIC_APP_SIGNING_KEY" },
        },
      },
    },
  };
  const overlay = prepareGitHubToolEnvironment({ config, sourceConfig, agentId: "main" });
  expect(overlay.appInstallationProfileId).toBe(selected.profileId);
  expect(overlay.credentialScrubEnv.SYNTHETIC_APP_SIGNING_KEY).toBe("");
  expect(overlay.credentialScrubEnv.GITHUB_APP_PRIVATE_KEY).toBe("");
  expect(fetcher).not.toHaveBeenCalled();
});
it("retains request-owned App cleanup and retires reads when the selected App changes", async () => {
  integrationState.enabled = true;
  const admission = vi.fn(async () => undefined);
  const identity = await prepareRead({
    allowAppInstallation: true,
    readNativeCredential: admission,
  });
  expect(admission).toHaveBeenCalledOnce();
  await expect(identity.start(() => "repository read")).resolves.toBe("repository read");
  config = {
    ...config,
    tools: { github: { ...selected, app: { ...selected.app, keyVersion: "rotated" } } },
  };
  await expect(identity.start(() => "stale read")).rejects.toThrow("changed");
  await identity.revoke?.();
  expect(fetcher.mock.calls.at(-1)?.[1].method).toBe("DELETE");
  await expect(identity.start(() => "closed read")).rejects.toThrow("changed");
});

it("rechecks the repository policy owner after metadata waits before issuing a token", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  let current = true;
  const nativeFetch = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    const response = await nativeFetch(url, init);
    if (url.endsWith("/app")) {
      current = false;
    }
    return response;
  });
  const readNativeCredential = Object.assign(async () => undefined, {
    assertCurrent() {
      if (!current) {
        throw new Error("repository policy revoked");
      }
    },
  });
  await expect(prepareRead({ allowAppInstallation: true, readNativeCredential })).rejects.toThrow(
    "repository policy revoked",
  );
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/access_tokens"))).toBe(false);
});

const checkoutDirs = useAutoCleanupTempDirTracker(afterEach);
it.each(["allowed", "forbidden", "revoked-after-seed"] as const)(
  "checks repository policy at real local worker Git effects: %s",
  async (scenario) => {
    vi.useRealTimers();
    overrides["/app/installations/202/access_tokens"] = {
      token: "synthetic-installation",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      permissions,
    };
    const root = await fs.realpath(checkoutDirs.make("repository-policy-effect-"));
    const origin = path.join(root, "origin");
    await fs.mkdir(origin);
    const git = async (...args: string[]) => {
      const result = await runCommandWithTimeout(["git", "-C", origin, ...args], {
        timeoutMs: 10000,
        baseEnv: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    await git("init", "--quiet");
    await fs.writeFile(path.join(origin, "tracked.txt"), "authorized source\n");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Authority Test",
      "-c",
      "user.email=authority@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "source",
    );
    const commit = await git("rev-parse", "HEAD");
    let current = scenario !== "forbidden";
    const readNativeCredential = Object.assign(async () => undefined, {
      assertCurrent() {
        if (!current) {
          throw new Error("repository policy revoked");
        }
      },
    });
    const commands: string[] = [];
    await fs.mkdir(path.join(root, "node-home"), { recursive: true, mode: 0o700 });
    const runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(root, "node-state"),
      env: { PATH: process.env.PATH, HOME: path.join(root, "node-home") },
    });
    let identity: Awaited<ReturnType<typeof prepareRead>> | undefined;
    const checkout = async () => {
      const admitted = await prepareRead({ allowAppInstallation: true, readNativeCredential });
      identity = admitted;
      const repository = createNodeWorkerRepositoryPreparation(async (command) => {
        command.assertCurrent?.();
        commands.push(command.seed ? "seed" : command.argv.includes("clone") ? "clone" : "git");
        const result = await runtime.exec({
          gatewayNamespace: "authority-proof",
          environmentId: "worker",
          sessionId: "session",
          generation: 1,
          argv: [...command.argv],
          input: command.input,
          seed: command.seed,
          resetWorkspace: command.resetWorkspace,
          timeoutMs: command.timeoutMs,
        });
        if (scenario === "revoked-after-seed" && command.seed?.action === "apply") {
          current = false;
        }
        return result;
      }, admitted.assertSelected);
      return await admitted.start(() =>
        repository.prepareRepository({
          origin: pathToFileURL(origin).href,
          commit,
          gitToken: admitted.token,
        }),
      );
    };
    try {
      if (scenario === "allowed") {
        const result = await checkout();
        expect(result.kind).toBe("prepared");
        if (result.kind !== "prepared") {
          throw new Error("Local worker checkout failed");
        }
        expect(
          await fs.readFile(path.join(result.result.remoteWorkspaceDir, "tracked.txt"), "utf8"),
        ).toBe("authorized source\n");
        expect(commands).toContain("clone");
        expect(
          await fs.readFile(path.join(result.result.remoteWorkspaceDir, ".git", "config"), "utf8"),
        ).not.toContain("synthetic-installation");
      } else {
        await expect(checkout()).rejects.toThrow("repository policy revoked");
        expect(commands).toEqual(scenario === "forbidden" ? [] : ["seed"]);
      }
    } finally {
      await identity?.revoke?.();
    }
  },
);

it.each(["before-entry", "during-metadata"] as const)(
  "honors the published repository owner despite a captured policy-free config (%s)",
  async (phase) => {
    integrationState.real = true;
    const required: OpenClawConfig = {
      ...config,
      gateway: { ...config.gateway, repositoryIntegration: "required-policy" },
    };
    setRuntimeConfigSnapshot(phase === "before-entry" ? required : config);
    onRequest = (endpoint) => {
      if (phase === "during-metadata" && endpoint === "/app") {
        setRuntimeConfigSnapshot(required);
      }
    };
    await expect(prepareGitHubPublicationIdentity({ config, agentId: "main" })).rejects.toThrow(
      /integration.*unavailable|changed/,
    );
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/access_tokens"))).toBe(false);
    if (phase === "before-entry") {
      expect(fetcher).not.toHaveBeenCalled();
    }
  },
);

const integrationState = vi.hoisted(() => ({
  enabled: false,
  real: false,
  provider: { preparedCapacity: "image" as const },
}));
vi.mock("../plugins/repository-integration-runtime.js", async (original) => {
  const actual = await original<typeof import("../plugins/repository-integration-runtime.js")>();
  return {
    ...actual,
    getRepositoryIntegration: (capturedConfig?: OpenClawConfig) =>
      integrationState.real
        ? actual.getRepositoryIntegration(capturedConfig)
        : integrationState.enabled
          ? integrationState.provider
          : undefined,
  };
});
afterEach(() => {
  integrationState.enabled = false;
  integrationState.real = false;
});

vi.mock("../gateway/ws-log.js", async (original) => ({
  ...(await original<typeof import("../gateway/ws-log.js")>()),
  logWs: vi.fn(),
}));
