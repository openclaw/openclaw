import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { captureChannelReadAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createEmptyPluginRegistry,
  createPluginRecord,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import undici from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "./channel.js";
import { setMSTeamsRuntime } from "./runtime.js";

vi.mock("node:dns/promises", { spy: true });

const teamId = "11111111-1111-1111-1111-111111111111";
const channelId = "19:private-roster@thread.tacv2";
const channelPath = "/v1.0/teams/" + teamId + "/channels/19%3Aprivate-roster%40thread.tacv2";
const membersPath = channelPath + "/members";
const nextLink = "https://graph.microsoft.com" + membersPath + "?$skiptoken=second";
const token = [
  "e30",
  Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url"),
  "fixture",
].join(".");
const members = [
  { id: "member-a", userId: "user-a", displayName: "Synthetic Owner", roles: ["owner"] },
  { id: "member-b", userId: "user-b", displayName: "Synthetic Member", roles: [] },
];

type Scenario = "allowed" | "denied" | "sibling" | "retired" | "permission";

// Production message tool, registration/read lifetime, Teams action/runtime,
// SDK token owner, and guarded Graph transport; only wire I/O is replaced.
// This is not live-tenant, TLS, or shipped-package evidence.
async function withRoster(
  scenario: Scenario,
  check: (fixture: {
    read: (accountId?: string) => Promise<unknown>;
    requests: string[];
    tokenRequests: URLSearchParams[];
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "teams-roster-authority" }, async (state) => {
    const requests: string[] = [];
    const tokenRequests: URLSearchParams[] = [];
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ]) {
      vi.stubEnv(key, "");
    }
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir } },
      tools: { allow: ["message"] },
      skills: { load: { watch: false } },
      plugins: { allow: ["msteams"], entries: { msteams: { enabled: true } } },
      channels: {
        msteams: {
          defaultAccount: "support",
          groupPolicy: "allowlist",
          accounts: {
            support: {
              appId: "22222222-2222-2222-2222-222222222222",
              appPassword: "synthetic-support-secret",
              tenantId: "33333333-3333-3333-3333-333333333333",
              teams: { [teamId]: { channels: { [channelId]: {} } } },
            },
            sibling: {
              appId: "44444444-4444-4444-4444-444444444444",
              appPassword: "synthetic-sibling-secret",
              tenantId: "55555555-5555-5555-5555-555555555555",
              teams: {},
            },
          },
        },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg, cfg);
    const fixture = createPluginRegistryFixture(cfg, { allowProcessHomeSessionCatalogs: false });
    registerTestPlugin({
      ...fixture,
      record: createPluginRecord({ id: "msteams", origin: "bundled" }),
      register(api) {
        setMSTeamsRuntime(api.runtime);
        api.registerChannel({ plugin: msteamsPlugin });
      },
    });
    setActivePluginRegistry(fixture.registry.registry);
    const host = await createAgentHarnessHostCapabilitiesForTest({
      pluginId: "roster-proof",
      attempt: {
        config: cfg,
        runId: "roster-" + scenario,
        agentId: "main",
        workspaceDir: state.workspaceDir,
        cwd: state.workspaceDir,
      },
    });
    try {
      let lookups = 0;
      function lookupBoundary(hostname: string, options: { all: true }): Promise<LookupAddress[]>;
      function lookupBoundary(hostname: string): Promise<LookupAddress>;
      async function lookupBoundary(hostname: string, options?: { all: true }) {
        expect(hostname).toBe("graph.microsoft.com");
        lookups++;
        if (scenario === "retired" && lookups === 3) {
          // Host registry lifecycle: retire after page one, before page two I/O.
          setActivePluginRegistry(createEmptyPluginRegistry());
        }
        const address = { address: "93.184.216.34", family: 4 };
        return options?.all ? [address] : address;
      }
      vi.mocked(dnsLookup).mockImplementation(lookupBoundary);
      const fetchBoundary = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin === "https://login.microsoftonline.com") {
          const tenant = "33333333-3333-3333-3333-333333333333";
          const authority = "https://login.microsoftonline.com/" + tenant;
          if (init?.method === "POST" && url.pathname === "/" + tenant + "/oauth2/v2.0/token") {
            if (typeof init.body !== "string") {
              throw new Error("Expected a form-encoded token request body");
            }
            tokenRequests.push(new URLSearchParams(init.body));
            return Response.json({ access_token: token, token_type: "Bearer", expires_in: 3600 });
          }
          if (url.pathname === "/" + tenant + "/v2.0/.well-known/openid-configuration") {
            return Response.json({
              issuer: authority + "/v2.0",
              authorization_endpoint: authority + "/oauth2/v2.0/authorize",
              token_endpoint: authority + "/oauth2/v2.0/token",
              end_session_endpoint: authority + "/oauth2/v2.0/logout",
              jwks_uri: authority + "/discovery/v2.0/keys",
            });
          }
          throw new Error("Unexpected Azure fixture request: " + url.href);
        }
        expect(url.origin).toBe("https://graph.microsoft.com");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer " + token);
        expect(captureChannelReadAuthority()).toBeTypeOf("function");
        requests.push(url.pathname + url.search);
        if (url.pathname === channelPath) {
          return Response.json({
            id: channelId,
            displayName: "Private fixture",
            membershipType: "private",
          });
        }
        if (url.pathname === membersPath && scenario === "permission") {
          return Response.json(
            {
              error: {
                code: "Authorization_RequestDenied",
                message: "Synthetic Graph permission denied",
              },
            },
            { status: 403 },
          );
        }
        if (url.pathname === membersPath && !url.search) {
          return Response.json({ value: [members[0]], "@odata.nextLink": nextLink });
        }
        if (url.href === nextLink) {
          return Response.json({ value: [members[1]] });
        }
        throw new Error("Unexpected Graph fixture request: " + url.href);
      };
      // An unmarked global fetch keeps the real guard on its pinned-DNS path.
      // Undici is the HTTP I/O boundary; retain its real dispatcher constructors.
      vi.stubGlobal("fetch", fetchBoundary);
      // Native DOM and Undici fetch declare distinct but wire-compatible types.
      vi.spyOn(undici, "fetch").mockImplementation(fetchBoundary as unknown as typeof undici.fetch);
      const tools = await host.capabilities.createToolSurfaceAsync!({
        config: cfg,
        agentId: "main",
        workspaceDir: state.workspaceDir,
        agentAccountId: "support",
        messageProvider: "msteams",
        includeToolSearchControls: false,
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: false,
        },
      });
      const message = tools.find((tool) => tool.name === "message");
      if (!message) {
        throw new Error("Production message tool missing");
      }
      await check({
        requests,
        tokenRequests,
        read: (accountId = "support") =>
          message.execute("roster-" + scenario + "-" + accountId, {
            action: "channel-info",
            channel: "msteams",
            teamId,
            channelId: scenario === "denied" ? "19:denied@thread.tacv2" : channelId,
            accountId,
            includeMembers: true,
          }),
      });
    } finally {
      host.close();
      resetPluginRuntimeStateForTest();
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Teams private roster through host read authority", () => {
  it("rejects a denied conversation before token or Graph I/O", async () => {
    await withRoster("denied", async ({ read, requests, tokenRequests }) => {
      await expect(read()).rejects.toThrow("Microsoft Teams read target is not allowed.");
      expect(requests).toEqual([]);
      expect(tokenRequests).toEqual([]);
    });
  });

  it("does not borrow the support account authority or token after a successful read", async () => {
    await withRoster("sibling", async ({ read, requests, tokenRequests }) => {
      await expect(read("support")).resolves.toMatchObject({ details: { membersComplete: true } });
      const authorizedRequests = [...requests];
      const authorizedTokens = [...tokenRequests];
      await expect(read("sibling")).rejects.toThrow("Microsoft Teams read target is not allowed.");
      expect(requests).toEqual(authorizedRequests);
      expect(tokenRequests).toEqual(authorizedTokens);
      expect(tokenRequests[0]?.get("client_id")).toBe("22222222-2222-2222-2222-222222222222");
    });
  });

  it("stops page two after the real registration authority retires between pages", async () => {
    await withRoster("retired", async ({ read, requests }) => {
      await expect(read()).rejects.toThrow("read authority is no longer active");
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(membersPath);
    });
  });

  it("surfaces a Graph permission denial instead of certifying the roster", async () => {
    await withRoster("permission", async ({ read, requests }) => {
      await expect(read()).rejects.toThrow("Synthetic Graph permission denied");
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(membersPath);
    });
  });

  it("returns a complete private roster through real message/runtime/Graph owners", async () => {
    await withRoster("allowed", async ({ read, requests, tokenRequests }) => {
      expect(await read()).toMatchObject({
        details: {
          members,
          membersComplete: true,
          membersScope: { teamId, channelId, membershipType: "private" },
        },
      });
      expect(requests).toHaveLength(3);
      expect(requests.slice(1)).toEqual([membersPath, membersPath + "?$skiptoken=second"]);
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0]?.get("scope")).toBe("https://graph.microsoft.com/.default");
      expect(tokenRequests[0]?.get("client_id")).toBe("22222222-2222-2222-2222-222222222222");
    });
  });
});
