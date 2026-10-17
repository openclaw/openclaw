import { expect, it, vi } from "vitest";
import { createMattermostClient, type MattermostClient } from "./client.js";
import {
  MATTERMOST_SLASH_POST_METHOD,
  parseSlashCommandPayload,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveCommandText,
  resolveSlashCommandConfig,
  type MattermostCommandResponse,
} from "./slash-commands.js";

const fetchFixture = vi.hoisted((): { current: typeof fetch } => ({
  current: vi.fn<typeof fetch>(),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      params.beforeRequest?.();
      return {
        response: await fetchFixture.current(params.url, params.init),
        release: async () => {},
      };
    },
  };
});

const command = (overrides: Partial<MattermostCommandResponse> = {}) => ({
  id: "cmd-1",
  token: "tok-1",
  team_id: "team-1",
  creator_id: "bot-user",
  trigger: "oc_status",
  method: "P",
  url: "http://gateway/callback",
  auto_complete: true,
  ...overrides,
});

function commandRequests(
  existing: MattermostCommandResponse[],
  mutate?: (path: string, init?: RequestInit) => unknown,
) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/commands?team_id=")) {
      return existing;
    }
    if (mutate) {
      return mutate(path, init);
    }
    throw new Error(`unexpected request path: ${path}`);
  });
}

const registration = { trigger: "oc_status", teamId: "team-1", url: "http://gateway/callback" };
const registeredCommand = (id: string, token: string, managed: boolean) => ({
  id,
  token,
  managed,
  ...registration,
});

async function registerSingleStatusCommand(
  requestImpl: (path: string, init?: RequestInit) => Promise<unknown>,
  description = "status",
) {
  const client: MattermostClient = {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "bot-token",
    request: async <T>(path: string, init?: RequestInit) => (await requestImpl(path, init)) as T,
    fetchImpl: vi.fn<typeof fetch>(),
  };
  return registerSlashCommands({
    client,
    teamId: "team-1",
    creatorUserId: "bot-user",
    callbackUrl: "http://gateway/callback",
    commands: [{ trigger: "oc_status", description, autoComplete: true }],
  });
}

it("parses application/json payloads", () => {
  const payload = parseSlashCommandPayload(
    JSON.stringify({
      token: "t2",
      team_id: "team",
      channel_id: "ch2",
      user_id: "u2",
      command: "/oc_model",
      text: "gpt-5",
    }),
    "application/json; charset=utf-8",
  );
  expect(payload).toEqual({
    token: "t2",
    team_id: "team",
    team_domain: undefined,
    channel_id: "ch2",
    channel_name: undefined,
    user_id: "u2",
    user_name: undefined,
    command: "/oc_model",
    text: "gpt-5",
    trigger_id: undefined,
    response_url: undefined,
  });
});

it("returns null for malformed payloads missing required fields", () => {
  const payload = parseSlashCommandPayload(
    JSON.stringify({ token: "t3", command: "/oc_help" }),
    "application/json",
  );
  expect(payload).toBeNull();
});

it("resolves command text with trigger map fallback", () => {
  const triggerMap = new Map<string, string>([["oc_status", "status"]]);
  expect(resolveCommandText("oc_status", "   ", triggerMap)).toBe("/status");
  expect(resolveCommandText("oc_status", " now ", triggerMap)).toBe("/status now");
  expect(resolveCommandText("oc_models", " openai ", undefined)).toBe("/models openai");
  expect(resolveCommandText("oc_help", "", undefined)).toBe("/help");
});

it("falls back to localhost callback URL for wildcard bind hosts", () => {
  const config = resolveSlashCommandConfig({ callbackPath: "api/channels/mattermost/command" });
  const callbackUrl = resolveCallbackUrl({
    config,
    gatewayPort: 18789,
    gatewayHost: "0.0.0.0",
  });
  expect(callbackUrl).toBe("http://localhost:18789/api/channels/mattermost/command");
});

