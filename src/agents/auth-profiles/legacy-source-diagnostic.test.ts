import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  createApiKeyCredential as apiKey,
  createAuthProfileStoreFixture,
} from "./credential-fixtures.test-support.js";
import { refreshAuthProfileFileState } from "./file-state.js";
import {
  assertAuthProfileMigrationReady as assertReady,
  AuthProfileMigrationRequiredError,
  clearAuthProfileMigrationDiagnostics,
  markAuthProfileMigrationRequired,
} from "./legacy-source-diagnostic.js";
import { closeAuthProfileReadPool, writePersistedAuthProfileStoreRaw } from "./sqlite.js";

async function withProfileDir(run: (dir: string) => Promise<void>): Promise<void> {
  await withTestDir({ prefix: "openclaw-auth-migration-" }, async (dir) => {
    try {
      await run(dir);
    } finally {
      closeAuthProfileReadPool({ kind: "root", rootPath: dir });
      await cleanupSessionStateForTest({ stateDir: dir });
    }
  });
}
const canonicalEntry = (profile: Record<string, unknown>, id = "anthropic:default") =>
  JSON.stringify(createAuthProfileStoreFixture({ [id]: profile }));
const legacyOAuth = { type: "oauth", provider: "openai-codex", access: "a", refresh: "r" };

afterEach(clearAuthProfileMigrationDiagnostics);

describe("assertAuthProfileMigrationReady", () => {
  it("retains recorded provider refusals across repeated lifecycle marks", async () => {
    await withProfileDir(async (agentDir) => {
      const legacyPath = path.join(agentDir, "auth-profiles.json");
      for (const provider of ["anthropic", "nvidia"]) {
        await fs.writeFile(legacyPath, JSON.stringify({ [provider]: { apiKey: "legacy-key" } }));
        markAuthProfileMigrationRequired(
          agentDir,
          new AuthProfileMigrationRequiredError({
            agentDir,
            sources: [{ kind: "auth-profiles", path: legacyPath }],
          }),
        );
      }
      await fs.rm(legacyPath);
      for (const provider of ["anthropic", "nvidia"]) {
        expect(() => assertReady(agentDir, undefined, provider)).toThrow(
          "affected providers: anthropic, nvidia",
        );
      }
      expect(() => assertReady(agentDir, undefined, "litellm")).not.toThrow();
    });
  });

  it.each([
    ["canonical", canonicalEntry(apiKey("anthropic", "legacy-key")), true],
    ["flat", JSON.stringify({ anthropic: { apiKey: "legacy-key" } }), true],
    ["legacy OpenAI provider", canonicalEntry(legacyOAuth, "openai-codex:default"), true, "openai"],
    ["malformed JSON", "{broken", false],
    ["metadata-only flat object", '{"metadata":{}}', false],
    ["unknown flat fields", '{"anthropic":{"unknown":"value"},"openai":{"other":true}}', false],
    ["mixed flat metadata", '{"anthropic":{"apiKey":"synthetic-key"},"metadata":{}}', false],
    [
      "unrecognized canonical entry",
      '{"profiles":{"anthropic:default":{"provider":"anthropic","unknown":true}}}',
      false,
    ],
    ["missing provider", canonicalEntry({ type: "api_key", key: "legacy-key" }), false],
  ] as const)(
    "preserves migration safety for %s sources",
    async (_name, raw, scoped, blockedProvider?: string) => {
      await withProfileDir(async (agentDir) => {
        const legacyPath = path.join(agentDir, "auth-profiles.json");
        await fs.writeFile(legacyPath, raw);
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
        const ready = (provider?: string) => () => assertReady(agentDir, undefined, provider);
        const unscoped = "affected providers: all (legacy provider scope unavailable)";
        if (scoped) {
          expect(ready("litellm")).not.toThrow();
        } else {
          expect(ready("litellm")).toThrow(unscoped);
          expect(ready("openai")).toThrow(unscoped);
        }
        expect(ready(blockedProvider ?? "anthropic")).toThrow("run openclaw doctor --fix");
        // An unscoped operation still cannot publish or mutate this owner.
        expect(ready()).toThrow("requires legacy credential migration");
        expect(await fs.readFile(legacyPath, "utf8")).toBe(raw);
      });
    },
  );

  it("reports only credential sources without marking runtime migration state", async () => {
    await withProfileDir(async (root) => {
      const credentialAgentDir = path.join(root, "credential-agent");
      const authStateAgentDir = path.join(root, "auth-state-agent");
      await fs.mkdir(credentialAgentDir, { recursive: true });
      await fs.mkdir(authStateAgentDir, { recursive: true });
      const credentialPath = path.join(credentialAgentDir, "auth-profiles.json");
      await fs.writeFile(credentialPath, "{}\n");
      await fs.writeFile(path.join(authStateAgentDir, "auth-state.json"), "{}\n");

      // An auth-state file carries no credentials, so it never blocks its owner.
      expect(() => assertReady(authStateAgentDir)).not.toThrow();
      expect(() => assertReady(credentialAgentDir)).toThrow("requires legacy credential migration");
      clearAuthProfileMigrationDiagnostics();

      await fs.rm(credentialPath);
      await refreshAuthProfileFileState();
      expect(() => assertReady(credentialAgentDir)).not.toThrow();
    });
  });

  it("clears the requirement once the canonical store holds credentials", async () => {
    await withProfileDir(async (agentDir) => {
      await fs.writeFile(path.join(agentDir, "auth.json"), '{"openai":{"key":"not-a-real"}}\n');

      expect(() => assertReady(agentDir)).toThrow("requires legacy credential migration");
      clearAuthProfileMigrationDiagnostics();

      writePersistedAuthProfileStoreRaw(
        createAuthProfileStoreFixture({
          "openai:default": apiKey("openai", "not-a-real"),
        }),
        agentDir,
      );

      expect(() => assertReady(agentDir)).not.toThrow();
    });
  });
});
