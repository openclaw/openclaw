import { afterEach, expect, it, vi } from "vitest";
import * as sessionEntryRuntime from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WorkerInferenceExecutionParams } from "../gateway/worker-environments/inference-runtime.js";
import { executeWorkerInference } from "../gateway/worker-environments/inference.js";
import { identityFor, REQUEST } from "../gateway/worker-environments/inference.test-support.js";
import * as workerTurnOwner from "../gateway/worker-environments/placement-turn-claim-events.js";
import { prepareWorkerTurnModel } from "../gateway/worker-environments/worker-turn-model.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as sessionAuthRuntime from "./auth-profiles/session-override.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import type { BoundAgentRunSessionTarget } from "./run-session-target.types.js";
import {
  acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from "./simple-completion-runtime.js";
import {
  assertPrepared,
  completionChunk,
  completionConfig,
  completionContext,
  completionModel,
  startCompletionServer,
} from "./simple-completion.test-support.js";

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  vi.restoreAllMocks();
});

it.each([
  { mode: "agent", api: undefined },
  { mode: "worker", api: "openai-completions" },
] as const)(
  "normalizes initial $mode completion once without ambient runtime (API $api)",
  async ({ mode, api }) => {
    await withOpenClawTestState({ label: "selected-completion" }, async (state) => {
      const requests: string[] = [];
      await using server = await startCompletionServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          const { model } = JSON.parse(body) as { model: string };
          requests.push(model);
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(completionChunk(`materialized:${model}`, model));
        });
      });
      const { baseUrl } = server;
      const nativeFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.origin).toBe(new URL(baseUrl).origin);
        return nativeFetch(input, init);
      });
      const provider = "selected-completion";
      const models = ["middle", "final", "plain"].map((id) =>
        completionModel({
          id,
          provider,
          api: "openai-completions",
          baseUrl,
        }),
      );
      await state.writeJson("provider/openclaw.plugin.json", {
        id: provider,
        providers: [provider],
        configSchema: { type: "object", properties: {}, additionalProperties: false },
        modelIdNormalization: {
          providers: { [provider]: { aliases: { entry: "middle", middle: "final" } } },
        },
        modelCatalog: {
          discovery: { [provider]: "static" },
          providers: { [provider]: { api: "openai-completions", baseUrl, models } },
        },
      });
      const runtimePath = await state.writeText(
        "provider/index.cjs",
        `const models = ${JSON.stringify(models)};
module.exports = {
  id: ${JSON.stringify(provider)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "Selected completion", auth: [],
      resolveDynamicModel({ modelId }) { return models.find(model => model.id === modelId); },
    });
  },
};
`,
      );
      const cfg: OpenClawConfig = completionConfig(
        provider,
        {
          api,
          baseUrl,
          apiKey: "synthetic-fixture",
          models: [],
        },
        {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: {
                primary: `${provider}/plain`,
                fallbacks: [`${provider}/entry`, `${provider}/middle`],
              },
            },
          },
          plugins: {
            allow: [provider],
            entries: { [provider]: { enabled: true } },
            load: { paths: [runtimePath] },
            slots: { memory: "none" },
          },
        },
      );
      await state.writeConfig(cfg);
      const sessionTarget: BoundAgentRunSessionTarget = {
        agentId: "main",
        sessionId: "selected-test",
        sessionKey: "agent:main:main",
        storePath: state.path("unused-session-store.sqlite"),
      };
      if (mode === "worker") {
        vi.spyOn(workerTurnOwner, "readWorkerTurnPromptCacheContext").mockReturnValue({
          boundaryCount: 0,
        });
        vi.spyOn(sessionEntryRuntime, "readSessionEntryInWorker").mockImplementation(
          async (target) => {
            expect(target).toEqual(sessionTarget);
            return { sessionId: "selected-test", updatedAt: 0 };
          },
        );
        vi.spyOn(sessionAuthRuntime, "resolveSessionAuthSelection").mockResolvedValue(undefined);
      }

      for (const [raw, expected] of [
        ["entry", "middle"],
        ["middle", "final"],
        ["plain", "plain"],
      ] as const) {
        if (mode === "worker") {
          await using lease = await acquireAgentRunPreparedModelRuntime({
            config: cfg,
            agentId: "main",
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
          });
          const start = {
            ...REQUEST,
            sessionId: sessionTarget.sessionId,
            runId: "selected-test",
            turnId: "selected-test",
            modelRef: { provider, model: raw },
            context: completionContext("Synthetic input.", 0),
            options: { maxTokens: 64 },
          };
          const request: WorkerInferenceExecutionParams = {
            sessionTarget,
            request: start,
            identity: { ...identityFor(start), credentialExpiresAtMs: Number.MAX_SAFE_INTEGER },
            signal: new AbortController().signal,
            isCurrent: () => true,
            emit: () => {},
          };
          const { inference } = await prepareWorkerTurnModel({
            target: sessionTarget,
            modelRef: request.request.modelRef,
            runtimeSnapshot: lease.snapshot,
            inferencePlacement: "gateway",
            turn: { workspaceDir: state.workspaceDir },
            assertCurrent() {},
          });
          vi.spyOn(workerTurnOwner, "getWorkerTurnInference").mockReturnValue(inference);
          const result = await executeWorkerInference(request);
          expect(result).toMatchObject({
            type: "done",
            message: {
              provider,
              model: expected,
              content: [{ type: "text", text: `materialized:${expected}` }],
            },
          });
        } else {
          const acquired = await acquireSimpleCompletionModelForAgent({
            cfg,
            agentId: "main",
            modelRef: `${provider}/${raw}`,
            allowBundledStaticCatalogFallback: true,
          });
          assertPrepared(acquired);
          await using prepared = acquired;
          expect(prepared.model.id).toBe(expected);
          const result = await completeWithPreparedSimpleCompletionModel({
            cfg,
            model: prepared.model,
            auth: prepared.auth,
            context: completionContext("Synthetic input.", 0),
            options: { maxTokens: 64 },
          });
          expect(result).toMatchObject({
            content: [{ type: "text", text: `materialized:${expected}` }],
          });
        }
      }
      expect(requests).toEqual(["middle", "final", "plain"]);
    });
  },
);
