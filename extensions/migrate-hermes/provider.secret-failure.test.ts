import path from "node:path";
import { resolveAuthStorePathForDisplay } from "openclaw/plugin-sdk/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { HERMES_REASON_AUTH_PROFILE_WRITE_FAILED } from "./items.js";
import { fakeJwt } from "./test/auth-helpers.js";
import { useHermesFixture, writeJson } from "./test/migration-fixture.js";
import { writeFile } from "./test/provider-helpers.js";

const mocks = vi.hoisted(() => ({ updateAuthProfileStoreWithLock: vi.fn(async () => null) }));

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
  it.each(["secret", "auth"] as const)("reports a failed %s auth-profile write", async (kind) => {
    const { root, source } = fixture.paths;
    const profileId = kind === "secret" ? "openai:hermes-import" : "openai:account-acct_fail";
    const input =
      kind === "secret"
        ? path.join(source, ".env")
        : path.join(root, ".local", "share", "opencode", "auth.json");
    if (kind === "secret") {
      await writeFile(input, "OPENAI_API_KEY=sk-hermes\n");
    } else {
      const access = fakeJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/profile": { email: "codex@example.test" },
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_fail",
          chatgpt_plan_type: "plus",
        },
      });
      await writeFile(path.join(source, "auth.json"), "{}");
      await writeJson(input, { openai: { type: "oauth", access, refresh: "refresh-fail-token" } });
    }
    const result = await apply();
    const details = { provider: "openai", profileId };
    const expected = {
      id: `${kind}:openai`,
      kind,
      action: "create",
      source: input,
      target: authProfileTarget(profileId),
      status: "error",
      sensitive: true,
      reason: HERMES_REASON_AUTH_PROFILE_WRITE_FAILED,
    };
    expect(result.items).toEqual([
      kind === "secret"
        ? { ...expected, details: { ...details, envVar: "OPENAI_API_KEY" } }
        : expect.objectContaining({
            ...expected,
            details: expect.objectContaining({ ...details, sourceProfileId: profileId }),
          }),
    ]);
    expect(result.summary).toMatchObject({ errors: 1, migrated: 0 });
  });
});
