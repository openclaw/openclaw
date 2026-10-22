import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { isAuthorizedBrowserRequest } from "./http-auth.js";
import { getBrowserTestFetch } from "./test-support/fetch.js";

let auth: { token?: string; password?: string } = {};
let base: string;
const server = createServer((req, res) => {
  res.statusCode = isAuthorizedBrowserRequest(req, auth) ? 200 : 401;
  res.end();
});
beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback listener");
  }
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

it.each(["token", "password"] as const)(
  "only accepts the active %s credential over HTTP",
  async (mode) => {
    auth = { [mode]: "fixture-secret" };
    const headers = {
      token: { Authorization: "Bearer fixture-secret" },
      password: { "x-openclaw-password": "fixture-secret" },
    };
    const fetch = getBrowserTestFetch();
    expect(
      (await fetch(base, { headers: headers[mode === "token" ? "password" : "token"] })).status,
    ).toBe(401);
    expect((await fetch(base, { headers: headers[mode] })).status).toBe(200);
  },
);
