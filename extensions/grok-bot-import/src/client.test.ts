import * as network from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokBotClient } from "./client.js";

const recipe = {
  profile: {
    name: "Research Bot",
    description: "Use primary evidence.",
    avatarColor: "#9159FE",
    avatarShape: "hex",
  },
  memory: [],
  skills: [
    { name: "research", description: "Research a topic", content: "Read the source and cite it." },
  ],
  routines: [],
  plugins: [],
};
afterEach(() => vi.restoreAllMocks());
describe("Grok canonical template retrieval", () => {
  it("downloads the full recipe and keeps account auth off the signed blob request", async () => {
    const calls: Parameters<typeof network.fetchWithSsrFGuard>[0][] = [];
    vi.spyOn(network, "fetchWithSsrFGuard").mockImplementation(async (request) => {
      calls.push(request);
      return {
        response: Response.json(
          calls.length === 1
            ? {
                template: { id: "template-one" },
                blobGetUrl: "https://public.example/recipe.json?signature=test",
              }
            : recipe,
        ),
        release: async () => {},
        finalUrl: request.url,
      };
    });
    const result = await new GrokBotClient("test-session").readSharedBot(
      "https://x.ai/bot/known-share-id",
    );
    expect(result.skills[0]?.content).toBe("Read the source and cite it.");
    expect(calls[0]?.url).toBe(
      "https://api2.cursor.sh/aiserver.v1.GrokBotService/GetGrokBotTemplateImportDetails",
    );
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ shareId: "known-share-id" }));
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer test-session");
    expect(new Headers(calls[1]?.init?.headers).has("authorization")).toBe(false);
  });
  it("does not substitute a preview when a recipe is inaccessible", async () => {
    vi.spyOn(network, "fetchWithSsrFGuard").mockResolvedValue({
      response: new Response(null, { status: 401 }),
      release: async () => {},
      finalUrl: "https://api2.cursor.sh",
    });
    await expect(
      new GrokBotClient("test-session").readSharedBot("https://x.ai/bot/share-id"),
    ).rejects.toThrow(/Sign in/);
  });
});

it("selects owned bots, excluding rooms and teammates' bots, and rejects a truncated roster", async () => {
  const fetch = vi.spyOn(network, "fetchWithSsrFGuard");
  const row = {
    id: "server-id",
    agentId: "hosted-id",
    name: "Research",
    kind: "GROK_BOT_AGENT_KIND_AGENT",
    visibility: "GROK_BOT_AGENT_VISIBILITY_OWNER",
  };
  fetch.mockResolvedValueOnce({
    response: Response.json({
      agents: [
        row,
        { ...row, kind: "GROK_BOT_AGENT_KIND_ROOM" },
        { ...row, visibility: "GROK_BOT_AGENT_VISIBILITY_TEAM" },
        { ...row, viewerIsOwner: false },
      ],
    }),
    release: async () => {},
    finalUrl: "https://api2.cursor.sh",
  });
  expect(await new GrokBotClient("test").listBots()).toEqual([
    { id: "server-id", agentId: "hosted-id", name: "Research" },
  ]);
  fetch.mockResolvedValueOnce({
    response: Response.json({ agents: [row], truncated: true }),
    release: async () => {},
    finalUrl: "https://api2.cursor.sh",
  });
  await expect(new GrokBotClient("test").listBots()).rejects.toThrow("incomplete bot roster");
});

it("downloads a hosted photo without account headers and fails if the photo is unavailable", async () => {
  vi.spyOn(network, "fetchWithSsrFGuard").mockImplementation(async (request) => ({
    response: Response.json({}),
    release: async () => {},
    finalUrl: request.url,
  }));
  const media = await import("openclaw/plugin-sdk/media-runtime");
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA9sAAAAASUVORK5CYII=",
    "base64",
  );
  const fetchPhoto = vi
    .spyOn(media, "fetchRemoteMedia")
    .mockResolvedValueOnce({ buffer: bytes, contentType: "image/png" })
    .mockRejectedValueOnce(new Error("Avatar download is unavailable."));
  const bot = {
    id: "server-id",
    agentId: "hosted-id",
    name: "Photo bot",
    avatarUrl: "https://public.example/avatar.png?signature=synthetic",
  };
  const client = new GrokBotClient("synthetic-account-token");
  const imported = await client.readBot(bot);
  expect(imported.avatarImage).toEqual({ bytes, extension: "png" });
  expect(fetchPhoto).toHaveBeenCalledExactlyOnceWith({
    url: bot.avatarUrl,
    maxBytes: 1024 * 1024,
    requireHttps: true,
    maxRedirects: 0,
    timeoutMs: 30_000,
  });
  await expect(client.readBot(bot)).rejects.toThrow("Avatar download is unavailable.");
});

