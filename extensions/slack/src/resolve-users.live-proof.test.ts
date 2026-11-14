// Shipped-entry-point proof: real resolveSlackUserAllowlist over a local Slack
// users.list fixture (SLACK_API_URL), exercising the production WebClient path.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./monitor/context.js";
import { prepareSlackMessage } from "./monitor/message-handler/prepare.js";
import {
  createInboundSlackTestContext,
  createSlackTestAccount,
} from "./monitor/message-handler/prepare.test-helpers.js";
import type { PreparedSlackMessage } from "./monitor/message-handler/types.js";
import { resolveSlackUserAllowlist } from "./resolve-users.js";
import type { SlackMessageEvent } from "./types.js";

const NFD = "Rene\u0301e"; // decomposed
const NFC = "Ren\u00e9e"; // precomposed

beforeEach(() => {
  for (const key of ["SLACK_API_URL", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("NO_PROXY", "*");
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
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

it("keeps exact-name matches ahead of canonically-equivalent directory entries", async () => {
  // U_OTHER (NFD display name) precedes U_INTENDED (NFC display name) in the
  // directory. Exact-name matching must select U_INTENDED even though U_OTHER
  // is canonically equivalent: NFC normalization is a fallback only and never
  // displaces the configured principal with a different Slack user id.
  await runWithUsersList(
    [
      {
        id: "U_OTHER",
        name: "other",
        deleted: false,
        is_bot: false,
        is_app_user: false,
        profile: { email: "other@example.com", display_name: NFD },
      },
      {
        id: "U_INTENDED",
        name: "intended",
        deleted: false,
        is_bot: false,
        is_app_user: false,
        profile: { email: "intended@example.com", display_name: NFC },
      },
    ],
    async ({ baseUrl }) => {
      vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);

      const exact = await resolveSlackUserAllowlist({
        token: "xoxb-synthetic",
        entries: [NFC],
      });

      expect(exact[0]).toMatchObject({ resolved: true, id: "U_INTENDED" });
    },
  );
});

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

// Authority-chain proof through the final effect: the resolved grant from the real
// resolver is merged into the allow-from list exactly as resolveWorkspacePolicy
// (monitor/runtime-policy.ts) does with buildAllowlistResolutionSummary +
// mergeAllowlist, then enforced by the production DM ingress entry point
// prepareSlackMessage (monitor/message-handler/prepare.ts), which runs the DM
// admission gate authorizeSlackDirectMessage before any agent/provider I/O.
//
// This does not stop at the resolver return value or a bare boolean: admitting a
// sender returns a PreparedSlackMessage (the exact object the monitor would hand to
// dispatchPreparedSlackMessage, i.e. the thing that reaches the agent/provider), and
// denying returns null (the DM gate drops the event before dispatch). Distinct real
// sender identities are used so the competing principal is exercised with its actual
// id. Grant removal is proven on the same runtime policy reader: replacing the
// published config (setRuntimeConfigSnapshot) makes createSlackRuntimeContextReader
// rebuild the policy on its next read (runtime-policy.ts:116 current.cfg !== cfg),
// so the derived id leaves allow-from and a subsequent message from the same sender
// is denied before dispatch — the same live-policy-change path the monitor uses.
describe("name-derived grant through production admission", () => {
  function dmConfig(allowFrom: string[]): OpenClawConfig {
    return {
      channels: {
        slack: {
          enabled: true,
          dangerouslyAllowNameMatching: true,
          dmPolicy: "allowlist",
          allowFrom,
        },
      },
    } as OpenClawConfig;
  }

  // createInboundSlackTestContext assembles a typed monitor context whose
  // readRuntimeContext is the real createSlackRuntimeContextReader. The reader's
  // next objects inherit this ctx, so stubbing resolveUserName / resolveChannelName
  // here keeps the fixture off the live Slack API while the policy/ingress machinery
  // stays production.
  function makeContext(
    cfg: OpenClawConfig,
    senderNames: Record<string, string>,
  ): SlackMonitorContext {
    const ctx = createInboundSlackTestContext({ cfg });
    ctx.installationIdentity = { kind: "workspace", teamId: "T_ACCENT" };
    ctx.teamId = "T_ACCENT";
    // Production resolves the sender display name per user id through
    // ctx.resolveUserName (prepare.ts:381); mirror that here so each sender is
    // exercised under its own real fixture identity rather than one shared name.
    ctx.resolveUserName = async (userId: string) => ({ name: senderNames[userId] });
    ctx.resolveChannelName = async () => ({ name: "general", type: "channel" });
    return ctx;
  }

  function dmMessage(userId: string): SlackMessageEvent {
    return {
      type: "message",
      channel: "D123",
      channel_type: "im",
      user: userId,
      text: "hi",
      ts: "1.000",
    };
  }

  // The production DM ingress entry point. A non-null result is a PreparedSlackMessage
  // that would be dispatched to the agent/provider; null is a drop before dispatch.
  async function prepareAs(
    policyCtx: SlackMonitorContext,
    senderId: string,
  ): Promise<PreparedSlackMessage | null> {
    return prepareSlackMessage({
      ctx: policyCtx,
      account: createSlackTestAccount(),
      message: dmMessage(senderId),
      opts: { source: "message" },
    });
  }

  const profile = (displayName: string) => ({
    id: "U_ACCENT",
    name: "accented",
    deleted: false,
    is_bot: false,
    is_app_user: false,
    profile: { email: "accented@example.com", display_name: displayName },
  });

  const otherProfile = {
    id: "U_OTHER",
    name: "other",
    deleted: false,
    is_bot: false,
    is_app_user: false,
    profile: { email: "other@example.com", display_name: "Different Person" },
  };

  // Resolves a policy through the production reader over the local users.list fixture
  // and returns a function that runs the real DM ingress for a given sender id.
  async function withPolicy(
    users: Array<Record<string, unknown>>,
    allowFrom: string[],
    senderNames: Record<string, string>,
  ): Promise<{
    allowFromAfter: string[];
    prepare: (senderId: string) => Promise<PreparedSlackMessage | null>;
  }> {
    let policyCtx!: SlackMonitorContext;
    await runWithUsersList(users, async ({ baseUrl }) => {
      vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
      const cfg = dmConfig(allowFrom);
      setRuntimeConfigSnapshot(cfg, cfg);
      const ctx = makeContext(cfg, senderNames);
      policyCtx = await ctx.readRuntimeContext();
    });
    return {
      allowFromAfter: [...policyCtx.allowFrom],
      prepare: (senderId: string) => prepareAs(policyCtx, senderId),
    };
  }

  it.each([
    ["NFC allowlist entry", NFC, NFD],
    ["NFD allowlist entry", NFD, NFC],
  ] as const)(
    "admits the canonical sender for %s through production ingress (resolver + allow-from + DM gate)",
    async (_label, allowName, storedName) => {
      const { allowFromAfter, prepare } = await withPolicy([profile(storedName)], [allowName], {
        U_ACCENT: storedName,
      });
      expect(allowFromAfter).toEqual([allowName, "U_ACCENT"]);
      // A PreparedSlackMessage is returned: the exact object the monitor dispatches to
      // the agent/provider. Reaching it proves the grant holds at final effect.
      await expect(prepare("U_ACCENT")).resolves.not.toBeNull();
    },
  );

  it("rejects the competing principal while the canonical grant is active", async () => {
    // The canonical grant derived from @Renée is ACTIVE: U_ACCENT sits in allow-from.
    // A message from U_OTHER — a real, distinct sender with its own fixture display
    // name and sender identity — must still be dropped before any agent/provider I/O.
    // This is the competing-principal rejection: the derived grant admits exactly the
    // resolved principal and never a different Slack user id.
    const { allowFromAfter, prepare } = await withPolicy(
      [profile(NFD), otherProfile],
      ["@Ren\u00e9e"],
      { U_ACCENT: NFD, U_OTHER: "Different Person" },
    );
    expect(allowFromAfter).toEqual(["@Ren\u00e9e", "U_ACCENT"]);
    await expect(prepare("U_ACCENT")).resolves.not.toBeNull();
    await expect(prepare("U_OTHER")).resolves.toBeNull();
  });

  it("denies a different sender before any agent/provider I/O", async () => {
    // Accent-stripped @Renee is a distinct name: the resolver refuses to resolve it,
    // so U_ACCENT's id never enters the allow-from list as a derived grant. The DM
    // ingress gate then drops the event before any agent/provider I/O.
    const { allowFromAfter, prepare } = await withPolicy([profile(NFD)], ["@Renee"], {
      U_ACCENT: NFD,
      U_OTHER: "Different Person",
    });
    expect(allowFromAfter).toEqual(["@Renee"]);
    await expect(prepare("U_ACCENT")).resolves.toBeNull();
    await expect(prepare("U_OTHER")).resolves.toBeNull();
  });

  it("denies subsequent messages once the name-derived grant is removed", async () => {
    // First turn: the name resolves and its id enters the allow-from list; the sender
    // is admitted at final effect.
    let reader!: SlackMonitorContext;
    let reloaded!: SlackMonitorContext;
    await runWithUsersList([profile(NFD)], async ({ baseUrl }) => {
      vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
      const cfg = dmConfig(["@Ren\u00e9e"]);
      setRuntimeConfigSnapshot(cfg, cfg);
      reader = makeContext(cfg, { U_ACCENT: NFD });
      reloaded = await reader.readRuntimeContext();
    });
    expect([...reloaded.allowFrom]).toEqual(["@Ren\u00e9e", "U_ACCENT"]);
    await expect(prepareAs(reloaded, "U_ACCENT")).resolves.not.toBeNull();

    // Second turn on the SAME reader: publish a config without the name entry. The
    // reader rebuilds policy on its next read (runtime-policy.ts:116), the derived id
    // leaves allow-from, and the same sender is now dropped before dispatch.
    await runWithUsersList([profile(NFD)], async ({ baseUrl }) => {
      vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
      const cfg = dmConfig(["@Renee"]);
      setRuntimeConfigSnapshot(cfg, cfg);
      reloaded = await reader.readRuntimeContext();
    });
    expect([...reloaded.allowFrom]).toEqual(["@Renee"]);
    await expect(prepareAs(reloaded, "U_ACCENT")).resolves.toBeNull();
  });
});
