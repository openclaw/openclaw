// Shipped-entry-point proof: real resolveSlackUserAllowlist over a local Slack
// users.list fixture (SLACK_API_URL), exercising the production WebClient path.
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveSlackUserAllowlist } from "./resolve-users.js";

const NFD = "Rene\u0301e"; // decomposed
const NFC = "Ren\u00e9e"; // precomposed

beforeEach(() => {
  for (const key of ["SLACK_API_URL", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("NO_PROXY", "*");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function runWithUsersList(
  users: Array<Record<string, unknown>>,
  run: (api: { baseUrl: string; paths: string[] }) => Promise<void>,
) {
  const paths: string[] = [];
  return withServer(
    (request, response) => {
      const url = request.url ?? "";
      paths.push(url);
      request.resume();
      response.setHeader("content-type", "application/json");
      if (url.includes("users.list")) {
        response.end(JSON.stringify({ ok: true, members: users, response_metadata: {} }));
      } else {
        response.end(JSON.stringify({ ok: true }));
      }
    },
    async (baseUrl) => {
      await run({ baseUrl, paths });
    },
  );
}

it.each([
  ["NFC entry against an NFD profile", NFC, NFD],
  ["NFD entry against an NFC profile", NFD, NFC],
] as const)(
  "resolves %s through the production WebClient and local users.list fixture",
  async (_label, entryName, profileName) => {
    await runWithUsersList(
      [
        {
          id: "U_ACCENT",
          name: "accented",
          deleted: false,
          is_bot: false,
          is_app_user: false,
          profile: { email: "accented@example.com", display_name: profileName },
        },
        {
          id: "U_OTHER",
          name: "other",
          deleted: false,
          is_bot: false,
          is_app_user: false,
          profile: { email: "other@example.com", display_name: "Different Person" },
        },
      ],
      async ({ baseUrl, paths }) => {
        vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);

        const results = await resolveSlackUserAllowlist({
          token: "xoxb-synthetic",
          entries: [entryName],
        });

        expect(results).toEqual([
          {
            deleted: false,
            email: "accented@example.com",
            id: "U_ACCENT",
            input: entryName,
            isBot: false,
            name: profileName,
            resolved: true,
          },
        ]);
        expect(paths.some((p) => p.includes("users.list"))).toBe(true);
      },
    );
  },
);

it("does not admit a different principal (accent-stripped) through the production path", async () => {
  await runWithUsersList(
    [
      {
        id: "U_ACCENT",
        name: "accented",
        deleted: false,
        is_bot: false,
        is_app_user: false,
        profile: { email: "accented@example.com", display_name: NFD },
      },
    ],
    async ({ baseUrl }) => {
      vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);

      const results = await resolveSlackUserAllowlist({
        token: "xoxb-synthetic",
        entries: ["@Renee"],
      });

      expect(results).toEqual([{ input: "@Renee", resolved: false }]);
    },
  );
});

it("keeps same-form and ASCII controls unchanged through the production path", async () => {
  await runWithUsersList(
    [
      {
        id: "U_ACCENT",
        name: "accented",
        deleted: false,
        is_bot: false,
        is_app_user: false,
        profile: { email: "accented@example.com", display_name: NFD },
      },
    ],
    async ({ baseUrl }) => {
      vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);

      const sameForm = await resolveSlackUserAllowlist({
        token: "xoxb-synthetic",
        entries: [NFD],
      });
      const ascii = await resolveSlackUserAllowlist({
        token: "xoxb-synthetic",
        entries: ["@accented"],
      });

      expect(sameForm[0]).toMatchObject({ resolved: true, id: "U_ACCENT" });
      expect(ascii[0]).toMatchObject({ resolved: true, id: "U_ACCENT" });
    },
  );
});
