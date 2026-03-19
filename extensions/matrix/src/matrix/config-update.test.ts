import { describe, expect, it } from "vitest";
import type { CoreConfig } from "../types.js";
import { resolveMatrixConfigFieldPath, updateMatrixAccountConfig } from "./config-update.js";

describe("updateMatrixAccountConfig", () => {
  it("resolves account-aware Matrix config field paths", () => {
    expect(resolveMatrixConfigFieldPath({} as CoreConfig, "default", "dm.policy")).toBe(
      "channels.matrix.dm.policy",
    );

    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {},
          },
        },
      },
    } as CoreConfig;

    expect(resolveMatrixConfigFieldPath(cfg, "ops", ".dm.allowFrom")).toBe(
      "channels.matrix.accounts.ops.dm.allowFrom",
    );
  });

  it("supports explicit null clears and boolean false values", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "old-token", // pragma: allowlist secret
              password: "old-password", // pragma: allowlist secret
              encryption: true,
            },
          },
        },
      },
    } as CoreConfig;

    const updated = updateMatrixAccountConfig(cfg, "default", {
      accessToken: "new-token",
      password: null,
      userId: null,
      encryption: false,
    });

    expect(updated.channels?.["matrix"]?.accounts?.default).toMatchObject({
      accessToken: "new-token",
      encryption: false,
    });
    expect(updated.channels?.["matrix"]?.accounts?.default?.password).toBeUndefined();
    expect(updated.channels?.["matrix"]?.accounts?.default?.userId).toBeUndefined();
  });

  it("normalizes account id and defaults account enabled=true", () => {
    const updated = updateMatrixAccountConfig({} as CoreConfig, "Main Bot", {
      name: "Main Bot",
      homeserver: "https://matrix.example.org",
    });

    expect(updated.channels?.["matrix"]?.accounts?.["main-bot"]).toMatchObject({
      name: "Main Bot",
      homeserver: "https://matrix.example.org",
      enabled: true,
    });
  });

  it("updates nested access config for named accounts without touching top-level defaults", () => {
    const cfg = {
      channels: {
        matrix: {
          dm: {
            policy: "pairing",
          },
          groups: {
            "!default:example.org": { allow: true },
          },
          accounts: {
            ops: {
              homeserver: "https://matrix.ops.example.org",
              accessToken: "ops-token",
              dm: {
                enabled: true,
                policy: "pairing",
              },
            },
          },
        },
      },
    } as CoreConfig;

    const updated = updateMatrixAccountConfig(cfg, "ops", {
      dm: {
        policy: "allowlist",
        allowFrom: ["@alice:example.org"],
      },
      groupPolicy: "allowlist",
      groups: {
        "!ops-room:example.org": { allow: true },
      },
      rooms: null,
    });

    expect(updated.channels?.["matrix"]?.dm?.policy).toBe("pairing");
    expect(updated.channels?.["matrix"]?.groups).toEqual({
      "!default:example.org": { allow: true },
    });
    expect(updated.channels?.["matrix"]?.accounts?.ops).toMatchObject({
      dm: {
        enabled: true,
        policy: "allowlist",
        allowFrom: ["@alice:example.org"],
      },
      groupPolicy: "allowlist",
      groups: {
        "!ops-room:example.org": { allow: true },
      },
    });
    expect(updated.channels?.["matrix"]?.accounts?.ops?.rooms).toBeUndefined();
  });

  it("reuses and canonicalizes non-normalized account entries when updating", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            Ops: {
              homeserver: "https://matrix.ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    const updated = updateMatrixAccountConfig(cfg, "ops", {
      deviceName: "Ops Bot",
    });

    expect(updated.channels?.["matrix"]?.accounts?.Ops).toBeUndefined();
    expect(updated.channels?.["matrix"]?.accounts?.ops).toMatchObject({
      homeserver: "https://matrix.ops.example.org",
      accessToken: "ops-token",
      deviceName: "Ops Bot",
      enabled: true,
    });
  });
});
