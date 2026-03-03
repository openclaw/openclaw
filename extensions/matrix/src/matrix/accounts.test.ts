import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import { resolveDefaultMatrixAccountId, resolveMatrixAccount } from "./accounts.js";

vi.mock("./credentials.js", () => ({
  loadMatrixCredentials: () => null,
  credentialsMatchConfig: () => false,
}));

const envKeys = [
  "MATRIX_HOMESERVER",
  "MATRIX_USER_ID",
  "MATRIX_ACCESS_TOKEN",
  "MATRIX_PASSWORD",
  "MATRIX_DEVICE_NAME",
];

describe("resolveMatrixAccount", () => {
  let prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    prevEnv = {};
    for (const key of envKeys) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = prevEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("treats access-token-only config as configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok-access",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
  });

  it("requires userId + password when no access token is set", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(false);
  });

  it("marks password auth as configured when userId is present", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
  });
});

describe("resolveDefaultMatrixAccountId", () => {
  it("prefers channels.matrix.defaultAccount when it matches a configured account", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          defaultAccount: "alerts",
          accounts: {
            default: { homeserver: "https://matrix.example.org", accessToken: "tok-default" },
            alerts: { homeserver: "https://matrix.example.org", accessToken: "tok-alerts" },
          },
        },
      },
    };

    expect(resolveDefaultMatrixAccountId(cfg)).toBe("alerts");
  });

  it("normalizes channels.matrix.defaultAccount before lookup", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          defaultAccount: "Team Alerts",
          accounts: {
            "team-alerts": { homeserver: "https://matrix.example.org", accessToken: "tok-alerts" },
          },
        },
      },
    };

    expect(resolveDefaultMatrixAccountId(cfg)).toBe("team-alerts");
  });

  it("falls back when channels.matrix.defaultAccount is not configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          defaultAccount: "missing",
          accounts: {
            default: { homeserver: "https://matrix.example.org", accessToken: "tok-default" },
            alerts: { homeserver: "https://matrix.example.org", accessToken: "tok-alerts" },
          },
        },
      },
    };

    expect(resolveDefaultMatrixAccountId(cfg)).toBe("default");
  });
});
