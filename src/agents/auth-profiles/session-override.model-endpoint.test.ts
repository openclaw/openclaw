import path from "node:path";
import { expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { OpenClawSchema } from "../../config/zod-schema.js";
import { applyModelOverrideWithAuthProfileCompatibility } from "../../sessions/auth-profile-preservation.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
} from "../embedded-agent-runner/model.js";
import { makeModel } from "../embedded-agent-runner/model.test-harness.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import { resolveSessionAuthSelection } from "./session-override.js";

const directEndpoint = "https://api.arcee.ai/api/v1";
const routerEndpoint = "https://openrouter.ai/api/v1";
const profiles = {
  "arcee:work": createApiKeyCredential("arcee", "synthetic-work-key"),
  "arcee:other": createApiKeyCredential("arcee", "synthetic-other-key"),
  "openrouter:default": createApiKeyCredential("openrouter", "synthetic-router-key"),
};
it.each([
  ["user", "arcee:work", directEndpoint, "arcee:work", "user", "main"],
  ["user-link", "arcee:work", directEndpoint, "arcee:work", "user-link", "writer"],
  ["user", "openrouter:default", directEndpoint, "arcee:other", "auto", "main"],
  ["auto", "arcee:work", directEndpoint, "arcee:other", "auto", "main"],
  ["user", "openrouter:default", routerEndpoint, "openrouter:default", "user", "main"],
] as const)(
  "resolves %s pin %s at %s to %s (%s) for %s before session mutation",
  async (source, pin, modelEndpoint, expectedPin, expectedSource, agentId) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "session-endpoint-pin-" },
      async (state) => {
        const cfg: OpenClawConfig = {
          plugins: { allow: ["arcee"] },
          auth: {
            profiles: Object.fromEntries(
              Object.entries(profiles).map(([id, { provider }]) => [
                id,
                { provider, mode: "api_key" as const },
              ]),
            ),
            order: { arcee: ["arcee:other", "arcee:work"], openrouter: ["openrouter:default"] },
          },
          models: {
            providers: {
              arcee: {
                baseUrl: routerEndpoint,
                api: "openai-completions",
                models: [
                  {
                    ...makeModel("trinity-large-thinking"),
                    api: "openai-completions",
                    baseUrl: modelEndpoint,
                    reasoning: true,
                  },
                ],
              },
            },
          },
        };
        expect(OpenClawSchema.safeParse(cfg).success).toBe(true);
        await state.writeConfig(cfg);
        await state.writeAuthProfiles({ version: 1, profiles }, agentId);
        const { model } = await resolveModelAsync(
          "arcee",
          "trinity-large-thinking",
          state.agentDir(agentId),
          cfg,
          createEmptyAgentDiscoveryStores(),
        );
        expect(model?.baseUrl).toBe(modelEndpoint);

        const sessionKey = `agent:${agentId}:endpoint-pin`;
        const sessionEntry: SessionEntry = {
          sessionId: "endpoint-pin-session",
          updatedAt: 1,
          providerOverride: "arcee",
          modelOverride: "trinity-large-thinking",
          model: "trinity-large-thinking",
          authProfileOverride: pin,
          authProfileOverrideSource: source,
        };
        const scope = {
          storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
          sessionKey,
        };
        await replaceSessionEntry(scope, sessionEntry);
        const selection = await resolveSessionAuthSelection({
          agentId,
          cfg,
          provider: "arcee",
          modelId: "trinity-large-thinking",
          agentDir: state.agentDir(agentId),
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          ...scope,
          isNewSession: source === "auto",
        });

        expect.soft(selection).toMatchObject({
          profileId: expectedPin,
          source: expectedSource === "user-link" ? "user" : expectedSource,
        });
        expect.soft(sessionEntry.authProfileOverride).toBe(expectedPin);
        expect.soft(loadSessionEntry({ ...scope, readConsistency: "latest" })).toMatchObject({
          authProfileOverride: expectedPin,
          authProfileOverrideSource: expectedSource,
        });
        if (source === "user" && pin === "arcee:work") {
          applyModelOverrideWithAuthProfileCompatibility({
            cfg,
            agentDir: state.agentDir(agentId),
            entry: sessionEntry,
            currentProvider: "arcee",
            selection: { provider: "arcee", model: "trinity-large-thinking" },
          });
          expect(sessionEntry).toMatchObject({
            authProfileOverride: "arcee:work",
            authProfileOverrideSource: "user",
          });
        }
      },
    );
  },
);
