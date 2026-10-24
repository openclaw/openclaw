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
const update = (account: MatrixConfig, patch: Parameters<typeof updateMatrixAccountConfig>[2]) =>
  updateMatrixAccountConfig(withAccount(account), "default", patch).channels?.matrix?.accounts
    ?.default;

describe("updateMatrixAccountConfig", () => {
  it("resolves account-aware Matrix config field paths", () => {
    expect(resolveMatrixConfigFieldPath({}, "default", "dm.policy")).toBe(
      "channels.matrix.dm.policy",
    );

    const cfg = withAccount({}, "ops");

    expect(resolveMatrixConfigFieldPath(cfg, "ops", ".dm.allowFrom")).toBe(
      "channels.matrix.accounts.ops.dm.allowFrom",
    );
  });

  it.each([
    {
      name: "explicit null clears and boolean false values",
      initial: {
        homeserver,
        userId: "@bot:example.org",
        accessToken: "old-token", // pragma: allowlist secret
        password: "old-password", // pragma: allowlist secret
        encryption: true,
      },
      patch: { accessToken: "new-token", password: null, userId: null, encryption: false },
      expected: { homeserver, accessToken: "new-token", encryption: false },
    },
    {
      name: "allowBots updates and private-network/proxy clears",
      initial: {
        allowBots: true,
        network: { dangerouslyAllowPrivateNetwork: true },
        proxy: "http://127.0.0.1:7890",
      },
      patch: { allowBots: "mentions", allowPrivateNetwork: null, proxy: null },
      expected: { allowBots: "mentions" },
    },
  ] satisfies {
    name: string;
    initial: MatrixConfig;
    patch: MatrixAccountPatch;
    expected: MatrixConfig;
  }[])("supports $name", ({ initial, patch, expected }) => {
    expect(update(initial, patch)).toEqual({ ...expected, enabled: true });
  });

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
    const updated = updateMatrixAccountConfig({}, "Main Bot", {
      name: "Main Bot",
      homeserver,
    });

    const account = updated.channels?.["matrix"]?.accounts?.["main-bot"];
    expect(account).toMatchObject({
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

    expect(updated.channels?.matrix?.dm?.policy).toBe("pairing");
    expect(updated.channels?.matrix?.groups).toEqual({ "!default:example.org": { enabled: true } });
    const account = updated.channels?.["matrix"]?.accounts?.ops;
    expect(account?.dm).toEqual({
      enabled: true,
      policy: "allowlist",
      allowFrom: ["@alice:example.org"],
    });
    expect(account?.groupPolicy).toBe("allowlist");
    expect(account?.groups).toEqual({ "!ops-room:example.org": { enabled: true } });
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
