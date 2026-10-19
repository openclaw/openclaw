import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  listChannelsForTeamWithPageInfo: vi.fn(),
  resolveGraphToken: vi.fn(),
  resolveMSTeamsChannelAllowlist: vi.fn(),
  resolveMSTeamsTeamsConfig: vi.fn(),
  resolveMSTeamsUserAllowlist: vi.fn(),
}));

vi.mock("./graph.js", () => ({
  listChannelsForTeamWithPageInfo: mocks.listChannelsForTeamWithPageInfo,
  resolveGraphToken: mocks.resolveGraphToken,
}));

vi.mock("./resolve-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resolve-allowlist.js")>();
  return {
    ...actual,
    resolveMSTeamsChannelAllowlist: mocks.resolveMSTeamsChannelAllowlist,
    resolveMSTeamsTeamsConfig: mocks.resolveMSTeamsTeamsConfig,
    resolveMSTeamsUserAllowlist: mocks.resolveMSTeamsUserAllowlist,
  };
});

import {
  assertMSTeamsReadTargetAllowed,
  assertMSTeamsTeamEnumerationAllowed,
} from "./read-policy.js";

function config(
  msteams: NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]>,
): OpenClawConfig {
  return { channels: { msteams } };
}

const channelTarget = "11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2";

const ctx = {
  accountId: "default",
  requesterAccountId: "default",
  toolContext: {},
};

function readTarget(
  cfg: OpenClawConfig,
  target = channelTarget,
  context: Parameters<typeof assertMSTeamsReadTargetAllowed>[0]["ctx"] = ctx,
) {
  return assertMSTeamsReadTargetAllowed({ cfg, ctx: context, target });
}

beforeEach(() => {
  mocks.listChannelsForTeamWithPageInfo.mockReset();
  mocks.resolveGraphToken.mockReset();
  mocks.resolveMSTeamsChannelAllowlist.mockReset();
  mocks.resolveMSTeamsTeamsConfig.mockReset();
  mocks.resolveMSTeamsUserAllowlist.mockReset();
  mocks.resolveGraphToken.mockResolvedValue("token");
});

