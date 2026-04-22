import { describe, expect, test } from "vitest";
import {
  resolveWecomCommandAuthorization,
  buildWecomUnauthorizedCommandPrompt,
} from "./command-auth.js";

// Minimal mock for PluginRuntime.channel.{commands,pairing}
function createMockCore(
  opts: {
    shouldCompute?: boolean;
    resolveResult?: boolean | undefined;
    /**
     * Pairing-store approvals returned by `readAllowFromStore(...)`.
     * Applied to both legacy (3-arg) and modern (single-object) signatures.
     */
    pairingStoreAllowFrom?: Array<string | number>;
  } = {},
) {
  const pairingStoreAllowFrom = opts.pairingStoreAllowFrom ?? [];
  return {
    channel: {
      commands: {
        shouldComputeCommandAuthorized: () => opts.shouldCompute ?? true,
        resolveCommandAuthorizedFromAuthorizers: (params: {
          authorizers: Array<{ configured: boolean; allowed: boolean }>;
        }) => {
          if (opts.resolveResult !== undefined) {
            return opts.resolveResult;
          }
          // Default: authorized if any authorizer is configured and allowed
          return params.authorizers.some((a) => a.configured && a.allowed);
        },
      },
      pairing: {
        // Return the same approvals for whichever signature is called so
        // resolveWecomCommandAuthorization can merge both without
        // double-counting affecting membership semantics.
        readAllowFromStore: async () => pairingStoreAllowFrom,
      },
    },
  } as any;
}

const baseCfg = { commands: { useAccessGroups: true } } as any;

