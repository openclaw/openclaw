import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { describe, expect, it } from "vitest";
import type { CoreConfig } from "../../types.js";
import type { MatrixResolvedAllowlistEntry } from "./config.js";
import { createMatrixVerificationLiveAuthorizationResolver } from "./verification-live-authorization.js";

const runtime = { log: () => {}, error: () => {} } as unknown as RuntimeEnv;

function resolveWith(params: {
  cfg: CoreConfig;
  startupResolvedEntries?: MatrixResolvedAllowlistEntry[];
}) {
  return createMatrixVerificationLiveAuthorizationResolver({
    getConfig: () => params.cfg,
    accountId: "default",
    allowFromResolvedEntries: params.startupResolvedEntries ?? [],
    runtime,
  })();
}

describe("createMatrixVerificationLiveAuthorizationResolver", () => {
  it("keeps an opted-in name entry resolved through its startup id", async () => {
    const cfg = {
      channels: {
        matrix: {
          dangerouslyAllowNameMatching: true,
          dm: { allowFrom: ["Bob"] },
        },
      },
    } as CoreConfig;

    await expect(
      resolveWith({
        cfg,
        startupResolvedEntries: [{ input: "Bob", id: "@bob:example.org" }],
      }),
    ).resolves.toMatchObject({ allowFrom: ["@bob:example.org"] });
  });

  it("keeps access-group references symbolic for the shared resolver", async () => {
    const cfg = {
      channels: {
        matrix: {
          dm: { allowFrom: ["accessGroup:admins"] },
        },
      },
    } as CoreConfig;

    await expect(resolveWith({ cfg })).resolves.toMatchObject({
      allowFrom: ["accessGroup:admins"],
    });
  });
});
