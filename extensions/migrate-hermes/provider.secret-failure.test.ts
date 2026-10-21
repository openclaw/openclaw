import path from "node:path";
import { resolveAuthStorePathForDisplay } from "openclaw/plugin-sdk/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { HERMES_REASON_AUTH_PROFILE_WRITE_FAILED } from "./items.js";
import { fakeJwt } from "./test/auth-helpers.js";
import { useHermesFixture, writeJson } from "./test/migration-fixture.js";
import { writeFile } from "./test/provider-helpers.js";

const mocks = vi.hoisted(() => ({
  updateAuthProfileStoreWithLock: vi.fn(async () => null),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  updateAuthProfileStoreWithLock: mocks.updateAuthProfileStoreWithLock,
}));

const { buildHermesMigrationProvider } = await import("./provider.js");

const fixture = useHermesFixture(() => {
  mocks.updateAuthProfileStoreWithLock.mockClear();
});
const apply = () =>
  buildHermesMigrationProvider().apply(
    fixture.context({ reportDir: fixture.paths.reportDir, includeSecrets: true, overwrite: true }),
  );
const authProfileTarget = (profileId: string) =>
  `${resolveAuthStorePathForDisplay(fixture.paths.agentDir)}#${profileId}`;

describe("Hermes migration provider secret write failures", () => {
  it("reports an error when a secret auth-profile write fails", async () => {
    const { source } = fixture.paths;
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");

    const result = await apply();

    expect(result.items).toEqual([
      {
        id: "secret:openai",
        kind: "secret",
        action: "create",
        source: path.join(source, ".env"),
        target: authProfileTarget("openai:hermes-import"),
        status: "error",
        sensitive: true,
        reason: HERMES_REASON_AUTH_PROFILE_WRITE_FAILED,
        details: {
          envVar: "OPENAI_API_KEY",
          provider: "openai",
          profileId: "openai:hermes-import",
        },
      },
    ]);
    expect(result.summary).toMatchObject({ errors: 1, migrated: 0 });
  });

  it("reports an error when an OAuth auth-profile write fails", async () => {
    const { root, source } = fixture.paths;
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "codex@example.test" },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_fail",
        chatgpt_plan_type: "plus",
      },
    });
    await writeFile(path.join(source, "auth.json"), "{}");
    const opencodeAuthPath = path.join(root, ".local", "share", "opencode", "auth.json");
    await writeJson(opencodeAuthPath, {
      openai: { type: "oauth", access: accessToken, refresh: "refresh-fail-token" },
    });
    const result = await apply();

    expect(result.items).toEqual([
      expect.objectContaining({
        id: "auth:openai",
        kind: "auth",
        action: "create",
        source: opencodeAuthPath,
        target: authProfileTarget("openai:account-acct_fail"),
        status: "error",
        sensitive: true,
        reason: HERMES_REASON_AUTH_PROFILE_WRITE_FAILED,
        details: expect.objectContaining({
          provider: "openai",
          profileId: "openai:account-acct_fail",
          sourceProfileId: "openai:account-acct_fail",
        }),
      }),
    ]);
    expect(result.summary).toMatchObject({ errors: 1, migrated: 0 });
  });
});