describe("resolveWecomCommandAuthorization", () => {
  test("open policy allows all senders", async () => {
    const result = await resolveWecomCommandAuthorization({
      core: createMockCore(),
      cfg: baseCfg,
      accountConfig: { dmPolicy: "open", allowFrom: [] },
      rawBody: "/bot-ping",
      senderUserId: "anyone",
    });
    expect(result.dmPolicy).toBe("open");
    expect(result.senderAllowed).toBe(true);
    expect(result.effectiveAllowFrom).toEqual(["*"]);
    expect(result.commandAuthorized).toBe(true);
  });

  test("allowlist policy denies unlisted sender", async () => {
    const result = await resolveWecomCommandAuthorization({
      core: createMockCore(),
      cfg: baseCfg,
      accountConfig: { dmPolicy: "allowlist", allowFrom: ["admin1"] },
      rawBody: "/bot-ping",
      senderUserId: "intruder",
    });
    expect(result.senderAllowed).toBe(false);
    expect(result.commandAuthorized).toBe(false);
  });

  test("allowlist policy allows listed sender", async () => {
    const result = await resolveWecomCommandAuthorization({
      core: createMockCore(),
      cfg: baseCfg,
      accountConfig: { dmPolicy: "allowlist", allowFrom: ["admin1"] },
      rawBody: "/bot-ping",
      senderUserId: "admin1",
    });
    expect(result.senderAllowed).toBe(true);
    expect(result.commandAuthorized).toBe(true);
  });

  test("pairing policy allows sender listed only in config allowFrom", async () => {
    const result = await resolveWecomCommandAuthorization({
      core: createMockCore(),
      cfg: baseCfg,
      accountConfig: { dmPolicy: "pairing", allowFrom: ["user1"] },
      rawBody: "/bot-ping",
      senderUserId: "user1",
    });
    expect(result.dmPolicy).toBe("pairing");
    expect(result.senderAllowed).toBe(true);
    expect(result.effectiveAllowFrom).toEqual(["user1"]);
  });

  test("pairing policy honors pairing-store approvals (not in config allowFrom)", async () => {
    // User is not in config.allowFrom but has been approved via pairing
    // store — mirrors the behavior of checkDmPolicy so DM gating and
    // command authorization stay consistent.
    const result = await resolveWecomCommandAuthorization({
      core: createMockCore({ pairingStoreAllowFrom: ["pairedUser"] }),
      cfg: baseCfg,
      accountConfig: { dmPolicy: "pairing", allowFrom: [] },
      accountId: "default",
      rawBody: "/bot-ping",
      senderUserId: "pairedUser",
    });
    expect(result.dmPolicy).toBe("pairing");
    expect(result.senderAllowed).toBe(true);
    expect(result.effectiveAllowFrom).toContain("pairedUser");
    expect(result.commandAuthorized).toBe(true);
  });

  test("pairing policy denies sender absent from both config and store", async () => {
    const result = await resolveWecomCommandAuthorization({
      core: createMockCore({ pairingStoreAllowFrom: ["someoneElse"] }),
      cfg: baseCfg,
      accountConfig: { dmPolicy: "pairing", allowFrom: ["admin1"] },
      accountId: "default",
      rawBody: "/bot-ping",
      senderUserId: "intruder",
    });
    expect(result.senderAllowed).toBe(false);
    expect(result.commandAuthorized).toBe(false);
  });

  test("allowlist policy does NOT read pairing-store approvals", async () => {
    // Guardrail: pairing-store lookup is scoped to dmPolicy=pairing only.
    const result = await resolveWecomCommandAuthorization({
      core: createMockCore({ pairingStoreAllowFrom: ["pairedUser"] }),
      cfg: baseCfg,
      accountConfig: { dmPolicy: "allowlist", allowFrom: [] },
      rawBody: "/bot-ping",
      senderUserId: "pairedUser",
    });
    expect(result.senderAllowed).toBe(false);
    expect(result.effectiveAllowFrom).not.toContain("pairedUser");
  });

  test("disabled policy defaults to empty allowFrom", async () => {
    const result = await resolveWecomCommandAuthorization({
      core: createMockCore(),
      cfg: baseCfg,
      accountConfig: { dmPolicy: "disabled", allowFrom: [] },
      rawBody: "/bot-ping",
      senderUserId: "anyone",
    });
    expect(result.dmPolicy).toBe("disabled");
    expect(result.senderAllowed).toBe(false);
    expect(result.effectiveAllowFrom).toEqual([]);
  });

  test("normalizes allowFrom entries (case, prefix stripping)", async () => {
    const result = await resolveWecomCommandAuthorization({
      core: createMockCore(),
      cfg: baseCfg,
      accountConfig: { dmPolicy: "allowlist", allowFrom: ["WECOM:UserA", "userid:UserB"] },
      rawBody: "/bot-ping",
      senderUserId: "usera",
    });
    expect(result.senderAllowed).toBe(true);
  });

  test("wildcard * in allowFrom allows all", async () => {
    const result = await resolveWecomCommandAuthorization({
      core: createMockCore(),
      cfg: baseCfg,
      accountConfig: { dmPolicy: "allowlist", allowFrom: ["*"] },
      rawBody: "/bot-ping",
      senderUserId: "anyone",
    });
    expect(result.senderAllowed).toBe(true);
    expect(result.authorizerConfigured).toBe(true);
  });

  test("skips auth when shouldComputeAuth is false", async () => {
    const result = await resolveWecomCommandAuthorization({
      core: createMockCore({ shouldCompute: false }),
      cfg: baseCfg,
      accountConfig: { dmPolicy: "allowlist", allowFrom: [] },
      rawBody: "hello",
      senderUserId: "anyone",
    });
    expect(result.shouldComputeAuth).toBe(false);
    expect(result.commandAuthorized).toBeUndefined();
  });
});

describe("buildWecomUnauthorizedCommandPrompt", () => {
  test("disabled policy prompt", () => {
    const prompt = buildWecomUnauthorizedCommandPrompt({
      senderUserId: "user1",
      dmPolicy: "disabled",
      scope: "bot",
    });
    expect(prompt).toContain("dmPolicy=disabled");
    expect(prompt).toContain("user1");
  });

  test("allowlist policy prompt includes user and commands", () => {
    const prompt = buildWecomUnauthorizedCommandPrompt({
      senderUserId: "user2",
      dmPolicy: "allowlist",
      scope: "agent",
    });
    expect(prompt).toContain("user2");
    expect(prompt).toContain("Agent");
    expect(prompt).toContain("openclaw config set");
  });
});