describe("personal Grok Bot owner reads", () => {
  const bot = {
    id: "server-id",
    agentId: "runtime-id",
    name: "Research Bot",
    description: "Use primary evidence.",
  };

  function mockOwnerReads(replies: Record<string, unknown>) {
    return vi.spyOn(network, "fetchWithSsrFGuard").mockImplementation(async (request) => {
      const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
      return {
        response: Object.hasOwn(replies, method)
          ? Response.json(replies[method])
          : new Response("Only owners or managers of a Team Bot may read shared memories.", {
              status: 403,
            }),
        release: async () => {},
        finalUrl: request.url,
      };
    });
  }

  it("reads owned skills, routines, and known integrations without calling the team-memory API", async () => {
    const automation = JSON.stringify({
      name: "Daily research",
      prompt: "Research public sources.",
      schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
      isEnabled: true,
    });
    const fetch = mockOwnerReads({
      ListGrokBotAgentSkills: {
        skills: [
          { name: "Research", description: "Find evidence.", body: "Read primary sources." },
        ],
      },
      ListGrokBotAgentAutomations: {
        automations: [{ automationId: "daily-research", recordJson: automation }],
      },
      GetGrokBotAgentPlugins: {
        plugins: [{ displayName: "Example mail", description: "Read mail.", pluginId: "mail-id" }],
      },
    });
    const result = await new GrokBotClient("synthetic-account-token").readBot(bot);
    expect(result.skills).toEqual([
      { name: "Research", description: "Find evidence.", content: "Read primary sources." },
    ]);
    expect(result.routines).toMatchObject([
      { name: "daily-research", slug: "daily-research", content: automation },
    ]);
    expect(result.plugins).toEqual([
      { name: "Example mail", description: "Read mail.", pluginId: "mail-id" },
    ]);
    expect(result.memory).toEqual([]);
    expect(result.sourceLimitations?.map(({ code }) => code)).toEqual([
      "source_memory_unavailable",
      "source_integration_requirements_unavailable",
    ]);
    expect(
      fetch.mock.calls.map(([request]) => ({
        method: new URL(request.url).pathname.split("/").at(-1),
        body: request.init?.body,
      })),
    ).toEqual([
      { method: "ListGrokBotAgentSkills", body: JSON.stringify({ agentId: "runtime-id" }) },
      { method: "ListGrokBotAgentAutomations", body: JSON.stringify({ agentId: "runtime-id" }) },
      {
        method: "GetGrokBotAgentPlugins",
        body: JSON.stringify({ agentId: "runtime-id", includeMcpConfig: false }),
      },
    ]);
  });

  it.each([
    {
      label: "unavailable integration metadata",
      plugins: { serviceAccountsEnabled: false },
    },
    {
      label: "an explicitly empty integration list",
      plugins: { plugins: [] },
    },
  ])("reports unknown memory and original requirements with $label", async ({ plugins }) => {
    mockOwnerReads({
      ListGrokBotAgentSkills: {},
      ListGrokBotAgentAutomations: {},
      GetGrokBotAgentPlugins: plugins,
    });
    const result = await new GrokBotClient("synthetic-account-token").readBot(bot);
    expect(result.memory).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.routines).toEqual([]);
    expect(result.plugins).toEqual([]);
    expect(result.sourceLimitations?.map(({ code }) => code)).toEqual([
      "source_memory_unavailable",
      "source_integration_requirements_unavailable",
    ]);
  });
});
