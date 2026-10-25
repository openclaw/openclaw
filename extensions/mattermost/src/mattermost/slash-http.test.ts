import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime-api.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostClient } from "./client.js";
const clientMocks = vi.hoisted(() => ({
  createMattermostClient: vi.fn(),
  fetchMattermostChannel: vi.fn(async () => {
    throw new Error("channel lookup intentionally unavailable in token validation tests");
  }),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createMattermostClient: clientMocks.createMattermostClient,
    fetchMattermostChannel: clientMocks.fetchMattermostChannel,
  };
});

import {
  MATTERMOST_SLASH_POST_METHOD,
  type MattermostCommandResponse,
  type MattermostRegisteredCommand,
  type MattermostSlashCommandPayload,
} from "./slash-commands.js";
import { createSlashCommandHttpHandler } from "./slash-http.js";

function createRequest(body: string, method = "POST") {
  const req = createMockIncomingRequest([body]);
  req.method = method;
  req.headers = { "content-type": "application/x-www-form-urlencoded" };
  return req;
}

const accountFixture: ResolvedMattermostAccount = {
  accountId: "default",
  enabled: true,
  botToken: "bot-token",
  baseUrl: "https://chat.example.com",
  botTokenSource: "config",
  baseUrlSource: "config",
  streamingMode: "partial",
  config: {},
};
const slashCallbackUrl = "https://gateway.example.com/slash";

function createCurrentCommand(
  overrides: Partial<MattermostCommandResponse> = {},
): MattermostCommandResponse {
  return {
    id: "cmd-1",
    token: "valid-token",
    team_id: "t1",
    trigger: "oc_status",
    method: MATTERMOST_SLASH_POST_METHOD,
    url: slashCallbackUrl,
    auto_complete: true,
    delete_at: 0,
    ...overrides,
  };
}

const slashPayload: MattermostSlashCommandPayload = {
  token: "valid-token",
  team_id: "t1",
  channel_id: "c1",
  user_id: "u1",
  command: "/oc_status",
  text: "",
};

let slashTestSequence = 0;
let slashTestAccountId = "";

function createRegisteredCommand(
  overrides: Partial<MattermostRegisteredCommand> = {},
): MattermostRegisteredCommand {
  return {
    id: "cmd-1",
    teamId: "t1",
    trigger: "oc_status",
    token: "valid-token",
    url: slashCallbackUrl,
    managed: false,
    ...overrides,
  };
}

function createCommandLookupClient(params: {
  command?: MattermostCommandResponse | null | (() => MattermostCommandResponse | null);
  commandLookupError?: Error;
  listLookupError?: Error;
  listCommands?: MattermostCommandResponse[];
}): MattermostClient & { requests: string[] } {
  const requests: string[] = [];
  const currentCommand = () =>
    typeof params.command === "function" ? params.command() : params.command;
  return {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "bot-token",
    request: async <T>(path: string) => {
      requests.push(path);
      if (path === "/commands/cmd-1") {
        if (params.commandLookupError) {
          throw params.commandLookupError;
        }
        const command = currentCommand();
        if (command) {
          return command as T;
        }
        throw new Error("not found");
      }
      if (path.startsWith("/commands?team_id=")) {
        if (params.listLookupError) {
          throw params.listLookupError;
        }
        const command = currentCommand();
        return (params.listCommands ?? (command ? [command] : [])) as T;
      }
      throw new Error(`unexpected request path: ${path}`);
    },
    fetchImpl: vi.fn<typeof fetch>(),
    requests,
  };
}

function createHandler(
  registeredCommands: MattermostRegisteredCommand[],
  accountId = accountFixture.accountId,
  log?: (message: string) => void,
) {
  return createSlashCommandHttpHandler({
    account: { ...accountFixture, accountId },
    cfg: {},
    runtime: {} as RuntimeEnv,
    registeredCommands,
    log,
  });
}

async function runSlashRequest(params: {
  registeredCommands?: MattermostRegisteredCommand[];
  body: string;
  method?: string;
}) {
  const handler = createHandler(params.registeredCommands ?? []);
  const req = createRequest(params.body, params.method);
  const response = createMockServerResponse();
  await handler(req, response);
  return response;
}

async function expectTokenValidation(
  client: MattermostClient,
  expected: boolean,
  params: {
    accountId?: string;
    registeredCommand?: MattermostRegisteredCommand;
    log?: (message: string) => void;
  } = {},
) {
  const registeredCommand = params.registeredCommand ?? createRegisteredCommand();
  clientMocks.createMattermostClient.mockReturnValue(client);
  const handler = createHandler(
    [registeredCommand],
    `${slashTestAccountId}:${params.accountId ?? "default"}`,
    params.log,
  );
  const req = createRequest(
    new URLSearchParams(
      Object.entries({ ...slashPayload, token: registeredCommand.token }),
    ).toString(),
  );
  const response = createMockServerResponse();
  let authenticated = false;
  try {
    await handler(req, response);
  } catch (error) {
    if (error instanceof Error && error.message === "Mattermost runtime not initialized") {
      authenticated = true;
    } else {
      throw error;
    }
  }
  expect(authenticated || response.statusCode !== 401).toBe(expected);
}

async function expectValidationLog(client: MattermostClient, expected: boolean, message: string) {
  const log = vi.fn();
  await expectTokenValidation(client, expected, { log });
  expect(log).toHaveBeenCalledExactlyOnceWith(message);
}

