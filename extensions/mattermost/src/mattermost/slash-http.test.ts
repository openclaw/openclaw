import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk/mattermost";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ResolvedMattermostAccount } from "./accounts.js";
import { createSlashCommandHttpHandler } from "./slash-http.js";

function createRequest(params: {
  method?: string;
  body?: string;
  contentType?: string;
}): IncomingMessage {
  const req = new PassThrough();
  const incoming = req as unknown as IncomingMessage;
  incoming.method = params.method ?? "POST";
  incoming.headers = {
    "content-type": params.contentType ?? "application/x-www-form-urlencoded",
  };
  process.nextTick(() => {
    if (params.body) {
      req.write(params.body);
    }
    req.end();
  });
  return incoming;
}

function createResponse(): {
  res: ServerResponse;
  getBody: () => string;
  getHeaders: () => Map<string, string>;
} {
  let body = "";
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: string | Buffer) {
      body = chunk ? String(chunk) : "";
    },
  } as unknown as ServerResponse;
  return {
    res,
    getBody: () => body,
    getHeaders: () => headers,
  };
}

const accountFixture: ResolvedMattermostAccount = {
  accountId: "default",
  enabled: true,
  botToken: "bot-token",
  baseUrl: "https://chat.example.com",
  botTokenSource: "config",
  baseUrlSource: "config",
  config: {},
};

describe("slash-http", () => {
  it("rejects non-POST methods", async () => {
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      commandTokens: new Set(["valid-token"]),
    });
    const req = createRequest({ method: "GET", body: "" });
    const response = createResponse();

    await handler(req, response.res);

    expect(response.res.statusCode).toBe(405);
    expect(response.getBody()).toBe("Method Not Allowed");
    expect(response.getHeaders().get("allow")).toBe("POST");
  });

  it("rejects malformed payloads", async () => {
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      commandTokens: new Set(["valid-token"]),
    });
    const req = createRequest({ body: "token=abc&command=%2Foc_status" });
    const response = createResponse();

    await handler(req, response.res);

    expect(response.res.statusCode).toBe(400);
    expect(response.getBody()).toContain("Invalid slash command payload");
  });

  it("fails closed when no command tokens are registered", async () => {
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      commandTokens: new Set<string>(),
    });
    const req = createRequest({
      body: "token=tok1&team_id=t1&channel_id=c1&user_id=u1&command=%2Foc_status&text=",
    });
    const response = createResponse();

    await handler(req, response.res);

    expect(response.res.statusCode).toBe(401);
    expect(response.getBody()).toContain("Unauthorized: invalid command token.");
  });

  it("rejects unknown command tokens", async () => {
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      commandTokens: new Set(["known-token"]),
    });
    const req = createRequest({
      body: "token=unknown&team_id=t1&channel_id=c1&user_id=u1&command=%2Foc_status&text=",
    });
    const response = createResponse();

    await handler(req, response.res);

    expect(response.res.statusCode).toBe(401);
    expect(response.getBody()).toContain("Unauthorized: invalid command token.");
  });
});
