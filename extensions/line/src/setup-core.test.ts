import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/setup";
// Guards the shipped `--token` alias: released CLIs configured LINE through the
// shared token envelope switch, which must keep writing channelAccessToken.
import { describe, expect, it } from "vitest";
import { resolveLineAccount } from "./accounts.js";
import { lineSetupAdapter, patchLineAccountConfig } from "./setup-core.js";

type LineChannelConfig = {
  channelAccessToken?: string;
  channelSecret?: string;
  tokenFile?: string;
  secretFile?: string;
  dmPolicy?: string;
  allowFrom?: string[];
  accounts?: Record<
    string,
    {
      channelAccessToken?: string;
      channelSecret?: string;
      tokenFile?: string;
      name?: string;
      dmPolicy?: string;
      allowFrom?: string[];
    }
  >;
};

function applyLineSetup(
  input: Record<string, unknown>,
  cfg: OpenClawConfig = {} as OpenClawConfig,
): OpenClawConfig {
  return lineSetupAdapter.applyAccountConfig({ cfg, accountId: "default", input });
}

function appliedLineConfig(
  input: Record<string, unknown>,
  cfg?: OpenClawConfig,
): LineChannelConfig {
  return (applyLineSetup(input, cfg).channels?.line ?? {}) as LineChannelConfig;
}

describe("line setup token alias", () => {
  it("maps the shipped --token switch onto channelAccessToken", () => {
    expect(appliedLineConfig({ token: "alias-token" }).channelAccessToken).toBe("alias-token");
  });

  it("prefers the explicit --channel-access-token over the alias", () => {
    const applied = appliedLineConfig({
      token: "alias-token",
      channelAccessToken: "explicit-token",
    });
    expect(applied.channelAccessToken).toBe("explicit-token");
  });
});

describe("LINE scoped setup config", () => {
  it("explicitly re-enables an existing disabled named account", () => {
    const cfg = patchLineAccountConfig({
      cfg: {
        channels: {
          line: {
            enabled: false,
            accounts: {
              work: {
                enabled: false,
                channelAccessToken: "old-token",
              },
            },
          },
        },
      },
      accountId: "work",
      enabled: true,
      patch: { channelAccessToken: "new-token" },
    });

    expect(cfg.channels?.line?.enabled).toBe(true);
    expect(cfg.channels?.line?.accounts?.work).toMatchObject({
      enabled: true,
      channelAccessToken: "new-token",
    });
  });

  it("clears only the selected named-account credential before applying its replacement", () => {
    const cfg = patchLineAccountConfig({
      cfg: {
        channels: {
          line: {
            channelAccessToken: "default-token",
            accounts: {
              work: {
                channelAccessToken: "old-token",
                tokenFile: "/run/secrets/line-work",
              },
            },
          },
        },
      },
      accountId: "work",
      enabled: true,
      clearFields: ["channelAccessToken", "tokenFile"],
      patch: { channelAccessToken: "new-token" },
    });

    expect(cfg.channels?.line?.channelAccessToken).toBe("default-token");
    expect(cfg.channels?.line?.accounts?.work).toEqual({
      enabled: true,
      channelAccessToken: "new-token",
    });
  });
});

describe("LINE credential rotation", () => {
  // The inline value wins over its file at resolution time, so a rotation that
  // leaves it behind silently keeps using the credential it was meant to replace.
  const inlineFirst = () =>
    applyLineSetup({ channelAccessToken: "inline-token", channelSecret: "inline-secret" });

  it("retires an inline credential when its file replaces it", () => {
    const rotated = appliedLineConfig(
      { tokenFile: "/run/secrets/line-token", secretFile: "/run/secrets/line-secret" },
      inlineFirst(),
    );

    expect(rotated.tokenFile).toBe("/run/secrets/line-token");
    expect(rotated.secretFile).toBe("/run/secrets/line-secret");
    expect(rotated.channelAccessToken).toBeUndefined();
    expect(rotated.channelSecret).toBeUndefined();
  });

  it("retires a credential file when an inline value replaces it", () => {
    const fromFiles = applyLineSetup({
      tokenFile: "/run/secrets/line-token",
      secretFile: "/run/secrets/line-secret",
    });

    const rotated = appliedLineConfig(
      { channelAccessToken: "inline-token", channelSecret: "inline-secret" },
      fromFiles,
    );

    expect(rotated.channelAccessToken).toBe("inline-token");
    expect(rotated.channelSecret).toBe("inline-secret");
    expect(rotated.tokenFile).toBeUndefined();
    expect(rotated.secretFile).toBeUndefined();
  });

  it("leaves the credential that was not replaced alone", () => {
    const rotated = appliedLineConfig({ tokenFile: "/run/secrets/line-token" }, inlineFirst());

    expect(rotated.tokenFile).toBe("/run/secrets/line-token");
    expect(rotated.channelSecret).toBe("inline-secret");
    expect(rotated.channelAccessToken).toBeUndefined();
  });
});