it("reuses existing command when trigger already points to callback URL", async () => {
  const request = commandRequests([command()]);
  const result = await registerSingleStatusCommand(request);

  expect(result).toMatchObject([{ managed: false, id: "cmd-1" }]);
  expect(request).toHaveBeenCalledTimes(1);
});

it("truncates command descriptions to Mattermost's UTF-8 byte limit", async () => {
  const description = `${"x".repeat(127)}😀 trailing`;
  const request = commandRequests([], (path, init) => {
    if (path === "/commands" && init?.method === "POST") {
      const body = JSON.parse(typeof init.body === "string" ? init.body : "{}");
      expect(body.description).toBe("x".repeat(127));
      expect(body.auto_complete_desc).toBe("x".repeat(127));
      expect(Buffer.byteLength(body.description, "utf8")).toBeLessThanOrEqual(128);
      return command();
    }
    throw new Error(`unexpected request path: ${path}`);
  });

  const result = await registerSingleStatusCommand(request, description);

  expect(result).toHaveLength(1);
  expect(request).toHaveBeenCalledTimes(2);
});

it("skips foreign command trigger collisions instead of mutating non-owned commands", async () => {
  const request = commandRequests([
    command({
      id: "cmd-foreign-1",
      token: "tok-foreign-1",
      creator_id: "another-bot-user",
      url: "http://foreign/callback",
    }),
  ]);
  const result = await registerSingleStatusCommand(request);

  expect(result).toHaveLength(0);
  expect(request).toHaveBeenCalledTimes(1);
});

it("updates owned commands when callback method drifts from POST", async () => {
  const request = commandRequests([command({ token: "tok-old", method: "G" })], (path, init) => {
    if (path === "/commands/cmd-1" && init?.method === "PUT") {
      expect(JSON.parse(typeof init.body === "string" ? init.body : "{}")).toEqual({
        id: "cmd-1",
        team_id: "team-1",
        trigger: "oc_status",
        method: MATTERMOST_SLASH_POST_METHOD,
        url: "http://gateway/callback",
        description: "status",
        auto_complete: true,
        auto_complete_desc: "status",
        auto_complete_hint: undefined,
      });
      return command({ token: "tok-updated" });
    }
    throw new Error(`unexpected request path: ${path}`);
  });
  const result = await registerSingleStatusCommand(request);

  expect(result).toEqual([registeredCommand("cmd-1", "tok-updated", false)]);
  expect(request).toHaveBeenCalledTimes(2);
});

it("recreates a drifted command when its accepted delete body cannot be read", async () => {
  const calls: string[] = [];
  fetchFixture.current = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.replace("https://chat.example.com/api/v4", "")}`);
    if (method === "GET") {
      return Response.json([command({ token: "tok-old", method: "G" })]);
    }
    if (method === "PUT") {
      return Response.json({ message: "update rejected" }, { status: 500 });
    }
    if (method === "DELETE") {
      // Mattermost already deleted the command; its 200 {"status":"OK"} body is lost.
      const body = new ReadableStream<Uint8Array>({
        pull() {
          throw new TypeError("terminated");
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    return Response.json(command({ id: "cmd-2", token: "tok-new" }), { status: 201 });
  });
  const client = createMattermostClient({
    baseUrl: "https://chat.example.com",
    botToken: "bot-token",
  });

  const result = await registerSlashCommands({
    client,
    teamId: "team-1",
    creatorUserId: "bot-user",
    callbackUrl: "http://gateway/callback",
    commands: [{ trigger: "oc_status", description: "status", autoComplete: true }],
  });

  expect(calls).toEqual([
    "GET /commands?team_id=team-1&custom_only=true",
    "PUT /commands/cmd-1",
    "DELETE /commands/cmd-1",
    "POST /commands",
  ]);
  expect(result).toEqual([registeredCommand("cmd-2", "tok-new", true)]);
});
