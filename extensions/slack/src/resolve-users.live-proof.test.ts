// Shipped-entry-point proof: real resolveSlackUserAllowlist over a local Slack
// users.list fixture (SLACK_API_URL), exercising the production WebClient path.
import { buildAllowlistResolutionSummary, mergeAllowlist } from "openclaw/plugin-sdk/allow-from";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./monitor/context.js";
import { authorizeSlackDirectMessage } from "./monitor/dm-auth.js";
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

// Authority-chain proof: the resolved grant from the real resolver is merged into
// the allow-from list exactly as resolveWorkspacePolicy (monitor/runtime-policy.ts)
// does with buildAllowlistResolutionSummary + mergeAllowlist, then enforced by the
// production DM admission function authorizeSlackDirectMessage. This does not stop
// at the resolver's return value: it proves the derived grant admits the intended
// sender, denies a different sender before any agent/provider I/O, and denies
// subsequent messages once the name-derived grant is removed.
describe("name-derived grant through production admission", () => {
  const DM_POLICY = {
    // authorizeSlackDirectMessage only reads dmEnabled / dmPolicy /
    // allowNameMatching / teamId from ctx; cast the minimal fixture the same way
    // monitor/auth.test.ts does so the strict CI typecheck is satisfied.
    ctx: {
      dmEnabled: true,
      dmPolicy: "allowlist" as const,
      allowNameMatching: true,
      teamId: "T_ACCENT",
      installationIdentity: { kind: "workspace", teamId: "T_ACCENT" },
    } as unknown as SlackMonitorContext,
    accountId: "workspace",
    resolveSenderName: async () => ({ name: "Ren\u00e9e" }),
    sendPairingReply: vi.fn(),
    onDisabled: vi.fn(),
    onUnauthorized: vi.fn(),
    log: vi.fn(),
  };

  // Reproduces resolveWorkspacePolicy's grant derivation: resolved user ids from
  // resolveSlackUserAllowlist become additions merged into the allow-from list,
  // which retains the configured name alongside the derived id.
  function deriveAllowFrom(
    allowFrom: string[],
    resolutions: Array<{ input: string; resolved: boolean; id?: string }>,
  ): string[] {
    const { additions } = buildAllowlistResolutionSummary(
      resolutions.filter((entry) => allowFrom.includes(entry.input)),
      { formatResolved: () => null },
    );
    return mergeAllowlist({ existing: allowFrom, additions });
  }

  async function admitWithUsers(
    users: Array<Record<string, unknown>>,
    allowFrom: string[],
  ): Promise<{ allowedFor: (id: string) => Promise<boolean>; allowFromAfter: string[] }> {
    let derivedAllowFrom: string[] = [];
    await runWithUsersList(users, async ({ baseUrl }) => {
      vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
      const resolutions = await resolveSlackUserAllowlist({
        token: "xoxb-synthetic",
        entries: allowFrom,
      });
      derivedAllowFrom = deriveAllowFrom(allowFrom, resolutions);
    });
    return {
      allowFromAfter: derivedAllowFrom,
      allowedFor: async (id: string) => {
        const onUnauthorized = vi.fn();
        const allowed = await authorizeSlackDirectMessage({
          ...DM_POLICY,
          ctx: { ...DM_POLICY.ctx },
          senderId: id,
          allowFromLower: derivedAllowFrom.map((entry) => entry.toLowerCase()),
          onUnauthorized,
        });
        if (!allowed) {
          expect(onUnauthorized).toHaveBeenCalled();
        } else {
          expect(onUnauthorized).not.toHaveBeenCalled();
        }
        return allowed;
      },
    };
  }

  const profile = (displayName: string) => ({
    id: "U_ACCENT",
    name: "accented",
    deleted: false,
    is_bot: false,
    is_app_user: false,
    profile: { email: "accented@example.com", display_name: displayName },
  });

  it.each([
    ["NFC allowlist entry", NFC, NFD],
    ["NFD allowlist entry", NFD, NFC],
  ] as const)(
    "admits the canonical sender for %s through production admission (resolver + allow-from + DM gate)",
    async (_label, allowName, storedName) => {
      const { allowFromAfter, allowedFor } = await admitWithUsers(
        [profile(storedName)],
        [allowName],
      );
      expect(allowFromAfter).toEqual([allowName, "U_ACCENT"]);
      await expect(allowedFor("U_ACCENT")).resolves.toBe(true);
    },
  );

  it("denies a different sender before any agent/provider I/O", async () => {
    // Accent-stripped @Renee is a distinct name: the resolver refuses to resolve it,
    // so U_ACCENT's id never enters the allow-from list as a derived grant. The DM
    // admission gate then rejects the sender before any agent/provider I/O.
    const { allowFromAfter, allowedFor } = await admitWithUsers([profile(NFD)], ["@Renee"]);
    expect(allowFromAfter).toEqual(["@Renee"]);
    await expect(allowedFor("U_ACCENT")).resolves.toBe(false);
    await expect(allowedFor("U_OTHER")).resolves.toBe(false);
  });

  it("denies subsequent messages once the name-derived grant is removed", async () => {
    // First turn: the name resolves and its id enters the allow-from list.
    const { allowFromAfter, allowedFor } = await admitWithUsers([profile(NFD)], ["@Ren\u00e9e"]);
    expect(allowFromAfter).toEqual(["@Ren\u00e9e", "U_ACCENT"]);
    await expect(allowedFor("U_ACCENT")).resolves.toBe(true);
    // Second turn: the configured entry is removed; only the stale name is left.
    const { allowedFor: allowedAfterRemoval } = await admitWithUsers([profile(NFD)], ["@Renee"]);
    await expect(allowedAfterRemoval("U_ACCENT")).resolves.toBe(false);
  });
});
