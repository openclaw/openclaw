import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { isAuthorizedBrowserRequest } from "./http-auth.js";
import { getBrowserTestFetch } from "./test-support/fetch.js";

it.each(["token", "password"] as const)(
  "only accepts the active %s credential over HTTP",
  async (mode) => {
    const auth: { token?: string; password?: string } = { [mode]: "fixture-secret" };
    const headers = {
      token: { Authorization: "Bearer fixture-secret" },
      password: { "x-openclaw-password": "fixture-secret" },
    };
    await withServer(
      (req, res) => {
        res.statusCode = isAuthorizedBrowserRequest(req, auth) ? 200 : 401;
        res.end();
      },
      async (base) => {
        const fetch = getBrowserTestFetch();
        expect(
          (await fetch(base, { headers: headers[mode === "token" ? "password" : "token"] })).status,
        ).toBe(401);
        expect((await fetch(base, { headers: headers[mode] })).status).toBe(200);
      },
    );
  },
);
