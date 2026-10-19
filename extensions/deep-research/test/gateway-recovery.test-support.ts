import { vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import * as operatorAuthority from "../../../src/gateway/operator-run-authority.js";
import type { GatewayRequestContext } from "../../../src/gateway/server-methods/types.js";
import { prepareInProcessAgentExecution } from "../../../src/gateway/server-plugin-in-process-dispatch.js";
import {
  createGatewayNodesRuntime,
  createGatewaySubagentRuntime,
} from "../../../src/gateway/server-plugins.js";
import { sessionChanges } from "../../../src/sessions/session-row-changes.js";
import type { OpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";

/** Probe real sibling entry points under the fixture's accepted recovery borrow. */
export function probeUnadmittedRuntimeSiblings(context: GatewayRequestContext, sessionKey: string) {
  const nodes = createGatewayNodesRuntime(() => context);
  return Promise.allSettled([
    nodes.list(),
    nodes.invoke({ nodeId: "unadmitted-node", command: "system.notify", sessionKey }),
    createGatewaySubagentRuntime(() => context).getSessionMessages({ sessionKey }),
    prepareInProcessAgentExecution({
      agentId: "main",
      pluginRuntimeOwnerId: "deep-research",
      resolveGatewayContext: () => context,
    }).then((prepared) => {
      // The unfixed path creates a real lease. Release it even when the negative
      // assertion will fail; a test must not manufacture a teardown deadlock.
      prepared.release();
      return "unadmitted agent preparation succeeded";
    }),
  ]);
}

/** Invalidate real projection facts after source capture, before any router/handler entry. */
export function interruptPendingResearchCapture(
  sessionKey: string,
  pending: () => Promise<boolean>,
) {
  let interrupted = false;
  const capture = operatorAuthority.captureGatewayOperatorRunAuthority;
  const spy = vi
    .spyOn(operatorAuthority, "captureGatewayOperatorRunAuthority")
    .mockImplementation(async (params) => {
      const captured = await capture(params);
      try {
        if (!interrupted && (await pending())) {
          interrupted = true;
          sessionChanges.emitBatch([{ sessionKey, factsInvalidated: "category" }]);
        }
        return captured;
      } catch (error) {
        captured?.release();
        throw error;
      }
    });
  return {
    get interrupted() {
      return interrupted;
    },
    mockRestore: () => spy.mockRestore(),
  };
}

/** Shared real service fixture configuration; the second agent has independent model/auth owners. */
export async function prepareResearchRecoveryConfig(
  state: OpenClawTestState,
  options: {
    storePath: string;
    agentId: string;
    portable: boolean;
    web: boolean;
    expired: boolean;
    documentsOnly: boolean;
  },
): Promise<OpenClawConfig> {
  const { agentId, portable, web, expired } = options;
  const multiAgent = agentId !== "main";
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        ...(portable
          ? {
              model: multiAgent
                ? "google/gemini-2.5-flash@google:recovery"
                : "google/gemini-2.5-flash",
            }
          : {}),
        ...(multiAgent ? { systemAgent: { agentId: "main" } } : {}),
      },
      entries: {
        main: {},
        ...(multiAgent ? { [agentId]: { model: "google/gemini-2.5-pro@google:recovery" } } : {}),
      },
    },
    ...(portable
      ? {
          models: {
            providers: {
              google: {
                api: "google-generative-ai" as const,
                ...(!multiAgent ? { apiKey: "synthetic-recovery-key" } : {}),
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                models: ["gemini-2.5-flash", ...(multiAgent ? ["gemini-2.5-pro"] : [])].map(
                  (id) => ({
                    id,
                    name: "Recovery fixture model",
                    reasoning: false,
                    input: ["text" as const],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 4096,
                  }),
                ),
              },
            },
          },
          tools: {
            ...(options.documentsOnly ? { deny: ["web_search", "web_fetch"] } : {}),
            web: {
              search: { enabled: web, provider: "gemini", cacheTtlMinutes: 0 },
              fetch: { enabled: web || expired, cacheTtlMinutes: 0 },
            },
          },
        }
      : {}),
    session: { store: options.storePath },
    plugins: {
      allow: ["deep-research", "google"],
      entries: {
        "deep-research": { enabled: true },
        google: {
          enabled: true,
          config: {
            research: { enabled: true, profileId: "google:recovery" },
            ...(portable ? { webSearch: { apiKey: "synthetic-recovery-key" } } : {}),
          },
        },
      },
    },
  };
  await state.writeConfig(cfg);
  const profile = (key: string) => ({
    version: 1,
    profiles: {
      "google:recovery": { type: "api_key", provider: "google", key },
    },
  });
  await state.writeAuthProfiles(
    profile(multiAgent ? "synthetic-wrong-agent-key" : "synthetic-recovery-key"),
  );
  if (multiAgent) {
    await state.writeAuthProfiles(profile("synthetic-recovery-key"), agentId);
  }
  return cfg;
}