describe("slash-http", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    slashTestAccountId = `slash-test-${++slashTestSequence}`;
    accountFixture.accountId = slashTestAccountId;
    clientMocks.createMattermostClient.mockReset();
    clientMocks.fetchMattermostChannel.mockClear();
  });

  it("rejects non-POST methods", async () => {
    const response = await runSlashRequest({ method: "GET", body: "" });
    expect(response).toMatchObject({ statusCode: 405, body: "Method Not Allowed" });
    expect(response.getHeader("allow")).toBe("POST");
  });

  it("rejects a token valid for one command when used against another command", async () => {
    // Cross-command spray DoS guard: a payload pointing at command B with the
    // token for command A must fail at the per-command startup gate, before
    // upstream validation runs and could poison the failure cache for B.
    const response = await runSlashRequest({
      registeredCommands: [
        createRegisteredCommand({ token: "token-status", trigger: "oc_status" }),
        { ...createRegisteredCommand({ token: "token-help", trigger: "oc_help" }), id: "cmd-2" },
      ],
      body: "token=token-status&team_id=t1&channel_id=c1&user_id=u1&command=%2Foc_help&text=",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Unauthorized: invalid command token.");
  });

  it("rate-limits sequential current-command lookups without caching successes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T00:00:00Z"));
    const client = createCommandLookupClient({ command: createCurrentCommand() });
    const log = vi.fn();

    for (let i = 0; i < 20; i += 1) {
      await expectTokenValidation(client, true, { log });
    }
    await expectTokenValidation(client, false, { log });

    expect(client.requests).toHaveLength(20);
    expect(log).toHaveBeenCalledWith(
      "mattermost: slash command validation lookup rate-limited for /oc_status",
    );

    vi.setSystemTime(Date.now() + 500);
    await expectTokenValidation(client, true, { log });
    await expectTokenValidation(client, false, { log });
    expect(client.requests).toHaveLength(21);
  });

  it("rechecks matching current commands so startup tokens are not accepted after rotation", async () => {
    let command = createCurrentCommand();
    const client = createCommandLookupClient({ command: () => command });

    await expectTokenValidation(client, true);
    command = { ...command, token: "new-token" };
    await expectTokenValidation(client, false);

    expect(client.requests).toEqual(["/commands/cmd-1", "/commands/cmd-1"]);
  });

  it("briefly caches failed current command validation without accepting stale tokens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T00:00:00Z"));
    const registeredCommand = createRegisteredCommand({ token: "old-token" });
    const client = createCommandLookupClient({
      command: createCurrentCommand({ token: "new-token" }),
    });

    await expectTokenValidation(client, false, { registeredCommand });
    await expectTokenValidation(client, false, { registeredCommand });
    expect(client.requests).toEqual(["/commands/cmd-1"]);

    vi.setSystemTime(Date.now() + 5_000);
    await expectTokenValidation(client, false, { registeredCommand });
    expect(client.requests).toEqual(["/commands/cmd-1", "/commands/cmd-1"]);
  });

  it("logs when command lookup by id returns a deleted command before fallback", async () => {
    const client = createCommandLookupClient({
      command: createCurrentCommand({ id: "private-upstream-command-id", delete_at: 123 }),
      listCommands: [],
    });
    await expectValidationLog(
      client,
      false,
      "mattermost: slash command lookup by id returned deleted command for /oc_status; using team list fallback",
    );
  });

  it("rejects current commands with a mismatched method or callback URL", async () => {
    for (const [index, command] of [
      createCurrentCommand({ method: "G" }),
      createCurrentCommand({ url: "https://gateway.example.com/other" }),
    ].entries()) {
      const client = createCommandLookupClient({ command });

      await expectTokenValidation(client, false, { accountId: `default-${index}` });
    }
  });

  it("logs only the lookup status when falling back to the team command list", async () => {
    const client = createCommandLookupClient({
      commandLookupError: new Error(
        "Mattermost API 404 Not Found: private-message token=secret-token https://user:pass@chat.example.com/api?access_token=secret-access&client_secret=secret-client",
      ),
      listCommands: [createCurrentCommand()],
    });
    await expectValidationLog(
      client,
      true,
      "mattermost: slash command lookup by id failed for /oc_status; using team list fallback (status=404)",
    );
    expect(client.requests).toEqual(["/commands/cmd-1", "/commands?team_id=t1&custom_only=true"]);
  });

  it("retains both failure statuses without upstream error content", async () => {
    const client = createCommandLookupClient({
      commandLookupError: new Error(
        "Mattermost API 404 Not Found: private-message token=secret-token",
      ),
      listLookupError: new Error(
        "Mattermost API 503 Unavailable: private-message botToken: secret-bot https://user:pass@chat.example.com/hooks?token=secret-query",
      ),
    });
    await expectValidationLog(
      client,
      false,
      "mattermost: slash command registration check failed for /oc_status (status=503); command lookup status=404",
    );
    expect(client.requests).toEqual(["/commands/cmd-1", "/commands?team_id=t1&custom_only=true"]);
  });

  it("omits arbitrary non-provider failure prose", async () => {
    const client = createCommandLookupClient({
      commandLookupError: new Error("primary failure"),
      listLookupError: new Error("private-message 😀 token=secret-token"),
    });
    await expectValidationLog(
      client,
      false,
      "mattermost: slash command registration check failed for /oc_status (status=unknown); command lookup status=unknown",
    );
  });
});
