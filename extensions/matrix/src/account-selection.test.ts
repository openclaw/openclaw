// Matrix tests cover account selection plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  findMatrixAccountEntry,
  requiresExplicitMatrixDefaultAccount,
  resolveConfiguredMatrixAccountIds,
  resolveMatrixDefaultOrOnlyAccountId,
} from "./account-selection.js";
import { getMatrixScopedEnvVarNames } from "./env-vars.js";

describe("matrix account selection", () => {
  it("matches the default account against normalized Matrix account keys", () => {
    const cfg: OpenClawConfig = {
      channels: {
        matrix: {
          defaultAccount: "Team Ops",
          accounts: {
            "Ops Bot": { homeserver: "https://matrix.example.org" },
            "Team Ops": { homeserver: "https://matrix.example.org" },
          },
        },
      },
    };

    expect(resolveMatrixDefaultOrOnlyAccountId(cfg)).toBe("team-ops");
    expect(requiresExplicitMatrixDefaultAccount(cfg)).toBe(false);
  });

  it("finds the raw Matrix account entry by normalized account id", () => {
    const cfg: OpenClawConfig = {
      channels: {
        matrix: {
          accounts: {
            "Team Ops": {
              homeserver: "https://matrix.example.org",
              userId: "@ops:example.org",
            },
          },
        },
      },
    };

    expect(findMatrixAccountEntry(cfg, "team-ops")).toEqual({
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
    });
  });

  it.each([
    ["default-secret", "team-secret", ["default", "team-ops"], "default"],
    [" \t ", " \t ", ["default"], "default"],
  ] as const)(
    "selects accounts for global/scoped tokens %j / %j",
    (globalToken, scopedToken, ids, defaultId) => {
      const keys = getMatrixScopedEnvVarNames("team-ops");
      const cfg: OpenClawConfig = {
        channels: {
          matrix: {},
        },
      };
      const env = {
        MATRIX_HOMESERVER: "https://matrix.example.org",
        MATRIX_ACCESS_TOKEN: globalToken,
        [keys.homeserver]: "https://matrix.example.org",
        [keys.accessToken]: scopedToken,
      } satisfies NodeJS.ProcessEnv;

      expect(resolveConfiguredMatrixAccountIds(cfg, env)).toEqual(ids);
      expect(resolveMatrixDefaultOrOnlyAccountId(cfg, env)).toBe(defaultId);
      expect(requiresExplicitMatrixDefaultAccount(cfg, env)).toBe(false);
    },
  );

  it("discovers default Matrix accounts backed only by global env vars", () => {
    const cfg: OpenClawConfig = {};
    const env = {
      MATRIX_HOMESERVER: "https://matrix.example.org",
      MATRIX_ACCESS_TOKEN: "default-secret",
    } satisfies NodeJS.ProcessEnv;

    expect(resolveConfiguredMatrixAccountIds(cfg, env)).toEqual(["default"]);
    expect(resolveMatrixDefaultOrOnlyAccountId(cfg, env)).toBe("default");
  });
});
