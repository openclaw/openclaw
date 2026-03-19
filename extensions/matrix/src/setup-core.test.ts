import { describe, expect, it } from "vitest";
import { matrixSetupAdapter } from "./setup-core.js";
import type { CoreConfig } from "./types.js";

describe("matrixSetupAdapter", () => {
  it("moves legacy default config before writing a named account", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@default:example.org",
          accessToken: "default-token",
          deviceName: "Default device",
        },
      },
    } as CoreConfig;

    const next = matrixSetupAdapter.applyAccountConfig({
      cfg,
      accountId: "ops",
      input: {
        name: "Ops",
        homeserver: "https://matrix.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-token",
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.userId).toBeUndefined();
    expect(next.channels?.matrix?.accessToken).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.default).toMatchObject({
      homeserver: "https://matrix.example.org",
      userId: "@default:example.org",
      accessToken: "default-token",
      deviceName: "Default device",
    });
    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      name: "Ops",
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
    });
  });

  it("clears stored auth fields when switching an account to env-backed auth", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              name: "Ops",
              homeserver: "https://matrix.example.org",
              userId: "@ops:example.org",
              accessToken: "ops-token",
              password: "secret",
              deviceId: "DEVICE",
              deviceName: "Ops device",
            },
          },
        },
      },
    } as CoreConfig;

    const next = matrixSetupAdapter.applyAccountConfig({
      cfg,
      accountId: "ops",
      input: {
        name: "Ops",
        useEnv: true,
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      name: "Ops",
      enabled: true,
    });
    expect(next.channels?.matrix?.accounts?.ops?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.userId).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.accessToken).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.password).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.deviceId).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.deviceName).toBeUndefined();
  });
});
