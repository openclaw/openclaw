// Mattermost slash command pairing-queue coverage.
//
// The review input scanner refuses the base version of `slash-http.test.ts` because that
// pre-existing file carries synthetic credential-shaped error fixtures unrelated to this
// fix. Keeping this pairing-queue coverage in its own file keeps this PR's diff off that
// file while still driving the same real handler boundary.
import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  createPluginRuntimeMock,
  expectPairingReplyText,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { buildPairingReply } from "openclaw/plugin-sdk/conversation-runtime";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../../runtime-api.js";
import { setMattermostRuntime } from "../runtime.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostChannel, MattermostClient } from "./client.js";
import { MATTERMOST_PAIRING_QUEUE_FULL_TEXT } from "./monitor-auth.js";

const clientMocks = vi.hoisted(() => ({
  createMattermostClient: vi.fn(),
  fetchMattermostChannel: vi.fn<() => Promise<MattermostChannel>>(async () => {
    throw new Error("channel lookup intentionally unavailable in pairing-queue tests");
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

function createRequest(params: { body?: string }): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.headers = { "content-type": "application/x-www-form-urlencoded" };
  process.nextTick(() => {
    if (params.body) {
      req.push(Buffer.from(params.body));
    }
    req.complete = true;
    req.push(null);
  });
  return req;
}

function createResponse(): { res: ServerResponse; getBody: () => string } {
  let body = "";
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk?: string | Buffer) {
      body = chunk ? String(chunk) : "";
    },
  } as unknown as ServerResponse;
  return { res, getBody: () => body };
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

function createSlashPayload(): MattermostSlashCommandPayload {
  return {
    token: "valid-token",
    team_id: "t1",
    channel_id: "c1",
    user_id: "u1",
    command: "/oc_status",
    text: "",
  };
}

function createRegisteredCommand(): MattermostRegisteredCommand {
  return {
    id: "cmd-1",
    teamId: "t1",
    trigger: "oc_status",
    token: "valid-token",
    url: slashCallbackUrl,
    managed: false,
  };
}

function createCommandLookupClient(params: {
  command: MattermostCommandResponse;
}): MattermostClient {
  return {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "bot-token",
    request: async <T>(path: string) => {
      if (path === "/commands/cmd-1") {
        return params.command as T;
      }
      if (path.startsWith("/commands?team_id=")) {
        return [params.command] as T;
      }
      throw new Error(`unexpected request path: ${path}`);
    },
    fetchImpl: vi.fn<typeof fetch>(),
  };
}

async function runSlashRequest(params: {
  registeredCommands: MattermostRegisteredCommand[];
  body: string;
}) {
  const handler = createSlashCommandHttpHandler({
    account: accountFixture,
    cfg: {} as OpenClawConfig,
    runtime: {} as RuntimeEnv,
    registeredCommands: params.registeredCommands,
  });
  const req = createRequest({ body: params.body });
  const response = createResponse();
  await handler(req, response.res);
  return response;
}

it.each([
  { code: "PAIR1234", pairing: true },
  { code: "", pairing: false },
])("answers a DM pairing slash command with code=$code", async ({ code, pairing }) => {
  vi.clearAllMocks();
  const runtime = createPluginRuntimeMock();
  vi.mocked(runtime.channel.pairing.upsertPairingRequest).mockResolvedValue({
    code,
    created: false,
  });
  vi.mocked(runtime.channel.pairing.buildPairingReply).mockImplementation(buildPairingReply);
  setMattermostRuntime(runtime);
  clientMocks.createMattermostClient.mockReturnValue(
    createCommandLookupClient({ command: createCurrentCommand() }),
  );
  clientMocks.fetchMattermostChannel.mockResolvedValueOnce({ id: "c1", type: "D" });

  const response = await runSlashRequest({
    registeredCommands: [createRegisteredCommand()],
    body: new URLSearchParams(Object.entries(createSlashPayload())).toString(),
  });

  expect(response.res.statusCode).toBe(200);
  const { text } = JSON.parse(response.getBody()) as { text: string };
  if (pairing) {
    expectPairingReplyText(text, {
      channel: "mattermost",
      idLine: "Your Mattermost user id: u1",
      code,
    });
  } else {
    expect(text).toBe(MATTERMOST_PAIRING_QUEUE_FULL_TEXT);
  }
});