// Regression coverage for rotation after single-account promotion: doctor's
// single-account migration (singleAccountKeysToMove) moves root credentials
// into accounts.default, and the resolver reads accounts.default ahead of the
// channel root for the default account. A default-scope rotation must retire
// the promoted stale credential or setup silently keeps the old identity.
describe("LINE rotation after single-account promotion", () => {
  function writeTempTokenFile(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-rotation-"));
    const file = path.join(dir, "token");
    fs.writeFileSync(file, contents);
    return file;
  }

  function promotedConfig(): OpenClawConfig {
    // The shape doctor's single-account migration produces: credentials live in
    // accounts.default and the channel root no longer carries them.
    return {
      channels: {
        line: {
          enabled: true,
          accounts: {
            default: {
              name: "Main",
              channelAccessToken: "STALE_PROMOTED_TOKEN",
              channelSecret: "PROMOTED_SECRET",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
  }

  function resolvedToken(cfg: OpenClawConfig): string {
    return resolveLineAccount({ cfg, accountId: "default" }).channelAccessToken;
  }

  function promotedAccount(cfg: OpenClawConfig): LineChannelConfig["accounts"] {
    return (cfg.channels?.line as LineChannelConfig)?.accounts;
  }

  it("retires a promoted inline token when a file replaces it", () => {
    const newFile = writeTempTokenFile("FILE_TOKEN_B");

    const rotated = applyLineSetup({ tokenFile: newFile }, promotedConfig());
    const channel = rotated.channels?.line as LineChannelConfig;

    expect(channel.channelAccessToken).toBeUndefined();
    expect(promotedAccount(rotated)?.default?.channelAccessToken).toBeUndefined();
    // The rotation touches the token family only; the promoted secret survives.
    expect(promotedAccount(rotated)?.default?.channelSecret).toBe("PROMOTED_SECRET");
    expect(resolvedToken(rotated)).toBe("FILE_TOKEN_B");
  });

  it("retires a promoted inline token when an inline token replaces it", () => {
    const rotated = applyLineSetup({ channelAccessToken: "ROTATED_TOKEN" }, promotedConfig());
    const channel = rotated.channels?.line as LineChannelConfig;

    expect(channel.channelAccessToken).toBe("ROTATED_TOKEN");
    expect(promotedAccount(rotated)?.default?.channelAccessToken).toBeUndefined();
    expect(promotedAccount(rotated)?.default?.channelSecret).toBe("PROMOTED_SECRET");
    expect(resolvedToken(rotated)).toBe("ROTATED_TOKEN");
  });

  it("retires a promoted token file when a file replaces it", () => {
    const staleFile = writeTempTokenFile("STALE_FILE_TOKEN");
    const newFile = writeTempTokenFile("NEW_FILE_TOKEN");
    const promotedFile = {
      channels: {
        line: {
          enabled: true,
          accounts: {
            default: { name: "Main", tokenFile: staleFile },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const rotated = applyLineSetup({ tokenFile: newFile }, promotedFile);
    const channel = rotated.channels?.line as LineChannelConfig;

    expect(channel.tokenFile).toBe(newFile);
    expect(promotedAccount(rotated)?.default?.tokenFile).toBeUndefined();
    expect(resolvedToken(rotated)).toBe("NEW_FILE_TOKEN");
  });

  it("retires the promoted credentials when switching to the environment", () => {
    const rotated = applyLineSetup({ useEnv: true }, promotedConfig());
    const channel = rotated.channels?.line as LineChannelConfig;

    expect(channel.channelAccessToken).toBeUndefined();
    expect(promotedAccount(rotated)?.default?.channelAccessToken).toBeUndefined();
    expect(promotedAccount(rotated)?.default?.channelSecret).toBeUndefined();
  });

  it("control: a rotation with no promoted credential still resolves the new token", () => {
    const fromRoot = applyLineSetup({ channelAccessToken: "ROOT_TOKEN_A" }, {} as OpenClawConfig);
    const rotated = applyLineSetup({ channelAccessToken: "ROOT_TOKEN_C" }, fromRoot);

    expect(resolvedToken(rotated)).toBe("ROOT_TOKEN_C");
  });

  it("control: named accounts are untouched by a default-account rotation", () => {
    const withWork = {
      channels: {
        line: {
          enabled: true,
          channelAccessToken: "ROOT_TOKEN_A",
          accounts: {
            work: { name: "Work", channelAccessToken: "WORK_TOKEN" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const rotated = applyLineSetup({ channelAccessToken: "ROOT_TOKEN_C" }, withWork);
    const channel = rotated.channels?.line as LineChannelConfig;

    expect(channel.channelAccessToken).toBe("ROOT_TOKEN_C");
    expect(channel.accounts?.work).toEqual({ name: "Work", channelAccessToken: "WORK_TOKEN" });
  });

  it("retires the exact default record when a case-colliding key sorts first", () => {
    // resolveAccountEntry prefers the exact `default` key over a case variant,
    // so the rotation must clear that same record; clearing `Default` instead
    // would leave the active stale credential in place.
    const colliding = {
      channels: {
        line: {
          enabled: true,
          accounts: {
            Default: { channelAccessToken: "LEGACY_VARIANT_TOKEN" },
            default: { channelAccessToken: "STALE_PROMOTED_TOKEN" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const rotated = applyLineSetup({ channelAccessToken: "ROTATED_TOKEN" }, colliding);
    const channel = rotated.channels?.line as LineChannelConfig;

    expect(promotedAccount(rotated)?.default?.channelAccessToken).toBeUndefined();
    expect(promotedAccount(rotated)?.Default?.channelAccessToken).toBe("LEGACY_VARIANT_TOKEN");
    expect(channel.channelAccessToken).toBe("ROTATED_TOKEN");
    expect(resolvedToken(rotated)).toBe("ROTATED_TOKEN");
  });

  it("retires a case-variant default record when no exact key exists", () => {
    // With only an authored `Default` record, the resolver falls back to the
    // case-insensitive match and reads that record, so the rotation must
    // clear the stale credential there under its authored key.
    const variantOnly = {
      channels: {
        line: {
          enabled: true,
          accounts: {
            Default: { channelAccessToken: "STALE_VARIANT_TOKEN", name: "Main" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const rotated = applyLineSetup({ channelAccessToken: "ROTATED_TOKEN" }, variantOnly);
    const channel = rotated.channels?.line as LineChannelConfig;

    expect(promotedAccount(rotated)?.Default).toEqual({ name: "Main" });
    expect(channel.channelAccessToken).toBe("ROTATED_TOKEN");
    expect(resolvedToken(rotated)).toBe("ROTATED_TOKEN");
  });

  it("clears the record the resolver reads when a misleading key sorts first", () => {
    // resolveAccountEntry falls back on trimmed lowercase equality, so with no
    // exact `default` key the resolver reads `Default` — not `-default-`, which
    // only canonicalizes to `default` under normalizeAccountId's punctuation
    // sanitizing. Retirement must clear the same record the resolver reads.
    const misleading = {
      channels: {
        line: {
          enabled: true,
          accounts: {
            "-default-": { channelAccessToken: "DECOY_TOKEN" },
            Default: { channelAccessToken: "STALE_VARIANT_TOKEN" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const rotated = applyLineSetup({ channelAccessToken: "ROTATED_TOKEN" }, misleading);
    const channel = rotated.channels?.line as LineChannelConfig;

    expect(promotedAccount(rotated)?.Default).toEqual({});
    expect(promotedAccount(rotated)?.["-default-"]).toEqual({
      channelAccessToken: "DECOY_TOKEN",
    });
    expect(channel.channelAccessToken).toBe("ROTATED_TOKEN");
    expect(resolvedToken(rotated)).toBe("ROTATED_TOKEN");
  });

  it("preserves promoted policy fields when the DM-policy writer clears allowFrom", () => {
    // The DM-policy writer (setup-surface lineDmPolicy.applyPatch) calls
    // patchLineAccountConfig with clearFields: ["allowFrom"] when pairing or
    // disabled is selected. Promoted-record retirement is credential-only, so
    // the account record keeps its saved policy; deleting the account
    // allowlist while leaving dmPolicy: "open" would fail LINE's per-account
    // open-policy validation.
    const withPolicy = {
      channels: {
        line: {
          enabled: true,
          allowFrom: ["*"],
          accounts: {
            default: { dmPolicy: "open", allowFrom: ["*"] },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const rotated = patchLineAccountConfig({
      cfg: withPolicy,
      accountId: "default",
      enabled: true,
      patch: { dmPolicy: "pairing" },
      clearFields: ["allowFrom"],
    });
    const channel = rotated.channels?.line as LineChannelConfig;

    expect(channel.dmPolicy).toBe("pairing");
    expect(channel.allowFrom).toBeUndefined();
    expect(promotedAccount(rotated)?.default).toEqual({ dmPolicy: "open", allowFrom: ["*"] });
  });
});
