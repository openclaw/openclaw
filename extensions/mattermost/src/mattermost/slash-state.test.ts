import { EventEmitter } from "node:events";
import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { createMockIncomingRequest, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostRegisteredCommand } from "./slash-commands.js";
import {
  activateSlashCommands,
  deactivateSlashCommands,
  getSlashCommandState,
  registerSlashCommandRoute,
} from "./slash-state.js";

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return { ...actual, safeEqualSecret: vi.fn(actual.safeEqualSecret) };
});

function createResolvedMattermostAccount(accountId: string): ResolvedMattermostAccount {
  return {
    accountId,
    enabled: true,
    botTokenSource: "config",
    baseUrlSource: "config",
    streamingMode: "partial",
    config: {},
  };
}

function createRegisteredCommand(
  overrides: Partial<MattermostRegisteredCommand> = {},
): MattermostRegisteredCommand {
  return {
    id: "cmd-1",
    teamId: "team-1",
    trigger: "oc_status",
    token: "token-1",
    url: "https://gateway.example.com/slash",
    managed: false,
    ...overrides,
  };
}

const slashApi = {
  cfg: {},
  runtime: { log() {}, error() {}, exit() {} },
} satisfies Parameters<typeof activateSlashCommands>[0]["api"];

function createRequest(body: string, authorization?: string): IncomingMessage {
  const req = createMockIncomingRequest([body]);
  req.method = "POST";
  req.headers = { "content-type": "application/x-www-form-urlencoded", authorization };
  return req;
}

function createStalledRequest(remoteAddress: string, authorization?: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.headers = { "content-type": "application/x-www-form-urlencoded", authorization };
  Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddress });
  return req;
}

function createResponse(): { res: ServerResponse; getBody: () => string } {
  let body = "";
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader() {},
    removeHeader() {},
    end(chunk?: string | Buffer, callback?: () => void) {
      body = chunk ? String(chunk) : "";
      callback?.();
    },
  }) as unknown as ServerResponse;
  return { res, getBody: () => body };
}

function createSlashRoute(register = registerSlashCommandRoute) {
  let routeHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  const warn = vi.fn();
  register({
    config: { channels: { mattermost: {} } },
    logger: { warn },
    registerHttpRoute(route: {
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    }) {
      routeHandler = route.handler;
    },
  } as never);
  if (!routeHandler) {
    throw new Error("expected Mattermost slash route registration");
  }
  return { handler: routeHandler, warn };
}

async function routeSlashRequest(params: {
  body: string;
  authorization?: string;
  register?: typeof registerSlashCommandRoute;
}): Promise<{ statusCode: number; body: string; warn: ReturnType<typeof vi.fn> }> {
  const { handler, warn } = createSlashRoute(params.register);
  const response = createResponse();
  await handler(createRequest(params.body, params.authorization), response.res);
  return { statusCode: response.res.statusCode, body: response.getBody(), warn };
}

function activate(
  accountId: string,
  tokens: string[],
  commands: MattermostRegisteredCommand[] = [],
  stubHandler = true,
): void {
  activateSlashCommands({
    account: createResolvedMattermostAccount(accountId),
    registeredCommands:
      commands.length > 0
        ? commands
        : tokens.map((token, index) => createRegisteredCommand({ id: `cmd-${index}`, token })),
    api: slashApi,
  });
  if (stubHandler) {
    const state = getSlashCommandState(accountId);
    if (!state) {
      throw new Error(`expected Mattermost slash state for ${accountId}`);
    }
    state.handler = async (_req, res) => {
      res.statusCode = 200;
      res.end(accountId);
    };
  }
}

async function expectIsolatedCapacity(fullToken: string, otherToken: string) {
  const { handler } = createSlashRoute();
  const requests = Array.from({ length: 8 }, (_, index) =>
    createStalledRequest(`203.0.113.${index + 1}`, `Token ${fullToken}`),
  );
  const responses = requests.map(() => createResponse());
  const runs = requests.map((req, index) => handler(req, responses[index]!.res));
  const overflow = createResponse();
  await handler(createRequest("", `Token ${fullToken}`), overflow.res);
  const other = createStalledRequest("203.0.113.20", `Token ${otherToken}`);
  const otherResponse = createResponse();
  const otherRun = handler(other, otherResponse.res);
  try {
    expect(overflow.res.statusCode).toBe(429);
    expect(otherResponse.res.statusCode).toBe(200);
  } finally {
    for (const req of [...requests, other]) {
      req.complete = true;
      req.push(null);
    }
    await Promise.all([...runs, otherRun]);
  }
}

