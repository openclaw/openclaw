import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createSlashCommandHttpHandler } from "./slash-http.js";
function createRequest(params) {
  const req = new PassThrough();
  const incoming = req;
  incoming.method = params.method ?? "POST";
  incoming.headers = {
    "content-type": params.contentType ?? "application/x-www-form-urlencoded"
  };
  process.nextTick(() => {
    if (params.body) {
      req.write(params.body);
    }
    req.end();
  });
  return incoming;
}
function createResponse() {
  let body = "";
  const headers = /* @__PURE__ */ new Map();
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk) {
      body = chunk ? String(chunk) : "";
    }
  };
  return {
    res,
    getBody: () => body,
    getHeaders: () => headers
  };
}
const accountFixture = {
  accountId: "default",
  enabled: true,
  botToken: "bot-token",
  baseUrl: "https://chat.example.com",
  botTokenSource: "config",
  baseUrlSource: "config",
  config: {}
};
async function runSlashRequest(params) {
  const handler = createSlashCommandHttpHandler({
    account: accountFixture,
    cfg: {},
    runtime: {},
    commandTokens: params.commandTokens
  });
  const req = createRequest({ method: params.method, body: params.body });
  const response = createResponse();
  await handler(req, response.res);
  return response;
}
describe("slash-http", () => {
  it("rejects non-POST methods", async () => {
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {},
      runtime: {},
      commandTokens: /* @__PURE__ */ new Set(["valid-token"])
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
      cfg: {},
      runtime: {},
      commandTokens: /* @__PURE__ */ new Set(["valid-token"])
    });
    const req = createRequest({ body: "token=abc&command=%2Foc_status" });
    const response = createResponse();
    await handler(req, response.res);
    expect(response.res.statusCode).toBe(400);
    expect(response.getBody()).toContain("Invalid slash command payload");
  });
  it("fails closed when no command tokens are registered", async () => {
    const response = await runSlashRequest({
      commandTokens: /* @__PURE__ */ new Set(),
      body: "token=tok1&team_id=t1&channel_id=c1&user_id=u1&command=%2Foc_status&text="
    });
    expect(response.res.statusCode).toBe(401);
    expect(response.getBody()).toContain("Unauthorized: invalid command token.");
  });
  it("rejects unknown command tokens", async () => {
    const response = await runSlashRequest({
      commandTokens: /* @__PURE__ */ new Set(["known-token"]),
      body: "token=unknown&team_id=t1&channel_id=c1&user_id=u1&command=%2Foc_status&text="
    });
    expect(response.res.statusCode).toBe(401);
    expect(response.getBody()).toContain("Unauthorized: invalid command token.");
  });
});
