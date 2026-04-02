import { describe, expect, it } from "vitest";
import {
  requiresExplicitMatrixDefaultAccount,
  resolveConfiguredMatrixAccountIds,
  resolveMatrixDefaultOrOnlyAccountId,
} from "./account-selection.js";
import type { CoreConfig } from "./types.js";

describe("Matrix account selection topology", () => {
  it("includes a top-level default account when its auth is actually complete", () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "default-token",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_HOMESERVER: "https://matrix.example.org",
    } as NodeJS.ProcessEnv;

    expect(resolveConfiguredMatrixAccountIds(cfg, env)).toEqual(["default", "ops"]);
    expect(resolveMatrixDefaultOrOnlyAccountId(cfg, env)).toBe("default");
    expect(requiresExplicitMatrixDefaultAccount(cfg, env)).toBe(true);
  });

  it("does not materialize a top-level default account from partial shared auth fields", () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "shared-token",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    expect(resolveConfiguredMatrixAccountIds(cfg, {} as NodeJS.ProcessEnv)).toEqual(["ops"]);
    expect(resolveMatrixDefaultOrOnlyAccountId(cfg, {} as NodeJS.ProcessEnv)).toBe("ops");
    expect(requiresExplicitMatrixDefaultAccount(cfg, {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("does not materialize a default env account from partial global auth fields", () => {
    const cfg = {
      channels: {
        matrix: {},
      },
    } as CoreConfig;
    const env = {
      MATRIX_ACCESS_TOKEN: "shared-token",
      MATRIX_OPS_HOMESERVER: "https://matrix.example.org",
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
    } as NodeJS.ProcessEnv;

    expect(resolveConfiguredMatrixAccountIds(cfg, env)).toEqual(["ops"]);
    expect(resolveMatrixDefaultOrOnlyAccountId(cfg, env)).toBe("ops");
    expect(requiresExplicitMatrixDefaultAccount(cfg, env)).toBe(false);
  });

  it("does not materialize a top-level default account from homeserver plus userId alone", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@default:example.org",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    expect(resolveConfiguredMatrixAccountIds(cfg, {} as NodeJS.ProcessEnv)).toEqual(["ops"]);
    expect(resolveMatrixDefaultOrOnlyAccountId(cfg, {} as NodeJS.ProcessEnv)).toBe("ops");
    expect(requiresExplicitMatrixDefaultAccount(cfg, {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("does not materialize a default env account from global homeserver plus userId alone", () => {
    const cfg = {
      channels: {
        matrix: {},
      },
    } as CoreConfig;
    const env = {
      MATRIX_HOMESERVER: "https://matrix.example.org",
      MATRIX_USER_ID: "@default:example.org",
      MATRIX_OPS_HOMESERVER: "https://matrix.example.org",
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
    } as NodeJS.ProcessEnv;

    expect(resolveConfiguredMatrixAccountIds(cfg, env)).toEqual(["ops"]);
    expect(resolveMatrixDefaultOrOnlyAccountId(cfg, env)).toBe("ops");
    expect(requiresExplicitMatrixDefaultAccount(cfg, env)).toBe(false);
  });

  it("counts env-backed named accounts when shared homeserver comes from channel config", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
    } as NodeJS.ProcessEnv;

    expect(resolveConfiguredMatrixAccountIds(cfg, env)).toEqual(["ops"]);
    expect(resolveMatrixDefaultOrOnlyAccountId(cfg, env)).toBe("ops");
    expect(requiresExplicitMatrixDefaultAccount(cfg, env)).toBe(false);
  });

  it("keeps env-backed named accounts that rely on cached credentials", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_OPS_USER_ID: "@ops:example.org",
    } as NodeJS.ProcessEnv;

    expect(resolveConfiguredMatrixAccountIds(cfg, env)).toEqual(["ops"]);
    expect(resolveMatrixDefaultOrOnlyAccountId(cfg, env)).toBe("ops");
    expect(requiresExplicitMatrixDefaultAccount(cfg, env)).toBe(false);
  });
});