afterEach(() => {
  deactivateSlashCommands();
  vi.mocked(safeEqualSecret).mockClear();
});

describe("slash-state", () => {
  it("preserves slash routing state across module reloads", async () => {
    activate("a1", ["tok-reload"]);
    activate("a2", ["tok-other"]);

    vi.resetModules();
    const reloaded = await import("./slash-state.js");
    const result = await routeSlashRequest({
      register: reloaded.registerSlashCommandRoute,
      body: "token=tok-reload",
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("a1");
  });
  it("accepts the Token scheme case-insensitively and compares every known token", async () => {
    activate("a1", ["tok-a", "tok-a-alt"]);
    activate("a2", ["tok-b"]);

    const matched = await routeSlashRequest({
      body: "token=tok-a",
      authorization: "tOkEn tok-a",
    });

    expect(matched.statusCode).toBe(200);
    expect(vi.mocked(safeEqualSecret).mock.calls).toEqual([
      ["tok-a", "tok-a"],
      ["tok-a", "tok-a-alt"],
      ["tok-a", "tok-b"],
    ]);

    for (const authorization of [
      "Bearer tok-a",
      "Token tok-a extra",
      "Token tok-a,Token tok-b",
      "garbage",
    ]) {
      vi.mocked(safeEqualSecret).mockClear();
      const ignored = await routeSlashRequest({ body: "token=tok-a", authorization });
      expect(ignored.statusCode).toBe(200);
      expect(safeEqualSecret).not.toHaveBeenCalled();
    }
  });

  it("isolates distinct credentials across accounts", async () => {
    activate("a1", ["tok-a"]);
    activate("a2", ["tok-b"]);
    await expectIsolatedCapacity("tok-a", "tok-b");
  });

  it("collapses duplicate credentials without merging distinct duplicate groups", async () => {
    activate("a1", ["tok-a", "tok-shared", "tok-shared-other"]);
    activate("a2", ["tok-shared", "tok-shared-other"]);
    await expectIsolatedCapacity("tok-shared", "tok-shared-other");
  });

  it.each([
    {
      name: "token match",
      body: "token=token-1",
      status: 400,
      message: "Invalid slash command payload.",
    },
    {
      name: "registered command match",
      body: "token=rotated&team_id=team-1&channel_id=c1&user_id=u1&command=%2Foc_status&text=",
      status: 401,
      message: "Unauthorized: invalid command token.",
    },
  ])("keeps real multi-account $name requests in account validation", async (testCase) => {
    activate("a1", ["token-1"], [createRegisteredCommand()], false);
    activate(
      "a2",
      ["token-2"],
      [createRegisteredCommand({ id: "cmd-2", teamId: "team-2", token: "token-2" })],
      false,
    );
    const route = createSlashRoute();
    await withServer(
      (req, res) => {
        void route.handler(req, res).catch((error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/slash`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: testCase.body,
        });
        expect(response.status).toBe(testCase.status);
        expect(await response.json()).toEqual({
          response_type: "ephemeral",
          text: testCase.message,
        });
      },
    );
  });

  it("rejects a token shared by multiple accounts", async () => {
    activate("a1", ["tok-shared"]);
    activate("a2", ["tok-shared"]);

    const result = await routeSlashRequest({ body: "token=tok-shared" });

    expect(result.statusCode).toBe(409);
    expect(result.body).toContain("command token is not unique");
    expect(result.warn).toHaveBeenCalledWith(
      "mattermost: slash callback matched multiple accounts via token (a1, a2)",
    );
  });

  it("rejects a registered team and command shared by multiple accounts", async () => {
    activate("a1", ["tok-a"], [createRegisteredCommand({ id: "cmd-a" })]);
    activate("a2", ["tok-b"], [createRegisteredCommand({ id: "cmd-b" })]);

    const result = await routeSlashRequest({
      body: "token=rotated&team_id=team-1&channel_id=c1&user_id=u1&command=%2Foc_status&text=",
    });

    expect(result.statusCode).toBe(409);
    expect(result.body).toContain("slash command is not unique");
    expect(result.warn).toHaveBeenCalledWith(
      "mattermost: slash callback matched multiple accounts via command (a1, a2)",
    );
  });
});
