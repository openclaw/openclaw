import assert from "node:assert/strict";
import fs from "node:fs";
import { Command } from "commander";
import type { DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { MODELS } from "./catalog.js";
import { OnnxWorkerError } from "./protocol.js";

const worker = vi.hoisted(() => ({
  construct: vi.fn(),
  classify: vi.fn(),
  warm: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("./worker-client.js", () => ({
  InferenceWorkerClient: class {
    constructor(options: unknown) {
      worker.construct(options);
    }
    classify = worker.classify;
    warm = worker.warm;
    stop = worker.stop;
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  worker.warm.mockResolvedValue(undefined);
  worker.stop.mockResolvedValue(undefined);
  worker.classify.mockImplementation(async (_model, inputs) =>
    inputs.map((input: { labels: string[] }) => ({
      logits: input.labels.map((_, i) => (i === 0 ? Math.log(3) : 0)),
      inputTokens: 4,
    })),
  );
});
afterEach(() => vi.restoreAllMocks());
const id = "gliclass-edge-v3.0";
function registration() {
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
  const onDispose = vi.fn<NonNullable<OpenClawPluginApi["lifecycle"]["onDispose"]>>();
  const lifecycle = new AbortController();
  const api = createTestPluginApi({
    id: "onnx",
    runtimeSource: new URL("../index.ts", import.meta.url).pathname,
    pluginConfig: { modelDir: "/synthetic/models", threads: 1, maxLoadedModels: 1 },
    registerDecisionProvider,
    registerService,
    registerCli,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    lifecycle: { signal: lifecycle.signal, onDispose, registerRuntimeLifecycle: vi.fn() },
  });
  plugin.register(api);
  const provider = registerDecisionProvider.mock.calls[0]?.[0];
  const service = registerService.mock.calls[0]?.[0];
  const cli = registerCli.mock.calls[0]?.[0];
  assert(provider?.contractVersion === 2 && service && cli);
  const serviceContext: OpenClawPluginServiceContext = {
    config: { agents: { defaults: { decisionModel: "onnx/" + id } } },
    stateDir: "/synthetic/state",
    logger: api.logger,
  };
  const context: DecisionProviderContextV2 = {
    model: { id, name: "GLiClass", provider: "onnx" },
    config: serviceContext.config,
    auth: { mode: "api-key", apiKey: "onnx-local" },
    reasoning: "auto",
    signal: lifecycle.signal,
    deadlineMonotonicMs: performance.now() + 1000,
  };
  return { api, provider, service, cli, serviceContext, context, onDispose, lifecycle };
}

it("registers lazy local execution, warms selected models, and dispatches prepared decisions", async () => {
  const { provider, service, serviceContext, context, onDispose } = registration();
  expect(provider.provider?.authScope).toBe("plugin");
  expect(provider.provider?.resolveSyntheticAuth?.({ provider: "onnx" })).toMatchObject({
    mode: "api-key",
  });
  expect(worker.warm).not.toHaveBeenCalled();
  expect(worker.classify).not.toHaveBeenCalled();
  expect(worker.construct.mock.calls[0]?.[0]).toMatchObject({
    workerUrl: new URL("./inference.worker.ts", import.meta.url),
    config: { modelDir: "/synthetic/models", threads: 1, maxLoadedModels: 1 },
  });
  await service.start(serviceContext);
  expect(worker.warm).toHaveBeenCalledExactlyOnceWith([id], expect.any(AbortSignal));
  await expect(
    provider.evaluate(
      {
        state: { type: "json", value: { evidence: "synthetic" } },
        questions: { q: { type: "choice", criteria: { keep: "Keep", skip: "Skip" } } },
      },
      context,
    ),
  ).resolves.toMatchObject({
    status: "ok",
    result: {
      model: id,
      answers: {
        q: {
          choice: "keep",
          probabilities: { keep: expect.closeTo(0.75, 14), skip: expect.closeTo(0.25, 14) },
        },
      },
    },
  });
  expect(worker.classify).toHaveBeenCalledWith(
    id,
    [
      expect.objectContaining({
        text: '{"evidence":"synthetic"}',
        labels: ["keep", "skip"],
      }),
    ],
    context.signal,
  );
  assert(onDispose.mock.calls[0]);
  await onDispose.mock.calls[0][0]();
  expect(worker.stop).toHaveBeenCalledOnce();
});

it("does not treat local auth eligibility as artifact readiness and keeps warm failures actionable", async () => {
  const { provider, service, serviceContext, context, api } = registration();
  worker.warm.mockRejectedValue(new OnnxWorkerError("model-missing"));
  worker.classify.mockRejectedValue(new OnnxWorkerError("model-missing"));
  await service.start(serviceContext);
  await expect(
    provider.evaluate(
      {
        state: { type: "text", text: "synthetic" },
        questions: {
          q: { type: "choice", criteria: { keep: null, skip: null } },
        },
      },
      context,
    ),
  ).resolves.toEqual({ status: "unavailable", reason: "transport" });
  expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw onnx models"));
  expect(api.logger.warn).toHaveBeenCalledWith(
    expect.stringContaining("openclaw onnx verify " + id),
  );
});

it("joins service disposal rather than reporting a pending worker stop as settled", async () => {
  const { service, serviceContext } = registration();
  let release!: () => void;
  worker.stop.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  let settled = false;
  const pending = Promise.resolve(service.stop?.(serviceContext)).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await pending;
  expect(settled).toBe(true);
});

it("runs registered CLI models and probe through the shared classification adapter", async () => {
  const { cli, api } = registration();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const program = new Command();
  await cli({ program, config: {}, logger: api.logger, parentPath: [] });
  await program.parseAsync(["onnx", "models"], { from: "user" });
  const listed = JSON.parse(String(output.mock.lastCall?.[0]));
  expect(listed.map((entry: { id: string }) => entry.id)).toEqual(MODELS.map((model) => model.id));
  expect(worker.warm).not.toHaveBeenCalled();
  await program.parseAsync(["onnx", "probe", id, "--model-dir", "/synthetic/probe"], {
    from: "user",
  });
  expect(worker.construct.mock.lastCall?.[0]).toMatchObject({
    config: { modelDir: "/synthetic/probe" },
  });
  expect(worker.classify.mock.lastCall?.[1]).toHaveLength(3);
  const result = JSON.parse(String(output.mock.lastCall?.[0]));
  expect(result.outcome.status).toBe("ok");
  expect(result.outcome.result.answers.holiday).toEqual({
    type: "boolean",
    probabilityTrue: expect.closeTo(0.75, 14),
  });
  expect(worker.stop).toHaveBeenCalledOnce();
  worker.warm.mockRejectedValueOnce(new OnnxWorkerError("model-missing"));
  await expect(program.parseAsync(["onnx", "probe", id], { from: "user" })).rejects.toThrow(
    "model-missing",
  );
  expect(worker.stop).toHaveBeenCalledTimes(2);
});

it("keeps manifest configuration aligned with the actual entrypoint", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  expect(manifest.configSchema).toEqual(structuredClone(plugin.configSchema?.jsonSchema));
  expect(manifest.nonSecretAuthMarkers).toEqual(["onnx-local"]);
});
