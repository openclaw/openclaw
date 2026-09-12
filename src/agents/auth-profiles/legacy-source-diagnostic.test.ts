import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  assertAuthProfileMigrationReady,
  AuthProfileMigrationRequiredError,
  clearAuthProfileMigrationDiagnostics,
  markAuthProfileMigrationRequired,
} from "./legacy-source-diagnostic.js";
import { writePersistedAuthProfileStoreRaw } from "./sqlite.js";

afterEach(() => {
  clearAuthProfileMigrationDiagnostics();
});

describe("assertAuthProfileMigrationReady", () => {
  it("retains recorded provider refusals across repeated lifecycle marks", async () => {
    await withTestDir({ prefix: "openclaw-auth-retained-scope-" }, async (agentDir) => {
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
        expect(() => assertAuthProfileMigrationReady(agentDir, undefined, provider)).toThrow(
          "affected providers: anthropic, nvidia",
        );
      }
      expect(() => assertAuthProfileMigrationReady(agentDir, undefined, "litellm")).not.toThrow();
    });
  });

  it.each([
    {
      name: "canonical",
      raw: JSON.stringify({
        version: 1,
        profiles: {
          "anthropic:default": { type: "api_key", provider: "anthropic", key: "legacy-key" },
        },
      }),
      scoped: true,
    },
    { name: "flat", raw: JSON.stringify({ anthropic: { apiKey: "legacy-key" } }), scoped: true },
    {
      name: "legacy OpenAI provider",
      raw: JSON.stringify({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "legacy-access",
            refresh: "legacy-refresh",
          },
        },
      }),
      scoped: true,
      blockedProvider: "openai",
    },
    { name: "malformed JSON", raw: "{broken", scoped: false },
    { name: "metadata-only flat object", raw: '{"metadata":{}}', scoped: false },
    {
      name: "unknown flat fields",
      raw: '{"anthropic":{"unknown":"value"},"openai":{"other":true}}',
      scoped: false,
    },
    {
      name: "mixed flat metadata",
      raw: '{"anthropic":{"apiKey":"synthetic-key"},"metadata":{}}',
      scoped: false,
    },
    {
      name: "unrecognized canonical entry",
      raw: '{"profiles":{"anthropic:default":{"provider":"anthropic","unknown":true}}}',
      scoped: false,
    },
    {
      name: "missing provider",
      raw: JSON.stringify({
        version: 1,
        profiles: {
          "anthropic:default": { type: "api_key", key: "legacy-key" },
        },
      }),
      scoped: false,
    },
  ])(
    "preserves migration safety for $name sources",
    async ({ raw, scoped, blockedProvider = "anthropic" }) => {
      await withTestDir({ prefix: "openclaw-auth-provider-scope-" }, async (agentDir) => {
        const legacyPath = path.join(agentDir, "auth-profiles.json");
        await fs.writeFile(legacyPath, raw);
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
        const sibling = () => assertAuthProfileMigrationReady(agentDir, undefined, "litellm");
        if (scoped) {
          expect(sibling).not.toThrow();
        } else {
          expect(sibling).toThrow("affected providers: all (legacy provider scope unavailable)");
          expect(() => assertAuthProfileMigrationReady(agentDir, undefined, "openai")).toThrow(
            "affected providers: all (legacy provider scope unavailable)",
          );
        }
        expect(() => assertAuthProfileMigrationReady(agentDir, undefined, blockedProvider)).toThrow(
          "run openclaw doctor --fix",
        );
        // An unscoped operation still cannot publish or mutate this owner.
        expect(() => assertAuthProfileMigrationReady(agentDir)).toThrow(
          "requires legacy credential migration",
        );
        expect(await fs.readFile(legacyPath, "utf8")).toBe(raw);
      });
    },
  );

  it("reports only credential sources without marking runtime migration state", async () => {
    await withTestDir({ prefix: "openclaw-auth-migration-diagnostic-" }, async (root) => {
      const credentialAgentDir = path.join(root, "credential-agent");
      const authStateAgentDir = path.join(root, "auth-state-agent");
      await fs.mkdir(credentialAgentDir, { recursive: true });
      await fs.mkdir(authStateAgentDir, { recursive: true });
      const credentialPath = path.join(credentialAgentDir, "auth-profiles.json");
      await fs.writeFile(credentialPath, "{}\n");
      await fs.writeFile(path.join(authStateAgentDir, "auth-state.json"), "{}\n");

      // An auth-state file carries no credentials, so it never blocks its owner.
      expect(() => assertAuthProfileMigrationReady(authStateAgentDir)).not.toThrow();
      expect(() => assertAuthProfileMigrationReady(credentialAgentDir)).toThrow(
        "requires legacy credential migration",
      );
      clearAuthProfileMigrationDiagnostics();

      await fs.rm(credentialPath);
      expect(() => assertAuthProfileMigrationReady(credentialAgentDir)).not.toThrow();
    });
  });

  it("clears the requirement once the canonical store holds credentials", async () => {
    await withTestDir({ prefix: "openclaw-auth-migration-migrated-" }, async (root) => {
      const agentDir = path.join(root, "migrated-agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, "auth.json"), '{"openai":{"key":"not-a-real"}}\n');

      // Unmigrated: the credentials exist only in the retired file.
      expect(() => assertAuthProfileMigrationReady(agentDir)).toThrow(
        "requires legacy credential migration",
      );
      clearAuthProfileMigrationDiagnostics();

      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key: "not-a-real" },
          },
        },
        agentDir,
      );

      // Migrated: the same leftover file must not strand a working store.
      expect(() => assertAuthProfileMigrationReady(agentDir)).not.toThrow();
    });
  });
});
