import { describe, expect, it } from "vitest";
import type { CoreConfig, MatrixConfig } from "../types.js";
import { resolveMatrixConfigFieldPath, updateMatrixAccountConfig } from "./config-update.js";

function withAccount(
  account: MatrixConfig,
  id = "default",
  defaults: MatrixConfig = {},
): CoreConfig {
  return { channels: { matrix: { ...defaults, accounts: { [id]: account } } } };
}

describe("updateMatrixAccountConfig", () => {
  it("resolves account-aware Matrix config field paths", () => {
    expect(resolveMatrixConfigFieldPath({} as CoreConfig, "default", "dm.policy")).toBe(
      "channels.matrix.dm.policy",
    );

    const cfg = withAccount({}, "ops");

    expect(resolveMatrixConfigFieldPath(cfg, "ops", ".dm.allowFrom")).toBe(
      "channels.matrix.accounts.ops.dm.allowFrom",
    );
  });

  it("supports explicit null clears and boolean false values", () => {
    const cfg = withAccount({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "old-token", // pragma: allowlist secret
      password: "old-password", // pragma: allowlist secret
      encryption: true,
    });

    const updated = updateMatrixAccountConfig(cfg, "default", {
      accessToken: "new-token",
      password: null,
      userId: null,
      encryption: false,
    });

    const account = updated.channels?.["matrix"]?.accounts?.default;
    expect(account?.accessToken).toBe("new-token");
    expect(account?.encryption).toBe(false);
    expect(account?.password).toBeUndefined();
    expect(account?.userId).toBeUndefined();
  });

  it("does not store non-finite initial sync limits", () => {
    const cfg = withAccount({ initialSyncLimit: 20 });

    const updated = updateMatrixAccountConfig(cfg, "default", {
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

  it("stores and clears Matrix allowBots, allowPrivateNetwork, and proxy settings", () => {
    const cfg = withAccount({
      allowBots: true,
      network: { dangerouslyAllowPrivateNetwork: true },
      proxy: "http://127.0.0.1:7890",
    });

    const updated = updateMatrixAccountConfig(cfg, "default", {
      allowBots: "mentions",
      allowPrivateNetwork: null,
      proxy: null,
    });

    const account = updated.channels?.["matrix"]?.accounts?.default;
    expect(account?.allowBots).toBe("mentions");
    expect(account?.network).toBeUndefined();
    expect(account?.proxy).toBeUndefined();
  });

  it.each(["allowlist", "off", "always"] as const)(
    "stores %s invite auto-join settings",
    (autoJoin) => {
      const cfg = withAccount({ autoJoin: "allowlist", autoJoinAllowlist: ["#ops:example.org"] });
      const rooms = ["!ops-room:example.org", "#ops:example.org"];
      const updated = updateMatrixAccountConfig(cfg, "default", {
        autoJoin,
        autoJoinAllowlist: autoJoin === "allowlist" ? rooms : null,
      });
      const account = updated.channels?.matrix?.accounts?.default;
      expect(account?.autoJoin).toBe(autoJoin);
      expect(account?.autoJoinAllowlist).toEqual(autoJoin === "allowlist" ? rooms : undefined);
    },
  );

  it("normalizes account id and defaults account enabled=true", () => {
    const updated = updateMatrixAccountConfig({} as CoreConfig, "Main Bot", {
      name: "Main Bot",
      homeserver: "https://matrix.example.org",
    });

    const account = updated.channels?.["matrix"]?.accounts?.["main-bot"];
    expect(account).toMatchObject({
      name: "Main Bot",
      homeserver: "https://matrix.example.org",
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
      dm: {
        policy: "allowlist",
        allowFrom: ["@alice:example.org"],
      },
      groupPolicy: "allowlist",
      groups: {
        "!ops-room:example.org": { enabled: true },
      },
      rooms: null,
    });

    expect(updated.channels?.["matrix"]?.dm?.policy).toBe("pairing");
    expect(updated.channels?.["matrix"]?.groups).toEqual({
      "!default:example.org": { enabled: true },
    });
    const account = updated.channels?.["matrix"]?.accounts?.ops;
    expect(account?.dm).toEqual({
      enabled: true,
      policy: "allowlist",
      allowFrom: ["@alice:example.org"],
    });
    expect(account?.groupPolicy).toBe("allowlist");
    expect(account?.groups).toEqual({
      "!ops-room:example.org": { enabled: true },
    });
    expect(account?.rooms).toBeUndefined();
  });

  it("reuses and canonicalizes non-normalized account entries when updating", () => {
    const cfg = withAccount(
      { homeserver: "https://matrix.ops.example.org", accessToken: "ops-token" },
      "Ops",
    );

    const updated = updateMatrixAccountConfig(cfg, "ops", {
      deviceName: "Ops Bot",
    });

    expect(updated.channels?.["matrix"]?.accounts?.Ops).toBeUndefined();
    const account = updated.channels?.["matrix"]?.accounts?.ops;
    expect(account).toMatchObject({
      homeserver: "https://matrix.ops.example.org",
      accessToken: "ops-token",
      deviceName: "Ops Bot",
      enabled: true,
    });
  });
});