describe("Microsoft Teams read policy", () => {
  it("requires an explicit channel route under the default sender-only policy", async () => {
    const channelId = "19:roadmap@thread.tacv2";
    const target = `11111111-1111-1111-1111-111111111111/${channelId}`;
    const cfg = config({ groupAllowFrom: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"] });

    const result = readTarget(cfg, target);
    await expect(result).rejects.toThrow(
      'Microsoft Teams read target is not allowed. Configure channels.msteams.teams.<team>.channels for this channel, or deliberately set channels.msteams.groupPolicy to "open".',
    );
    expect(mocks.resolveGraphToken).not.toHaveBeenCalled();
  });

  it("keeps unresolved channel targets on the generic authorization error", async () => {
    const cfg = config({ groupAllowFrom: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"] });

    await expect(readTarget(cfg, "Product/Roadmap")).rejects.toThrow(
      /^Microsoft Teams read target is not allowed\.$/,
    );
    expect(mocks.resolveGraphToken).not.toHaveBeenCalled();
  });

  it("keeps named account identity for Graph-backed policy mapping", async () => {
    const cfg = config({
      authType: "federated",
      defaultAccount: "default",
      accounts: {
        support: {
          authType: "secret",
          appId: "support-app",
          appPassword: "support-secret",
          tenantId: "support-tenant",
          groupPolicy: "allowlist",
          teams: {
            "19:general@thread.tacv2": {
              channels: { "19:roadmap@thread.tacv2": {} },
            },
          },
        },
      },
    });
    mocks.listChannelsForTeamWithPageInfo.mockResolvedValue({
      items: [{ id: "19:general@thread.tacv2" }, { id: "19:roadmap@thread.tacv2" }],
      truncated: false,
    });

    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg,
        ctx: { accountId: "support", requesterAccountId: "support", toolContext: {} },
        target: channelTarget,
      }),
    ).resolves.toBe(channelTarget);
    expect(mocks.resolveGraphToken).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.objectContaining({
          msteams: expect.objectContaining({
            defaultAccount: "support",
            authType: "secret",
            appId: "support-app",
          }),
        }),
      }),
      { accountId: "support" },
    );
  });

  it.each([false, true])("rejects %s-truncated Bot Framework mappings", async (truncated) => {
    const teamIds = (truncated ? ["general"] : ["general", "other"]).map(
      (name) => `19:${name}@thread.tacv2`,
    );
    const cfg = config({
      groupPolicy: "allowlist",
      teams: Object.fromEntries(
        teamIds.map((id) => [id, { channels: { "19:roadmap@thread.tacv2": {} } }]),
      ),
    });
    mocks.listChannelsForTeamWithPageInfo.mockResolvedValue({
      items: [...teamIds, ...(truncated ? [] : ["19:roadmap@thread.tacv2"])].map((id) => ({ id })),
      truncated,
    });
    await expect(readTarget(cfg)).rejects.toThrow("Microsoft Teams read target is not allowed.");
  });

  it("resolves mutable DM identities only when explicitly enabled", async () => {
    const cfg = config({
      dmPolicy: "allowlist",
      allowFrom: ["Alice"],
      dangerouslyAllowNameMatching: true,
    });
    mocks.resolveMSTeamsUserAllowlist.mockResolvedValue([
      { input: "alice@example.com", resolved: true, id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
      { input: "alice", resolved: true, id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    ]);

    await expect(readTarget(cfg, "user:alice@example.com")).resolves.toBe(
      "user:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
  });

  it("allows a supported bare conversation target when both scopes are open", async () => {
    const target = "8:orgid:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const cfg = config({ groupPolicy: "open", dmPolicy: "open" });

    await expect(readTarget(cfg, target)).resolves.toBe(target);
  });

  it("does not classify a bare Bot Framework user id as a conversation", async () => {
    const cfg = config({ groupPolicy: "open", dmPolicy: "open" });

    await expect(readTarget(cfg, "29:user-id")).rejects.toThrow(
      "Microsoft Teams read target is not allowed.",
    );
  });

  it("rejects mutable DM identities when name matching is disabled", async () => {
    const cfg = config({ dmPolicy: "allowlist", allowFrom: ["alice@example.com"] });

    await expect(readTarget(cfg, "user:alice@example.com")).rejects.toThrow(
      "Microsoft Teams read target is not allowed.",
    );
    expect(mocks.resolveMSTeamsUserAllowlist).not.toHaveBeenCalled();
  });

  it("resolves mutable channel targets only when explicitly enabled", async () => {
    const cfg = config({
      groupPolicy: "allowlist",
      dangerouslyAllowNameMatching: true,
      teams: {
        Product: {
          channels: {
            Roadmap: { requireMention: true },
          },
        },
      },
    });
    mocks.resolveMSTeamsChannelAllowlist.mockResolvedValue([
      {
        input: "Product/Roadmap",
        resolved: true,
        teamId: "19:general@thread.tacv2",
        graphTeamId: "11111111-1111-1111-1111-111111111111",
        channelId: "19:roadmap@thread.tacv2",
      },
    ]);
    await expect(readTarget(cfg, "Product/Roadmap")).resolves.toBe(channelTarget);
  });

  it("requires team-wide access before channel enumeration", async () => {
    const cfg = config({
      groupPolicy: "allowlist",
      teams: {
        Product: {
          channels: {
            "*": { requireMention: true },
          },
        },
      },
    });
    mocks.resolveMSTeamsTeamsConfig.mockResolvedValue({
      teams: {
        "11111111-1111-1111-1111-111111111111": {
          channels: {
            "*": { requireMention: true },
          },
        },
      },
      mapping: [],
      unresolved: [],
    });

    await expect(
      assertMSTeamsTeamEnumerationAllowed({
        cfg,
        teamId: "11111111-1111-1111-1111-111111111111",
      }),
    ).resolves.toBe("11111111-1111-1111-1111-111111111111");
    expect(mocks.resolveMSTeamsTeamsConfig).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      teamIdMode: "graph",
      teams: cfg.channels?.msteams?.teams,
    });
  });

  it("lets a direct operator read stable unconfigured channel and DM targets", async () => {
    const cfg = config({ groupPolicy: "allowlist", dmPolicy: "pairing" });
    const directCtx = { ...ctx, conversationReadOrigin: "direct-operator" as const };

    await expect(readTarget(cfg, channelTarget, directCtx)).resolves.toBe(channelTarget);
    await expect(
      readTarget(cfg, "user:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", directCtx),
    ).resolves.toBe("user:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  });

  it("keeps disabled Teams scopes blocked for direct operators", async () => {
    const directCtx = { ...ctx, conversationReadOrigin: "direct-operator" as const };

    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg: config({ groupPolicy: "disabled", dmPolicy: "open" }),
        ctx: directCtx,
        target: channelTarget,
      }),
    ).rejects.toThrow("Microsoft Teams read target is not allowed.");
    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg: config({ groupPolicy: "open", dmPolicy: "disabled" }),
        ctx: directCtx,
        target: "user:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
    ).rejects.toThrow("Microsoft Teams read target is not allowed.");
  });

  it("lets a direct operator enumerate an unconfigured stable team", async () => {
    const cfg = config({ groupPolicy: "allowlist" });

    await expect(
      assertMSTeamsTeamEnumerationAllowed({
        cfg,
        ctx: { ...ctx, conversationReadOrigin: "direct-operator" },
        teamId: "11111111-1111-1111-1111-111111111111",
      }),
    ).resolves.toBe("11111111-1111-1111-1111-111111111111");
  });
});
