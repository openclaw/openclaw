import { describe, expect, it } from "vitest";
import type { CoreConfig, MatrixConfig } from "../types.js";
import {
  resolveMatrixConfigFieldPath,
  updateMatrixAccountConfig,
  type MatrixAccountPatch,
} from "./config-update.js";

const homeserver = "https://matrix.example.org";
function withAccount(
  account: MatrixConfig,
  id = "default",
  defaults: MatrixConfig = {},
): CoreConfig {
  return { channels: { matrix: { ...defaults, accounts: { [id]: account } } } };
}
describe("updateMatrixAccountConfig", () => {
  it("resolves account-aware Matrix config field paths", () => {
    expect(resolveMatrixConfigFieldPath({}, "default", "dm.policy")).toBe(
      "channels.matrix.dm.policy",
    );

    expect(resolveMatrixConfigFieldPath(withAccount({}, "ops"), "ops", ".dm.allowFrom")).toBe(
      "channels.matrix.accounts.ops.dm.allowFrom",
    );
  });

  it.each<[MatrixConfig, MatrixAccountPatch, MatrixConfig]>([
    [
      {
        homeserver,
        userId: "@bot:example.org",
        accessToken: "old-token", // pragma: allowlist secret
        password: "old-password", // pragma: allowlist secret
        encryption: true,
      },
      { accessToken: "new-token", password: null, userId: null, encryption: false },
      { homeserver, accessToken: "new-token", encryption: false },
    ],
    [
      {
        allowBots: true,
        network: { dangerouslyAllowPrivateNetwork: true },
        proxy: "http://127.0.0.1:7890",
      },
      { allowBots: "mentions", allowPrivateNetwork: null, proxy: null },
      { allowBots: "mentions" },
    ],
    [{ initialSyncLimit: 20 }, { initialSyncLimit: Number.NaN }, {}],
  ])("applies account patch %j -> %j", (initial, patch, expected) => {
    expect(updateMatrixAccountConfig(withAccount(initial), "default", patch)).toEqual({
      channels: {
        matrix: { enabled: true, accounts: { default: { ...expected, enabled: true } } },
      },
    });
  });

  it("preserves SecretRef auth inputs when updating config", () => {
    const auth = {
      accessToken: { source: "env", provider: "default", id: "MATRIX_ACCESS_TOKEN" },
      password: { source: "env", provider: "default", id: "MATRIX_PASSWORD" },
    } satisfies MatrixConfig;
    const updated = updateMatrixAccountConfig({}, "default", auth);
    expect(updated.channels?.matrix?.accessToken).toEqual(auth.accessToken);
    expect(updated.channels?.matrix?.password).toEqual(auth.password);
  });

  it("updates nested access config for named accounts without touching top-level defaults", () => {
    const cfg = withAccount({ dm: { enabled: true, policy: "pairing" } }, "ops", {
      dm: { policy: "pairing" },
      groups: { "!default:example.org": { enabled: true } },
    });

    const updated = updateMatrixAccountConfig(cfg, "ops", {
      dm: { policy: "allowlist", allowFrom: ["@alice:example.org"] },
      groupPolicy: "allowlist",
      groups: { "!ops-room:example.org": { enabled: true } },
      rooms: null,
    });

    expect(updated.channels?.matrix?.dm).toEqual(cfg.channels?.matrix?.dm);
    expect(updated.channels?.matrix?.groups).toEqual(cfg.channels?.matrix?.groups);
    expect(updated.channels?.matrix?.accounts?.ops).toEqual({
      enabled: true,
      dm: { enabled: true, policy: "allowlist", allowFrom: ["@alice:example.org"] },
      groupPolicy: "allowlist",
      groups: { "!ops-room:example.org": { enabled: true } },
    });
  });

  it("reuses and canonicalizes non-normalized account entries when updating", () => {
    const cfg = withAccount(
      { homeserver: "https://matrix.ops.example.org", accessToken: "ops-token" },
      "Ops Bot",
    );

    const updated = updateMatrixAccountConfig(cfg, " OPS Bot ", { name: "Main Bot" });
    expect(updated.channels?.matrix?.accounts).toEqual({
      "ops-bot": {
        homeserver: "https://matrix.ops.example.org",
        accessToken: "ops-token",
        name: "Main Bot",
        enabled: true,
      },
    });
  });
});
