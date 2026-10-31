import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { expect, onTestFinished, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionEvaluateOptionsV2 } from "../decisions/execution-types.js";
import type { DecisionRuntimeV2 } from "../decisions/runtime-types.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { resolveAgentDir, resolveDefaultAgentId } from "./agent-scope.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

export async function resetDecisionTestRuntime(
  traceKey?: symbol,
  beforeClear?: () => void | Promise<void>,
) {
  await resetPreparedModelRuntimeSnapshotsForTest();
  await beforeClear?.();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  resetDiagnosticEventsForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (traceKey) {
    Reflect.deleteProperty(globalThis, traceKey);
  }
}

export function createDecisionConsumer(root: string, id: string, traceKey: symbol) {
  const consumerRoot = path.join(root, "consumer");
  for (const directory of [consumerRoot, path.join(root, "bundled")]) {
    fs.mkdirSync(directory);
  }
  const consumer = createColdPluginFixture({ rootDir: consumerRoot, pluginId: id });
  const trace: { runtime?: DecisionRuntimeV2 } = {};
  Reflect.set(globalThis, traceKey, trace);
  fs.writeFileSync(
    consumer.runtimeSource,
    `const trace=globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(traceKey))})]; module.exports={id:${JSON.stringify(id)},register(api){trace.runtime=api.runtime.decisions;}};`,
  );
  return { consumerRoot, trace };
}

export function decisionConfig(
  root: string,
  decisionModel: string,
  plugins: NonNullable<OpenClawConfig["plugins"]>,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "unrelated/not-configured",
        decisionModel,
        workspace: path.join(root, "workspace"),
      },
    },
    plugins: { slots: { memory: "none" }, ...plugins },
  };
}

export function decisionEnv(
  root: string,
  overrides: NodeJS.ProcessEnv = {},
  bundled = path.join(root, "bundled"),
) {
  return {
    ...createColdPluginHermeticEnv(root, { bundledPluginsDir: bundled }),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    ...overrides,
  };
}

export async function activateDecisionRegistry(
  config: OpenClawConfig,
  options: Omit<
    NonNullable<Parameters<typeof loadAndActivateRootPluginRegistry>[0]>,
    "config"
  > = {},
  sourceConfig?: OpenClawConfig,
) {
  setRuntimeConfigSnapshot(config, sourceConfig);
  const registry = await loadAndActivateRootPluginRegistry({
    config,
    workspaceDir: config.agents?.defaults?.workspace,
    ...options,
  });
  expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
  return registry;
}

export function prepareDecisionRuntime(config: OpenClawConfig, provider: string, modelId: string) {
  const agentId = resolveDefaultAgentId(config);
  return acquireAgentRunPreparedModelRuntime(
    {
      config,
      agentId,
      agentDir: resolveAgentDir(config, agentId),
      workspaceDir: config.agents?.defaults?.workspace,
      loadRuntimePlugins: true,
      runtimePluginSelections: [{ provider, modelId, agentId }],
    },
    { catalogMode: "static" },
  );
}

export const unavailable = (reason: string) => ({ status: "unavailable", reason });

export function decisionOptions(
  overrides: Partial<DecisionEvaluateOptionsV2> = {},
): DecisionEvaluateOptionsV2 {
  return {
    purpose: "fixture",
    rubricVersion: "v2",
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

export function trackDecisionUsage() {
  const events: Array<Extract<DiagnosticEventPayload, { type: "model.usage" }>> = [];
  onTestFinished(
    onTrustedInternalDiagnosticEvent(
      markTrustedOtelDiagnosticListener((event) => {
        if (event.type === "model.usage") {
          events.push(event);
        }
      }),
    ),
  );
  return events;
}

function readDecisionRequest(request: IncomingMessage, receive: (body: unknown) => void) {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => receive(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
}

type DecisionRequest = { url: string; headers: Headers; body: unknown };

export function withDecisionServer(
  reply: (transport: "http" | "fetch") => { status: number; body: unknown },
  run: (server: {
    origin: string;
    requests: DecisionRequest[];
    mockFetch: (target: string) => void;
  }) => Promise<void>,
  models?: unknown,
) {
  const requests: DecisionRequest[] = [];
  return withServer(
    (request, response) => {
      const send = ({ status, body }: ReturnType<typeof reply>) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      if (models && request.url?.endsWith("/models")) {
        send({ status: 200, body: models });
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") {
          headers.set(name, value);
        }
      }
      // Count physical dispatch before body completion, including aborted requests.
      const captured: DecisionRequest = {
        url: `http://${request.headers.host}${request.url}`,
        headers,
        body: undefined,
      };
      requests.push(captured);
      readDecisionRequest(request, (body) => {
        captured.body = body;
        send(reply("http"));
      });
    },
    (origin) =>
      run({
        origin,
        requests,
        mockFetch(target) {
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async (input, init) => {
              const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
              if (models && url.endsWith("/models")) {
                return Response.json({ data: [] });
              }
              expect(url).toBe(target);
              if (typeof init?.body !== "string") {
                throw new Error("Expected a serialized Decision request");
              }
              requests.push({
                url,
                headers: new Headers(init.headers),
                body: JSON.parse(init.body),
              });
              const { status, body } = reply("fetch");
              return Response.json(body, { status });
            }),
          );
        },
      }),
  );
}
