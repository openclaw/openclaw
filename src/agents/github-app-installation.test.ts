import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  prepareGitHubAppInstallation,
  type GitHubAppSelection,
} from "./github-app-installation.js";
import {
  prepareGitHubPublicationIdentity,
  prepareGitHubReadIdentity,
  prepareGitHubToolEnvironment,
} from "./github-tool-identity.js";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const host = "microsoft.ghe.com";
const apiBaseUrl = "https://api.microsoft.ghe.com";
function selection(): GitHubAppSelection {
  return {
    profileId: "ghp_6128c113c0df8c1a366dfe690c062d8e",
    kind: "app-installation",
    app: {
      appId: 13361,
      installationId: 119386,
      accountId: 185961,
      repositories: [{ id: 1044511, fullName: "bic/lobster" }],
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
      "/app": { id: 13361, slug: "factory", permissions: { contents: "write", metadata: "read" } },
      "/app/installations/119386": {
        id: 119386,
        app_id: 13361,
        account: { id: 185961 },
        suspended_at: null,
        permissions: { contents: "write", metadata: "read" },
      },
      "/users/factory%5Bbot%5D": { id: 9001, login: "factory[bot]", type: "Bot", avatar_url: null },
      "/installation/repositories?per_page=100": {
        total_count: 1,
        repositories: [{ id: 1044511, full_name: "bic/lobster" }],
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
  it("issues exact repository permissions and bot identity without OAuth /user; reuse has absolute expiry", async () => {
    const selected = selection();
    const params = { selection: selected, host, apiBaseUrl, assertCurrent: () => {} };
    const first = await prepareGitHubAppInstallation(params);
    expect(first.account).toEqual({ accountId: 9001, login: "factory[bot]", avatarUrl: null });
    const mint = fetcher.mock.calls.find(([url]) => url.endsWith("/access_tokens"));
    const body = mint?.[1].body;
    if (typeof body !== "string") {
      throw new Error("Expected JSON token request");
    }
    expect(JSON.parse(body)).toEqual({
      repository_ids: [1044511],
      permissions: { contents: "write", metadata: "read" },
    });
    expect(fetcher.mock.calls.some(([url]) => url === `${apiBaseUrl}/user`)).toBe(false);
    vi.advanceTimersByTime(240_000);
    expect((await prepareGitHubAppInstallation(params)).token).toBe(first.token);
    expect(fetcher).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(60_000);
    await expect(first.readToken()).rejects.toThrow("changed");
    expect((await prepareGitHubAppInstallation(params)).token).not.toBe(first.token);
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
  it.each(["suspended", "foreign installation", "wrong scope", "extra permissions", "expired"])(
    "refuses %s without fallback",
    async (mode) => {
      if (mode === "suspended") {
        overrides["/app/installations/119386"] = {
          id: 119386,
          app_id: 13361,
          account: { id: 185961 },
          suspended_at: "2026-10-10",
          permissions: { contents: "write", metadata: "read" },
        };
      }
      if (mode === "foreign installation") {
        overrides["/app/installations/119386"] = {
          id: 119386,
          app_id: 13362,
          account: { id: 185961 },
          suspended_at: null,
          permissions: { contents: "write", metadata: "read" },
        };
      }
      if (mode === "wrong scope") {
        overrides["/installation/repositories?per_page=100"] = {
          total_count: 1,
          repositories: [{ id: 4, full_name: "other/repo" }],
        };
      }
      if (mode === "extra permissions" || mode === "expired") {
        overrides["/app/installations/119386/access_tokens"] = {
          token: "synthetic-denied",
          expires_at: new Date(Date.now() + (mode === "expired" ? -1 : 60_000)).toISOString(),
          permissions:
            mode === "extra permissions"
              ? { contents: "write", metadata: "read", issues: "write" }
              : { contents: "write", metadata: "read" },
        };
      }
      await expect(
        prepareGitHubAppInstallation({
          selection: selection(),
          host,
          apiBaseUrl,
          assertCurrent: () => {},
        }),
      ).rejects.toThrow("verified");
      expect(fetcher.mock.calls.some(([url]) => url === `${apiBaseUrl}/user`)).toBe(false);
      if (["wrong scope", "extra permissions", "expired"].includes(mode)) {
        expect(fetcher.mock.calls.some(([, init]) => init.method === "DELETE")).toBe(true);
      }
    },
  );
  it("rejects late authority and key generation changes before a credential escapes", async () => {
    const selected = selection();
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("owner closed");
      }
    };
    onRequest = (path) => {
      if (path.endsWith("/access_tokens")) {
        current = false;
      }
    };
    await expect(
      prepareGitHubAppInstallation({ selection: selected, host, apiBaseUrl, assertCurrent }),
    ).rejects.toThrow("owner closed");
    onRequest = undefined;
    current = true;
    const issued = await prepareGitHubAppInstallation({
      selection: selected,
      host,
      apiBaseUrl,
      assertCurrent,
    });
    selected.app.keyVersion = "synthetic-v2";
    await expect(issued.readToken()).rejects.toThrow("changed");
  });
  it("bounds reuse by verified token expiry even when shorter than five minutes", async () => {
    overrides["/app/installations/119386/access_tokens"] = {
      token: "synthetic-short-lived",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      permissions: { contents: "write", metadata: "read" },
    };
    const selected = selection();
    const issued = await prepareGitHubAppInstallation({
      selection: selected,
      host,
      apiBaseUrl,
      assertCurrent: () => {},
    });
    vi.advanceTimersByTime(60_000);
    await expect(issued.readToken()).rejects.toThrow("changed");
  });
  it("records bounded App admission and issuance phases and refuses late human admission", async () => {
    const config: OpenClawConfig = {
      gateway: { github: { host, apiBaseUrl } },
      tools: { github: selection() },
    };
    setRuntimeConfigSnapshot(config);
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const observe = vi.fn();
    let current = true;
    await expect(
      prepareGitHubPublicationIdentity({
        config,
        agentId: "main",
        observePreparation: observe,
        assertCurrent: () => {
          if (!current) {
            throw new Error("human owner closed");
          }
        },
        readNativeCredential: async () => {
          current = false;
          return undefined;
        },
      }),
    ).rejects.toThrow("human owner closed");
    expect(fetcher).not.toHaveBeenCalled();
    expect(observe.mock.calls).toEqual([
      ["repository_admission", "started"],
      ["repository_admission", "resolved"],
    ]);
    current = true;
    await prepareGitHubPublicationIdentity({
      config,
      agentId: "main",
      observePreparation: observe,
      readNativeCredential: async () => undefined,
    });
    expect(observe.mock.calls.slice(-4)).toEqual([
      ["repository_admission", "started"],
      ["repository_admission", "resolved"],
      ["app_installation", "started"],
      ["app_installation", "resolved"],
    ]);
  });
  it("shares concurrent issuance without invalidating a current caller's token", async () => {
    const selected = selection();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      if (url.endsWith("/access_tokens")) {
        await gate;
      }
      return transport(url, init);
    });
    const first = prepareGitHubAppInstallation({
      selection: selected,
      host,
      apiBaseUrl,
      assertCurrent: () => {},
    });
    const second = prepareGitHubAppInstallation({
      selection: selected,
      host,
      apiBaseUrl,
      assertCurrent: () => {},
    });
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(left.token).toBe(right.token);
    expect(tokenNumber).toBe(1);
    await expect(left.readToken()).resolves.toBe(left.token);
    await expect(right.readToken()).resolves.toBe(right.token);
  });
  it("rechecks each joining caller's authority after shared issuance", async () => {
    const selected = selection();
    let current = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      if (url.endsWith("/access_tokens")) {
        await gate;
      }
      return transport(url, init);
    });
    const first = prepareGitHubAppInstallation({
      selection: selected,
      host,
      apiBaseUrl,
      assertCurrent: () => {},
    });
    const second = prepareGitHubAppInstallation({
      selection: selected,
      host,
      apiBaseUrl,
      assertCurrent: () => {
        if (!current) {
          throw new Error("joining owner closed");
        }
      },
    });
    const observed = second.catch((error: unknown) => error);
    current = false;
    release();
    const left = await first;
    expect(await observed).toMatchObject({ message: "joining owner closed" });
    await expect(left.readToken()).resolves.toBe(left.token);
  });
  it("keeps a current joiner usable when the initiating caller closes", async () => {
    const selected = selection();
    let current = true;
    const first = prepareGitHubAppInstallation({
      selection: selected,
      host,
      apiBaseUrl,
      assertCurrent: () => {
        if (!current) {
          throw new Error("initiating owner closed");
        }
      },
    });
    const observed = first.catch((error: unknown) => error);
    const second = prepareGitHubAppInstallation({
      selection: selected,
      host,
      apiBaseUrl,
      assertCurrent: () => {},
    });
    current = false;
    expect(await observed).toMatchObject({ message: "initiating owner closed" });
    const joined = await second;
    expect(tokenNumber).toBe(1);
    await expect(joined.readToken()).resolves.toBe(joined.token);
  });
  it("accepts mandatory metadata read while refusing unrequested permissions", async () => {
    const selected = selection();
    selected.app.permissions = { contents: "write" };
    const issued = await prepareGitHubAppInstallation({
      selection: selected,
      host,
      apiBaseUrl,
      assertCurrent: () => {},
    });
    expect(issued.facts.permissions).toEqual({ contents: "write", metadata: "read" });
  });
  it("excludes another agent's signing-key refs from unrelated execution", () => {
    const system = selection();
    system.app.privateKey = { source: "env", provider: "default", id: "SYSTEM_APP_KEY" };
    const other = selection();
    other.app.privateKey = { source: "store", provider: "default", id: "OTHER_APP_KEY" };
    const config: OpenClawConfig = {
      tools: { github: system },
      agents: {
        entries: {
          other: { tools: { github: other } },
          main: { tools: { github: { profileId: "ghp_11111111111111111111111111111111" } } },
        },
      },
    };
    const prepared = prepareGitHubToolEnvironment({
      config,
      sourceConfig: config,
      agentId: "main",
    });
    expect(prepared.credentialScrubEnv.SYSTEM_APP_KEY).toBe("");
    expect(prepared.credentialScrubEnv.OTHER_APP_KEY).toBe("");
    expect(prepared.excludedStoreNames).toContain("OTHER_APP_KEY");
    expect(prepared.localIdentityEnv.OPENCLAW_GITHUB_EXECUTION_KIND).toBe("");
  });
  it("canonical selection requires human admission in Factory and never calls the human token path", async () => {
    const selected = selection();
    const config: OpenClawConfig = {
      gateway: { github: { host, apiBaseUrl } },
      tools: { github: selected },
    };
    setRuntimeConfigSnapshot(config);
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    await expect(prepareGitHubPublicationIdentity({ config, agentId: "main" })).rejects.toThrow(
      "unavailable",
    );
    expect(fetcher).not.toHaveBeenCalled();
    const reader = vi.fn(async (_env: NodeJS.ProcessEnv, request?: unknown) => {
      expect(request).toMatchObject({ kind: "repository-admission", host });
      return undefined;
    });
    const prepared = await prepareGitHubPublicationIdentity({
      config,
      agentId: "main",
      readNativeCredential: reader,
    });
    expect(prepared.account.login).toBe("factory[bot]");
    expect(prepared.env.OPENCLAW_GITHUB_EXECUTION_KIND).toBe("app-installation");
    expect(reader).toHaveBeenCalledTimes(1);
    const read = await prepareGitHubReadIdentity({
      config,
      agentId: "main",
      readNativeCredential: reader,
      getCurrentConfig: () => config,
      assertActive: () => {},
      refresh: async () => {},
    });
    await read.revalidate();
    expect(reader).toHaveBeenCalledTimes(2);
    config.tools!.github = selection();
    config.tools!.github.app.keyVersion = "replacement";
    await expect(read.revalidate()).rejects.toThrow("changed");
  });
  it("scrubs custom Gateway key references and projects App selection for agent overrides", () => {
    const selected = selection();
    selected.app.privateKey = { source: "env", provider: "default", id: "CUSTOM_APP_KEY" };
    const config: OpenClawConfig = {
      agents: { entries: { main: { tools: { github: selected } } } },
    };
    const prepared = prepareGitHubToolEnvironment({
      config,
      sourceConfig: config,
      agentId: "main",
    });
    expect(prepared.credentialScrubEnv.CUSTOM_APP_KEY).toBe("");
    expect(prepared.localIdentityEnv.OPENCLAW_GITHUB_EXECUTION_KIND).toBe("app-installation");
  });
});
