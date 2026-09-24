import { describe, expect, it } from "vitest";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveAgentWorkspaceDir,
  tryResolveLegacyCompatibilityAgentId,
} from "./agent-scope-config.js";
import { resolveLegacyInheritedAuthAgentId } from "./legacy-inherited-auth-dir.js";

describe("legacy inherited auth ownership", () => {
  it("uses the raw legacy marker owner for direct config inputs", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, ops: { default: true } } },
    };

    expect(resolveLegacyInheritedAuthAgentId(cfg)).toBe("ops");
  });

  it.each(["main", "ops"])(
    "keeps migrated %s data separate from a different recorded runtime default",
    (legacyId) => {
      const migrated = migratePersistedImplicitMainRoster(
        {
          agents: {
            defaults: { workspace: "/srv/shared", systemAgent: { agentId: "research" } },
            entries: { [legacyId]: { default: true }, research: {} },
          },
          session: { store: "/srv/sessions.json" },
        },
        { materializeWorkspace: true },
      ).config as OpenClawConfig;
      migrated.agents!.ownership = "explicit";
      const reloaded = structuredClone(migrated);

      expect(tryResolveLegacyCompatibilityAgentId(reloaded)).toBe("research");
      expect(resolveLegacyInheritedAuthAgentId(reloaded)).toBe(legacyId);
      expect(resolveSessionStoreCompatibilityAgentId(reloaded)).toBe(legacyId);
      expect(resolveAgentWorkspaceDir(reloaded, legacyId)).toBe("/srv/shared");
      expect(resolveAgentWorkspaceDir(reloaded, "research")).toBe("/srv/shared/research");
    },
  );

  it("keeps unpinned legacy data locators independent of explicit runtime selection", () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { workspace: "/srv/shared", systemAgent: { agentId: "research" } },
        entries: { main: {}, research: {} },
      },
    };

    expect(resolveLegacyInheritedAuthAgentId(config)).toBe("main");
    expect(resolveSessionStoreCompatibilityAgentId(config)).toBe("main");
    expect(resolveAgentWorkspaceDir(config, "research")).toBe("/srv/shared/research");
  });
});
