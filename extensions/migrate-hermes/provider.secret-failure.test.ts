// Migrate Hermes tests cover provider.secret failure plugin behavior.
import path from "node:path";
import { resolveAuthStorePathForDisplay } from "openclaw/plugin-sdk/agent-runtime";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HERMES_REASON_AUTH_PROFILE_WRITE_FAILED } from "./items.js";
import { makeContext, makeHermesPaths, writeFile } from "./test/provider-helpers.js";

const mocks = vi.hoisted(() => ({
  updateAuthProfileStoreWithLock: vi.fn(async () => null),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  updateAuthProfileStoreWithLock: mocks.updateAuthProfileStoreWithLock,
}));

const { buildHermesMigrationProvider } = await import("./provider.js");

let testWorkspace: TempWorkspace;
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function authProfileTarget(agentDir: string, profileId: string): string {
  return `${resolveAuthStorePathForDisplay(agentDir)}#${profileId}`;
}

describe("Hermes migration provider secret write failures", () => {
  beforeEach(async () => {
    testWorkspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-hermes-secret-failure-",
    });
  });

  afterEach(async () => {
    await testWorkspace.cleanup();
    mocks.updateAuthProfileStoreWithLock.mockClear();
  });

  it("reports an error when a secret auth-profile write fails", async () => {
    const { root, source, workspaceDir, stateDir } = makeHermesPaths(testWorkspace.dir);
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");

    const provider = buildHermesMigrationProvider();
    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        reportDir: path.join(root, "report"),
        includeSecrets: true,
        overwrite: true,
      }),
    );

    expect(result.items).toEqual([
      {
        id: "secret:openai",
        kind: "secret",
        action: "create",
        source: path.join(source, ".env"),
        target: authProfileTarget(
          path.join(stateDir, "agents", "main", "agent"),
          "openai:hermes-import",
        ),
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
    expect(result.summary.errors).toBe(1);
    expect(result.summary.migrated).toBe(0);
  });

  it("reports an error when an OAuth auth-profile write fails", async () => {
    const { root, source, workspaceDir, stateDir } = makeHermesPaths(testWorkspace.dir);
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
    await writeFile(
      opencodeAuthPath,
      JSON.stringify({
        openai: {
          type: "oauth",
          access: accessToken,
          refresh: "refresh-fail-token",
        },
      }),
    );

    const provider = buildHermesMigrationProvider();
    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        reportDir: path.join(root, "report"),
        includeSecrets: true,
        overwrite: true,
      }),
    );

    expect(result.items).toEqual([
      expect.objectContaining({
        id: "auth:openai",
        kind: "auth",
        action: "create",
        source: opencodeAuthPath,
        target: authProfileTarget(
          path.join(stateDir, "agents", "main", "agent"),
          "openai:account-acct_fail",
        ),
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
    expect(result.summary.errors).toBe(1);
    expect(result.summary.migrated).toBe(0);
  });
});
