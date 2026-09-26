import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createRequestGatewayMethodRegistry } from "../gateway/server-methods.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "../gateway/server-methods/sessions-read-cache.test-support.js";
import { withOperatorToolGatewayAuthority } from "../gateway/server-plugin-in-process-dispatch.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import { sharingPolicyClient } from "../gateway/session-sharing.test-utils.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as preparedCatalog from "./prepared-model-catalog.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";

vi.mock("../status/status-text.js", () => ({ buildStatusText: async () => "Session status" }));

it("routes status model changes through the original operator policy and preserves unrestricted callers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const limited = ensureProfileForEmail("limited-model@example.test");
    const unrestricted = ensureProfileForEmail("unrestricted-model@example.test");
    setUserProfileRole(unrestricted.id, "unrestricted");
    const catalog = ["blocked", "allowed"].map((id) => ({
      provider: "fixture",
      id,
      name: id,
      reasoning: false,
    }));
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { default: true } },
        defaults: {
          model: { primary: "fixture/blocked", fallbacks: ["fixture/allowed"] },
          models: {
            "fixture/blocked": { alias: "blocked" },
            "fixture/allowed": { alias: "chosen" },
          },
          modelPolicy: { allow: ["fixture/*"] },
          modelSelectionScope: "global",
          sandbox: { mode: "off", sessionToolsVisibility: "all" },
        },
      },
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            agentRuntime: { id: "openclaw" },
            models: catalog.map<ModelDefinitionConfig>((entry) => ({
              ...entry,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 1024,
            })),
          },
        },
      },
      gateway: {
        roles: {
          default: "limited",
          definitions: {
            limited: {
              sessions: { others: "write" },
              agents: ["main"],
              scopes: ["operator.admin"],
              modelPolicy: { sourceAgent: "main", deny: ["fixture/blocked"] },
            },
            unrestricted: {
              sessions: { others: "write" },
              agents: "*",
              scopes: ["operator.admin"],
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    using catalogRead = vi.spyOn(preparedCatalog, "loadPublishedPreparedModelCatalog");
    catalogRead.mockResolvedValue(catalog);
    const key = "agent:main:status-model-policy";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "model-policy-session",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: limited.id },
        providerOverride: "fixture",
        modelOverride: "blocked",
        agentRuntimeOverride: "openclaw",
      },
    );
    const context = createGatewayRequestContext(
      makeContextParams({
        getAttachedGatewayMethodRegistry: createRequestGatewayMethodRegistry,
        loadGatewayModelCatalogSnapshot: async () => ({
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          config: cfg,
          catalogComplete: true,
          entries: catalog,
          routeVariants: catalog,
        }),
      }),
    );
    const resolveGatewayContext = () => context;
    context.resolveGatewayContext = resolveGatewayContext;
    const scope = { context, resolveGatewayContext, isWebchatConnect: () => false };
    await initializeSessionReadContext(context);
    try {
      await withPluginRuntimeGatewayRequestScope(scope, async () => {
        const tool = createSessionStatusTool({
          config: cfg,
          agentSessionKey: key,
          requesterAgentIdOverride: "main",
        });
        const runAs = <T>(profileId: string, run: () => Promise<T>) => {
          const client = sharingPolicyClient({ user: profileId, scopes: ["operator.admin"] });
          return withPluginRuntimeGatewayRequestScope({ ...scope, client }, () =>
            withOperatorToolGatewayAuthority(
              {
                authenticatedUserProfile: expectDefined(
                  client.authenticatedUserProfile,
                  "operator profile",
                ),
                scopes: ["operator.admin"],
              },
              run,
            ),
          );
        };
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: key,
            operationalRunInstance: { instanceId: "policy-instance", runId: "policy-run" },
            receiptAuthority: () => true,
            gatewayContextResolver: resolveGatewayContext,
          },
          async () => {
            await runAs(limited.id, async () => {
              const before = loadSessionEntry({ agentId: "main", sessionKey: key });
              for (const model of ["fixture/blocked", "blocked"]) {
                await expect(tool.execute("denied-selection", { model })).rejects.toThrow(
                  "operator role cannot use this model",
                );
                expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toEqual(before);
              }
              expect(
                (await tool.execute("allowed-selection", { model: "chosen" })).details,
              ).toMatchObject({ changedModel: true });
              const selected = loadSessionEntry({ agentId: "main", sessionKey: key });
              expect(selected).toMatchObject({
                providerOverride: "fixture",
                modelOverride: "allowed",
              });
              expect(
                (await tool.execute("same-selection", { model: "chosen" })).details,
              ).toMatchObject({ changedModel: false });
              expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toEqual(selected);
              expect(
                (await tool.execute("default-selection", { model: "default" })).details,
              ).toMatchObject({ changedModel: true });
              expect(
                loadSessionEntry({ agentId: "main", sessionKey: key })?.modelOverride,
              ).toBeUndefined();
              expect(context.getRuntimeConfig().agents?.defaults?.model).toEqual(
                cfg.agents?.defaults?.model,
              );
            });
            await runAs(unrestricted.id, async () => {
              await tool.execute("unrestricted-selection", { model: "fixture/blocked" });
              expect(
                loadSessionEntry({ agentId: "main", sessionKey: key })?.modelOverride,
              ).toBeUndefined();
            });
          },
        );
        await runAs(limited.id, () =>
          withPluginRuntimeGatewayRequestScope({ isWebchatConnect: () => false }, async () => {
            const before = loadSessionEntry({ agentId: "main", sessionKey: key });
            await expect(tool.execute("missing-gateway", { model: "chosen" })).rejects.toThrow(
              "Operator model selection requires a current Gateway",
            );
            expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toEqual(before);
          }),
        );
      });
    } finally {
      await disposeSessionReadContexts();
    }
  });
});
