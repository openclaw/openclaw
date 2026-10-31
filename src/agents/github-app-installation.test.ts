import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNodeWorkerRepositoryPreparation } from "../gateway/worker-environments/node-worker-repository-preparation.js";
import { NodeWorkerWorkspaceRuntime } from "../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { prepareAppGitHubIdentity } from "./github-app-identity.js";
import type { GitHubAppSelection } from "./github-credential-reader.js";
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
  fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const endpoint = url.slice(apiBaseUrl.length);
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
  vi.stubEnv("FACTORY_AUTH_MODE", undefined);
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
    credentialState: "configured_unavailable",
    account: null,
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  [prepareGitHubPublicationIdentity, "unavailable"],
  [prepareGitHubToolEnvironment, "select native or OAuth"],
  [() => prepareRead(), "unavailable"],
] as const)(
  "refuses unsupported App preparation before credential lookup: %s",
  async (attempt, reason) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    await expect(async () => attempt({ config, agentId: "main" })).rejects.toThrow(reason);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it("retains request-owned App cleanup and retires reads when the selected App changes", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
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
