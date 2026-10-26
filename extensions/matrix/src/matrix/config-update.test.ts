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
const update = (account: MatrixConfig, patch: MatrixAccountPatch) =>
  updateMatrixAccountConfig(withAccount(account), "default", patch).channels?.matrix?.accounts
    ?.default;

describe("updateMatrixAccountConfig", () => {
  it("resolves account-aware Matrix config field paths", () => {
    expect(resolveMatrixConfigFieldPath({}, "default", "dm.policy")).toBe(
      "channels.matrix.dm.policy",
    );

    expect(resolveMatrixConfigFieldPath(withAccount({}, "ops"), "ops", ".dm.allowFrom")).toBe(
      "channels.matrix.accounts.ops.dm.allowFrom",
    );
  });

  it.each([
    [
      "explicit null clears and boolean false values",
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
      "allowBots updates and private-network/proxy clears",
      {
        allowBots: true,
        network: { dangerouslyAllowPrivateNetwork: true },
        proxy: "http://127.0.0.1:7890",
      },
      { allowBots: "mentions", allowPrivateNetwork: null, proxy: null },
      { allowBots: "mentions" },
    ],
  ] satisfies [string, MatrixConfig, MatrixAccountPatch, MatrixConfig][])(
    "supports %s",
    (_name, initial, patch, expected) => {
      expect(update(initial, patch)).toEqual({ ...expected, enabled: true });
    },
  );

  it("does not store non-finite initial sync limits", () => {
    const updated = updateMatrixAccountConfig(withAccount({ initialSyncLimit: 20 }), "default", {
      initialSyncLimit: Number.NaN,
    });

    expect(updated.channels?.matrix?.initialSyncLimit).toBeUndefined();
    expect(updated.channels?.matrix?.accounts?.default?.initialSyncLimit).toBeUndefined();
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

  it.each(["allowlist", "off", "always"] as const)(
    "stores %s invite auto-join settings",
    (autoJoin) => {
      const rooms = ["!ops-room:example.org", "#ops:example.org"];
      const account = update(
        { autoJoin: "allowlist", autoJoinAllowlist: ["#ops:example.org"] },
        {
          autoJoin,
          autoJoinAllowlist: autoJoin === "allowlist" ? rooms : null,
        },
      );
      expect(account?.autoJoin).toBe(autoJoin);
      expect(account?.autoJoinAllowlist).toEqual(autoJoin === "allowlist" ? rooms : undefined);
    },
  );

  it("normalizes account id and defaults account enabled=true", () => {
    const updated = updateMatrixAccountConfig({}, "Main Bot", { name: "Main Bot", homeserver });
    expect(updated.channels?.matrix?.accounts?.["main-bot"]).toEqual({
      name: "Main Bot",
      homeserver,
      enabled: true,
    });
  });

  it("updates nested access config for named accounts without touching top-level defaults", () => {
    const cfg = withAccount(
      {
        homeserver: "https://matrix.ops.example.org",
        accessToken: "ops-token",
        dm: { enabled: true, policy: "pairing" },
      },
      "ops",
      { dm: { policy: "pairing" }, groups: { "!default:example.org": { enabled: true } } },
    );

    const updated = updateMatrixAccountConfig(cfg, "ops", {
      dm: { policy: "allowlist", allowFrom: ["@alice:example.org"] },
      groupPolicy: "allowlist",
      groups: { "!ops-room:example.org": { enabled: true } },
      rooms: null,
    });

    expect(updated.channels?.matrix?.dm).toEqual(cfg.channels?.matrix?.dm);
    expect(updated.channels?.matrix?.groups).toEqual(cfg.channels?.matrix?.groups);
    expect(updated.channels?.matrix?.accounts?.ops).toEqual({
      homeserver: "https://matrix.ops.example.org",
      accessToken: "ops-token",
      enabled: true,
      dm: { enabled: true, policy: "allowlist", allowFrom: ["@alice:example.org"] },
      groupPolicy: "allowlist",
      groups: { "!ops-room:example.org": { enabled: true } },
    });
  });

  it("reuses and canonicalizes non-normalized account entries when updating", () => {
    const cfg = withAccount(
      { homeserver: "https://matrix.ops.example.org", accessToken: "ops-token" },
      "Ops",
    );

    const updated = updateMatrixAccountConfig(cfg, "ops", { deviceName: "Ops Bot" });
    expect(updated.channels?.["matrix"]?.accounts?.Ops).toBeUndefined();
    expect(updated.channels?.matrix?.accounts?.ops).toMatchObject({
      homeserver: "https://matrix.ops.example.org",
      accessToken: "ops-token",
      deviceName: "Ops Bot",
      enabled: true,
    });
  });
});
