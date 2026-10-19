import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareGitHubAppInstallation } from "./github-app-installation.js";
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
function selection(): GitHubAppSelection {
  return {
    profileId: "ghp_00000000000000000000000000000001",
    kind: "app-installation",
    app: {
      appId: 101,
      installationId: 202,
      accountId: 303,
      repositories: [{ id: 404, fullName: "example/project" }],
      permissions: { contents: "write", metadata: "read" },
      privateKey: key,
      keyVersion: "synthetic-v1",
    },
  };
}
let tokenNumber = 0;
let overrides: Record<string, unknown>;
let fetcher: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
let onRequest: ((path: string) => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
  tokenNumber = 0;
  overrides = {};
  onRequest = undefined;
  fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const path = url.slice(apiBaseUrl.length);
    onRequest?.(path);
    const bodies: Record<string, unknown> = {
      "/app": { id: 101, slug: "factory", permissions: { contents: "write", metadata: "read" } },
      "/app/installations/202": {
        id: 202,
        app_id: 101,
        account: { id: 303 },
        suspended_at: null,
        permissions: { contents: "write", metadata: "read" },
      },
      "/users/factory%5Bbot%5D": { id: 9001, login: "factory[bot]", type: "Bot", avatar_url: null },
      "/installation/repositories?per_page=100": {
        total_count: 1,
        repositories: [{ id: 404, full_name: "example/project" }],
      },
    };
    if (init.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    const body = path.endsWith("/access_tokens")
      ? {
          token: `synthetic-installation-${++tokenNumber}`,
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "write", metadata: "read" },
        }
      : bodies[path];
    if (!body) {
      throw new Error("Unexpected endpoint");
    }
    return Response.json(overrides[path] ?? body);
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

describe("selected GitHub App issuer", () => {
  it("issues exact repository permissions and bot identity and revokes the retained execution grant", async () => {
    const selected = selection();
    const issued = await prepareGitHubAppInstallation({
      selection: selected,
      host,
      apiBaseUrl,
      assertCurrent: () => {},
    });
    expect(issued.account).toEqual({ accountId: 9001, login: "factory[bot]", avatarUrl: null });
    const body = fetcher.mock.calls.find(([url]) => url.endsWith("/access_tokens"))?.[1].body;
    if (typeof body !== "string") {
      throw new Error("Expected bounded installation request");
    }
    expect(JSON.parse(body)).toEqual({
      repository_ids: [404],
      permissions: { contents: "write", metadata: "read" },
    });
    expect(fetcher.mock.calls.some(([url]) => url === `${apiBaseUrl}/user`)).toBe(false);
    await issued.revoke();
    await expect(issued.readToken()).rejects.toThrow("changed");
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`${apiBaseUrl}/installation/token`);
    expect(fetcher.mock.calls.at(-1)?.[1].method).toBe("DELETE");
  });
  it("rejects a suspended installation before minting and never reads human credentials", async () => {
    overrides["/app/installations/202"] = {
      id: 202,
      app_id: 101,
      account: { id: 303 },
      suspended_at: "2026-10-10T09:00:00Z",
      permissions: { contents: "write", metadata: "read" },
    };
    await expect(
      prepareGitHubAppInstallation({
        selection: selection(),
        host,
        apiBaseUrl,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow();
    expect(
      fetcher.mock.calls.some(([url]) => url.endsWith("/access_tokens") || url.endsWith("/user")),
    ).toBe(false);
  });
  it.each([401, 500])(
    "settles invalid-token revocation while preserving live-token cleanup failure (%s)",
    async (status) => {
      const issued = await prepareGitHubAppInstallation({
        selection: selection(),
        host,
        apiBaseUrl,
        assertCurrent: () => {},
      });
      fetcher.mockResolvedValueOnce(new Response(null, { status }));
      if (status === 401) {
        await expect(issued.revoke()).resolves.toBeUndefined();
      } else {
        await expect(issued.revoke()).rejects.toThrow("revocation failed");
      }
      await expect(issued.readToken()).rejects.toThrow();
    },
  );

  it("checks authority after issuance and revokes a token that cannot be admitted", async () => {
    let current = true;
    onRequest = (path) => {
      if (path.endsWith("/access_tokens")) {
        current = false;
      }
    };
    await expect(
      prepareGitHubAppInstallation({
        selection: selection(),
        host,
        apiBaseUrl,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Execution revoked");
          }
        },
      }),
    ).rejects.toThrow("Execution revoked");
    expect(fetcher.mock.calls.at(-1)?.[1].method).toBe("DELETE");
  });
  it("reports the selected App contract without minting an execution token during status", async () => {
    const config: OpenClawConfig = {
      gateway: { github: { host, apiBaseUrl } },
      tools: { github: selection() },
    };
    setRuntimeConfigSnapshot(config);
    expect(
      (await resolveGitHubToolIdentityStatus({ config, agentId: "main", selectedScope: "system" }))
        .effective,
    ).toEqual({
      source: "system-configured",
      credentialKind: "app-installation",
      credentialState: "configured_unavailable",
      account: null,
      gitAuthor: { name: null, email: null },
      evidence: "none",
      accessExpiresAtMs: null,
      refreshState: "not_applicable",
      oauthScopes: [],
      repositoryGrants: "unknown",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses unsupported App publication and shell preparation before credential lookup", async () => {
    const config: OpenClawConfig = {
      gateway: { github: { host, apiBaseUrl } },
      tools: { github: selection() },
    };
    setRuntimeConfigSnapshot(config);
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    await expect(prepareGitHubPublicationIdentity({ config, agentId: "main" })).rejects.toThrow(
      "unavailable",
    );
    expect(() => prepareGitHubToolEnvironment({ config, agentId: "main" })).toThrow(
      "select native or OAuth",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("retains request-owned App cleanup and retires reads when the selected App changes", async () => {
    const selected = selection();
    let config: OpenClawConfig = {
      gateway: { github: { host, apiBaseUrl } },
      tools: { github: selected },
    };
    setRuntimeConfigSnapshot(config);
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const admission = vi.fn(async () => undefined);
    const identity = await prepareGitHubReadIdentity({
      config,
      agentId: "main",
      allowAppInstallation: true,
      readNativeCredential: admission,
      assertActive: () => {},
      getCurrentConfig: () => config,
      refresh: async () => {},
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

  it("refuses App reads without a cleanup owner before minting", async () => {
    const config: OpenClawConfig = {
      gateway: { github: { host, apiBaseUrl } },
      tools: { github: selection() },
    };
    setRuntimeConfigSnapshot(config);
    await expect(
      prepareGitHubReadIdentity({
        config,
        agentId: "main",
        assertActive: () => {},
        getCurrentConfig: () => config,
        refresh: async () => {},
      }),
    ).rejects.toThrow("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
