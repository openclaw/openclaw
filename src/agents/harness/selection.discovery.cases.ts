import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import type { SkillLibraryRequestOwner } from "../../gateway/server-methods/skills-library.js";
import { prepareGatewaySkillAuthoring } from "../../gateway/skill-library-authoring.js";
import { captureGatewayToolDiscovery } from "../../gateway/tool-discovery.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runEmbeddedAttemptWithBackend } from "../embedded-agent-runner/run/backend.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { createOpenClawOnlyToolConstructionPlan } from "../test-helpers/tool-construction-plan.js";
import { createAttemptResult, registerHarness } from "./selection.test-support.js";

/** Registers under the selection suite's existing registry/generation lifecycle. */
export function registerSelectionDiscoveryCases({
  readState,
  createAttemptParams,
  providerRuntimeConfig,
}: {
  readState: () => OpenClawTestState;
  createAttemptParams: (config?: OpenClawConfig) => EmbeddedRunAttemptParams;
  providerRuntimeConfig: (provider: string, runtime: string) => OpenClawConfig;
}): void {
  it("reconstructs private discovery at the backend before a native plugin builds its host catalog", async () => {
    const generationState = readState();
    generationState.applyEnv();
    const storePath = generationState.statePath("discovery.sqlite");
    const sessionKey = "agent:main:native-discovery";
    const sessionId = "native-discovery";
    const config: OpenClawConfig = {
      ...providerRuntimeConfig("codex", "codex"),
      session: { store: storePath },
      agents: { entries: { main: {} } },
      tools: { allow: ["skill_library"], toolSearch: false },
      gateway: {
        roles: {
          default: "admin",
          definitions: {
            admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "view" } },
          },
        },
      },
    };
    await generationState.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    await replaceSessionEntry(
      { agentId: "main", storePath, sessionKey },
      { sessionId, updatedAt: 1 },
    );
    const profile = ensureProfileForEmail("native-discovery@example.test");
    const catalog = await prepareUserProfileCatalog();
    try {
      const owner: SkillLibraryRequestOwner = {
        client: {
          authenticatedUserProfile: { profileId: profile.id },
          connect: { scopes: ["operator.admin"] },
          // SAFETY: Skill-library authoring reads only the profile and scopes of this test client.
        } as SkillLibraryRequestOwner["client"],
        // SAFETY: Skill-library authoring reads only runtime config from the request context.
        context: { getRuntimeConfig: () => config } as SkillLibraryRequestOwner["context"],
      };
      const authoring = await prepareGatewaySkillAuthoring(owner, sessionKey, true);
      const descriptors: string[] = [];
      registerHarness({
        conversationToolPolicySupport: "exact",
        runAttempt: async (attempt) => {
          expect(attempt).not.toHaveProperty("toolDiscoveryCapture");
          expect(attempt).not.toHaveProperty("toolDiscoveryPreparation");
          const tools = await attempt.hostCapabilities!.createToolSurfaceAsync!({
            config,
            agentId: "main",
            sessionKey,
            workspaceDir: generationState.workspaceDir,
            toolConstructionPlan: createOpenClawOnlyToolConstructionPlan(),
          });
          const library = tools.find((tool) => tool.name === "skill_library");
          descriptors.push(
            library
              ? JSON.stringify({ description: library.description, parameters: library.parameters })
              : "absent",
          );
          return createAttemptResult("codex");
        },
      });
      const params = {
        ...createAttemptParams(config),
        agentHarnessId: "codex",
        sessionId,
        sessionKey,
        sessionTarget: { agentId: "main", sessionId, sessionKey, storePath },
        workspaceDir: generationState.workspaceDir,
      };
      await runEmbeddedAttemptWithBackend({
        ...params,
        skillLibraryAuthoring: authoring,
        toolDiscoveryCapture: captureGatewayToolDiscovery(owner, true, authoring),
      });
      await closeOpenClawAgentDatabasesAsync();
      await runEmbeddedAttemptWithBackend(params);
      expect(descriptors).toHaveLength(2);
      expect(descriptors[1]).toBe(descriptors[0]);
      expect(descriptors[1]).toContain("requesting person's personal library");
      await addSessionMember(
        { agentId: "main", storePath, sessionKey },
        { identityId: "another-person", addedBy: profile.id },
      );
      await runEmbeddedAttemptWithBackend(params);
      // A changed audience invalidates the saved presentation, and no live grant remains.
      expect(descriptors[2]).toBe("absent");
    } finally {
      catalog.release();
    }
  });
}
