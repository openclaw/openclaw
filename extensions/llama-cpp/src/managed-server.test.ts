import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";

const installMocks = vi.hoisted(() => ({
  ensureLlamaServerInstalled: vi.fn(),
  resolveManagedLlamaServerPaths: vi.fn(),
}));

vi.mock("./llama-server-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llama-server-install.js")>()),
  ensureLlamaServerInstalled: installMocks.ensureLlamaServerInstalled,
}));

vi.mock("./llama-server-assets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llama-server-assets.js")>()),
  resolveManagedLlamaServerPaths: installMocks.resolveManagedLlamaServerPaths,
}));

import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { selectLlamaServerAsset } from "./llama-server-assets.js";
import { withHuggingFaceMetadataFixture } from "./managed-server-huggingface.test-support.js";
import { inspectLlamaServerRuntime } from "./managed-server-inspection.js";
import {
  ensureLlamaCppModel,
  ensureManagedLlamaServerForChat,
  prepareManagedLlamaServer,
  reconcileManagedLlamaServer,
} from "./managed-server.js";

const servers: http.Server[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
async function listen(server: http.Server, port = 0, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen({ port, host: host === "localhost" ? undefined : host }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing test server address");
  }
  return address.port;
}

async function createReloadServer(host = "127.0.0.1") {
  const state = { reloads: 0, status: 200 };
  const server = http.createServer((req, res) => {
    state.reloads += Number(req.url === "/models?reload=1");
    res.statusCode = state.status;
    res.end("{}");
  });
  servers.push(server);
  const port = await listen(server, 0, host);
  return { state, port, baseUrl: `http://${host}:${port}/v1` };
}

async function createPresetFixture(label: string) {
  const tempRoot = tempDirs.make(`llama-server-${label}-`);
  const presetPath = path.join(tempRoot, "models.ini");
  const asset = selectLlamaServerAsset("darwin", "arm64");
  const command = path.join(tempRoot, "llama-server");
  installMocks.ensureLlamaServerInstalled.mockResolvedValue({ command, asset });
  installMocks.resolveManagedLlamaServerPaths.mockReturnValue({
    installDir: tempRoot,
    command,
    presetPath,
  });
  return { tempRoot, presetPath, asset };
}

const prepareEmbedding = (port: number, reconcileBaseUrl?: string) =>
  prepareManagedLlamaServer({
    chatModel: { mode: "remove" },
    configuredChatModelIds: [],
    embeddingModelPath: "/models/embedding.gguf",
    port,
    reconcileBaseUrl,
  });

function chatModel(id: string, modelPath: string, contextSize: number, maxTokens: number) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    params: { modelPath, contextSize },
    maxTokens,
  };
}

function configureChat(id: string, modelPath: string, contextSize?: number, maxTokens?: number) {
  return { mode: "configure" as const, id, path: modelPath, contextSize, maxTokens };
}

function chatProvider(root: string, models: ReturnType<typeof chatModel>[], port = 19432) {
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    localService: {
      command: path.join(root, "llama-server"),
      args: ["--models-preset", path.join(root, "models.ini")],
    },
    models,
    params: { modelCacheDir: root },
  };
}

function expectContents(contents: string, fragments: string[]) {
  for (const fragment of fragments) {
    expect(contents).toContain(fragment);
  }
}

async function serveInspection(routes: Record<string, () => unknown>) {
  const server = http.createServer((req, res) => {
    const endpoint = Object.keys(routes).find((route) =>
      route.endsWith("?") ? req.url?.startsWith(route) : req.url === route,
    );
    const body = endpoint ? routes[endpoint]?.() : undefined;
    res.statusCode = body === undefined ? 404 : 200;
    res.setHeader(
      "content-type",
      endpoint === "/metrics?" && body !== undefined ? "text/plain" : "application/json",
    );
    res.end(Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body ?? {}));
  });
  servers.push(server);
  return await listen(server);
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(servers.splice(0).map((server) => server[Symbol.asyncDispose]()));
});

it("selects the pinned darwin/x64 asset", () => {
  expect(selectLlamaServerAsset("darwin", "x64")).toMatchObject({
    platform: "darwin",
    arch: "x64",
    backend: "cpu",
    archive: "tar.gz",
    name: "llama-b10809-bin-macos-x64.tar.gz",
    sha256: "13b34aa8a5d87341a21065a83f54a8167e1aaa6fe0d66065de01632a1ed64be6",
  });
});

it("fails unsupported platforms with an actionable manual path", () => {
  expect(() => selectLlamaServerAsset("freebsd", "x64")).toThrow(
    "Install a compatible llama-server manually",
  );
});

it("prepares an isolated candidate without changing the active restart preset", async () => {
  const { presetPath, asset } = await createPresetFixture("candidate");
  const active = "version = 1\n\n[active-chat]\nmodel = /models/active.gguf\n";
  await fs.writeFile(presetPath, active);
  const candidate = await prepareManagedLlamaServer({
    chatModel: configureChat("candidate-chat", "/models/candidate.gguf", 16_384),
    embeddingModelPath: "/models/embedding.gguf",
    asset,
    isolated: true,
    port: 19_435,
  });
  const candidatePreset = candidate.args[candidate.args.indexOf("--models-preset") + 1]!;
  expect(candidatePreset).not.toBe(presetPath);
  expect(await fs.readFile(presetPath, "utf8")).toBe(active);
  const contents = await fs.readFile(candidatePreset, "utf8");
  expectContents(contents, [
    "[candidate-chat]\nmodel = /models/candidate.gguf\nctx-size = 16384",
    "[embeddinggemma-300m-qat-q8_0]\nmodel = /models/embedding.gguf",
  ]);
  expect(contents).not.toContain("active-chat");
});

it("does not reconcile a configured direct-model service without a router preset", async () => {
  const root = tempDirs.make("llama-server-direct-model-");
  const { state, port, baseUrl } = await createReloadServer();
  await prepareManagedLlamaServer({
    localService: {
      command: path.join(root, "custom-server"),
      args: ["--model", "/models/chat.gguf", "--alias", "chat"],
    },
    port,
    chatModel: configureChat("chat", "/models/chat.gguf"),
    embeddingModelPath: "/models/embedding.gguf",
  });
  await reconcileManagedLlamaServer({ baseUrl });
  expect(state.reloads).toBe(0);
});

it("preserves configured preset settings for env/configure", async () => {
  const newline = "\r\n";
  const root = tempDirs.make("llama-server-owned-settings-");
  const presetPath = path.join(root, "custom.ini");
  const global = `version = 1${newline}; operator defaults${newline}[*]${newline}ctx-size = 16384${newline}${newline}`;
  const sibling = `[sibling] ; another model${newline}model = /models/sibling.gguf${newline}n-gpu-layers = 7${newline}${newline}`;
  const chat = `[chat]${newline}model = /models/chat.gguf${newline}c = 4096 ; selected context${newline}n-gpu-layers = 12${newline}${newline}`;
  await fs.writeFile(
    presetPath,
    global +
      "[stale\nmultiline]\nmodel = /models/stale.gguf\n\n".replaceAll("\n", newline) +
      sibling +
      chat +
      `[embeddinggemma-300m-qat-q8_0]${newline}; keep\u2028model = /models/comment.gguf${newline}model = /models/old.gguf ; embedding path${newline}pooling = mean${newline}ubatch-size = 256${newline}`,
  );
  await prepareManagedLlamaServer({
    localService: {
      command: path.join(root, "custom-server"),
      cwd: root,
      env: { LLAMA_ARG_MODELS_PRESET: "custom.ini" },
    },
    port: 19436,
    configuredChatModelIds: ["chat", "sibling"],
    chatModel: configureChat("chat", "/models/chat.gguf", 8192),
    embeddingModelPath: "/models/new.gguf",
  });
  const updated = await fs.readFile(presetPath, "utf8");
  expect(updated.startsWith(global)).toBe(true);
  expect(updated).toContain(sibling.trimEnd());
  expect(updated).not.toContain("[stale");
  expect(updated.indexOf("[chat]")).toBeLessThan(updated.indexOf("[sibling]"));
  expect(updated).toContain(`n-gpu-layers = 12${newline}`);
  expect(updated).toContain(`model = /models/new.gguf ; embedding path${newline}`);
  expect(updated).toContain(`pooling = mean${newline}`);
  expect(updated).toContain(`; keep\u2028model = /models/comment.gguf${newline}`);
  expect(updated).toContain(`ubatch-size = 256${newline}`);
  expect(updated).toContain(`ctx-size = 8192 ; selected context${newline}`);
  expect(updated).not.toContain("c = 4096");
  expect(installMocks.ensureLlamaServerInstalled).not.toHaveBeenCalled();
});

it("updates the native model's effective release-Q4_K_M preset alias", async () => {
  const root = tempDirs.make("llama-server-preset-alias-");
  const presetPath = path.join(root, "custom.ini");
  const active = "[chat:release-Q4_K_M]\nmodel = /models/chat.gguf\nc = 4096\nn-gpu-layers = 12\n";
  const inactive = "[chat:Q4_K_M]\nmodel = /models/inactive.gguf\n";
  await fs.writeFile(presetPath, `version = 1\n${active}${inactive}`);
  await prepareManagedLlamaServer({
    localService: {
      command: path.join(root, "custom-server"),
      args: ["--models-preset", presetPath],
    },
    port: 19436,
    configuredChatModelIds: ["chat:Q4_K_M"],
    chatModel: configureChat("chat:Q4_K_M", "/models/chat.gguf", 8192),
    embeddingModelPath: "/models/embedding.gguf",
  });
  const updated = await fs.readFile(presetPath, "utf8");
  expect(updated).toContain(active.replace("c = 4096", "ctx-size = 8192"));
  expect(updated).toContain(inactive);
});

it("preserves both model stanzas and the configured CUDA runtime during concurrent preparation", async () => {
  const tempRoot = tempDirs.make("llama-server-chat-preset-");
  const presetPath = path.join(tempRoot, "models.ini");
  const chatModelPath = path.join(tempRoot, "chat.gguf");
  const embeddingModelPath = path.join(tempRoot, "custom-embedding.gguf");
  const localService = {
    command: path.join(tempRoot, "win32-x64-cuda-12.4", "llama-server.exe"),
    args: ["--models-preset", presetPath],
  };

  await Promise.all([chatModelPath, embeddingModelPath].map((file) => fs.writeFile(file, "GGUF")));
  const [embeddingRuntime] = await Promise.all([
    prepareManagedLlamaServer({
      chatModel: { mode: "preserve" },
      embeddingModelPath,
      port: 19_434,
      localService,
    }),
    ensureManagedLlamaServerForChat({
      provider: { ...chatProvider(tempRoot, [], 19434), localService },
      model: chatModel("chat-model", chatModelPath, 8192, 2048),
    }),
  ]);

  expect(embeddingRuntime.command).toBe(localService.command);
  expect(embeddingRuntime.args).toContain(presetPath);
  expect(installMocks.ensureLlamaServerInstalled).not.toHaveBeenCalled();
  expect(installMocks.resolveManagedLlamaServerPaths).not.toHaveBeenCalled();
  const preset = await fs.readFile(presetPath, "utf8");
  expectContents(preset, [
    `[chat-model]\nmodel = ${chatModelPath}\nctx-size = 8192`,
    `[embeddinggemma-300m-qat-q8_0]\nmodel = ${embeddingModelPath}\nembedding = true`,
    "parallel = 1\nctx-size = 2048\nubatch-size = 2048\n",
  ]);
});

it("retains the chat inventory across A to B to A and reapplies changed limits", async () => {
  const { tempRoot, presetPath } = await createPresetFixture("chat-transitions");
  const firstPath = path.join(tempRoot, "first.gguf");
  const secondPath = path.join(tempRoot, "second.gguf");
  const first = chatModel("first", firstPath, 16_384, 1024);
  const second = chatModel("second", secondPath, 32_768, 2048);
  const provider = chatProvider(tempRoot, [first, second], 29432);
  await Promise.all([fs.writeFile(firstPath, "GGUF"), fs.writeFile(secondPath, "GGUF")]);
  for (const model of [
    first,
    second,
    { ...first, params: { ...first.params, contextSize: 32_768 }, maxTokens: 4096 },
  ]) {
    await ensureManagedLlamaServerForChat({ provider, model });
  }
  const preset = await fs.readFile(presetPath, "utf8");
  expectContents(preset, [
    `[first]\nmodel = ${firstPath}\nctx-size = 32768\nn-predict = 4096\njinja = true`,
    `[second]\nmodel = ${secondPath}\nctx-size = 32768\nn-predict = 2048\njinja = true`,
  ]);
  expect(preset.indexOf("[first]")).toBeLessThan(preset.indexOf("[second]"));
});

it.each(["127.0.0.1", "localhost"])("tracks revisions for %s origins", async (host) => {
  await createPresetFixture("origin-transition");
  const first = await createReloadServer(host);
  const second = await createReloadServer(host);
  await prepareEmbedding(first.port, host === "localhost" ? first.baseUrl : undefined);
  await prepareEmbedding(second.port, host === "localhost" ? second.baseUrl : undefined);
  await reconcileManagedLlamaServer(first);
  await reconcileManagedLlamaServer(second);
  await reconcileManagedLlamaServer(first);
  expect([first.state.reloads, second.state.reloads]).toEqual([1, 1]);
});

it("retains a failed reload revision for the next reconciliation", async () => {
  await createPresetFixture("reload-failure");
  const { state, port, baseUrl } = await createReloadServer();
  state.status = 500;
  await prepareEmbedding(port);
  await expect(reconcileManagedLlamaServer({ baseUrl })).rejects.toThrow(
    "llama.cpp preset reload failed: HTTP 500",
  );
  const controller = new AbortController();
  controller.abort(new Error("reload aborted"));
  await expect(reconcileManagedLlamaServer({ baseUrl, signal: controller.signal })).rejects.toBe(
    controller.signal.reason,
  );
  state.status = 200;
  await reconcileManagedLlamaServer({ baseUrl });
  expect(state.reloads).toBe(2);
});

it("allows reloads to use llama.cpp's pinned model shutdown window", async ({ signal }) => {
  await createPresetFixture("reload-shutdown-window");
  let reloads = 0;
  const requested = createDeferred<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    if (req.url === "/models?reload=1") {
      reloads += 1;
      requested.resolve(res);
      return;
    }
    res.end("{}");
  });
  servers.push(server);
  const port = await listen(server);
  await prepareEmbedding(port);

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const controller = new AbortController();
  const reload = reconcileManagedLlamaServer({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    signal: AbortSignal.any([signal, controller.signal]),
  });
  try {
    const response = await Promise.race([
      requested.promise,
      reload.then(() => {
        throw new Error("Reload completed without requesting the preset");
      }),
    ]);
    // Advance the real guard's deadline only after DNS and HTTP admission.
    await vi.advanceTimersByTimeAsync(2_600);
    response.end("{}");
    await reload;
    expect(reloads).toBe(1);
  } finally {
    controller.abort();
    vi.useRealTimers();
    await reload.catch(() => {});
  }
});

it("reconciles a mutation after the child reads the preset but before it listens", async () => {
  const { presetPath } = await createPresetFixture("startup-race");
  const probe = http.createServer();
  const port = await listen(probe);
  await probe[Symbol.asyncDispose]();
  const prepare = async (contextSize: number) =>
    await prepareManagedLlamaServer({
      chatModel: configureChat("chat", "/models/chat.gguf", contextSize, 2048),
      configuredChatModelIds: ["chat"],
      defaultEmbeddingModelPath: "/models/embedding.gguf",
      port,
    });
  await prepare(8192);
  let loadedPreset = await fs.readFile(presetPath, "utf8");
  await prepare(16_384);

  let reloads = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/models?reload=1") {
      reloads += 1;
      void fs.readFile(presetPath, "utf8").then((contents) => {
        loadedPreset = contents;
        res.end("{}");
      });
      return;
    }
    res.end("{}");
  });
  servers.push(server);
  await listen(server, port);
  await reconcileManagedLlamaServer({ baseUrl: `http://127.0.0.1:${port}/v1` });
  await reconcileManagedLlamaServer({ baseUrl: `http://127.0.0.1:${port}/v1` });

  expect(reloads).toBe(1);
  expect(loadedPreset).toContain("ctx-size = 16384");
});

it("reports a missing local GGUF with the setup repair path", async () => {
  await expect(
    ensureLlamaCppModel({
      source: path.join(os.tmpdir(), "missing-openclaw-model.gguf"),
      cacheDir: os.tmpdir(),
      download: false,
    }),
  ).rejects.toThrow("Run interactive llama.cpp setup or correct params.modelPath");
});

it("bounds Hugging Face manifest metadata while preserving a legitimate response", async () => {
  await withHuggingFaceMetadataFixture(
    { cacheDir: tempDirs.make("llama-cpp-hf-manifest-"), servers },
    "manifest",
    async ({ cacheDir, setPadding }) => {
      const resolve = (source: string) =>
        ensureLlamaCppModel({ source, cacheDir, download: false });
      await expect(resolve("hf:owner/repo")).resolves.toBe(
        path.join(cacheDir, "hf_owner_repo_model.gguf"),
      );
      setPadding("manifest", "x".repeat(16 * 1024 * 1024 + 1));
      await expect(resolve("hf:owner/repo#oversized-manifest")).rejects.toThrow(
        "llama.cpp Hugging Face manifest: JSON response exceeds 16777216 bytes",
      );
    },
  );
});

it("keeps a verified custom Hugging Face artifact available while refreshing its preset", async () => {
  await withHuggingFaceMetadataFixture(
    { cacheDir: tempDirs.make("llama-cpp-hf-file-"), servers },
    "file",
    async ({ cacheDir, setMetadataAvailable, source }) => {
      const presetPath = path.join(cacheDir, "models.ini");
      const model = chatModel("custom-chat", source, 8192, 1024);
      const provider = chatProvider(cacheDir, [model]);

      await ensureManagedLlamaServerForChat({ provider, model });
      setMetadataAvailable(false);
      model.maxTokens = 2048;
      await ensureManagedLlamaServerForChat({ provider, model });

      expect(await fs.readFile(presetPath, "utf8")).toContain("n-predict = 2048");
    },
    "hf:owner/repo/model.gguf",
  );
});

it("reports optional metrics separately from runtime readiness and load errors", async () => {
  let metricsAvailable = true;
  const port = await serveInspection({
    "/health": () => ({ status: "ok" }),
    "/models": () => ({
      data: [
        {
          id: "embedding-model",
          path: "/models/from-models.gguf",
          status: { value: "loaded" },
        },
      ],
    }),
    "/props?": () => ({
      build_info: "b10357 (689e227db)",
      model_path: "/models/from-props.gguf",
      modalities: { vision: false },
    }),
    "/metrics?": () => (metricsAvailable ? "llamacpp:prompt_tokens_total 1\n" : undefined),
  });
  const inspect = (loadError?: string) =>
    inspectLlamaServerRuntime({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "embedding-model",
      loadError,
    });

  await expect(inspect()).resolves.toEqual({
    engine: "llama.cpp",
    state: "ready",
    backend: undefined,
    buildInfo: "b10357 (689e227db)",
    model: { id: "embedding-model", path: "/models/from-props.gguf" },
    capabilities: { vision: false, draft: false },
    endpoints: { health: "ready", models: "ready", props: "ready", metrics: "ready" },
  });

  metricsAvailable = false;
  await expect(inspect()).resolves.toMatchObject({
    state: "ready",
    endpoints: { health: "ready", models: "ready", props: "ready", metrics: "unavailable" },
  });
  await expect(inspect("Model load failed")).resolves.toMatchObject({
    state: "failed",
    loadError: "Model load failed",
    endpoints: { metrics: "unavailable" },
  });
});

it.each(["metrics", "props"] as const)(
  "bounds %s inspection responses while accepting a legitimate large body",
  async (endpoint) => {
    const responseBytes = (size: number) => {
      const padding = "x".repeat(size);
      return Buffer.from(endpoint === "metrics" ? padding : JSON.stringify({ padding }));
    };
    // Fixture serialization must not consume the concurrent inspection deadlines.
    let body = responseBytes(1024 * 1024);
    const port = await serveInspection({
      "/health": () => ({ status: "ok" }),
      "/models": () => ({ data: [{ id: "embedding-model" }] }),
      "/props?": () => ({ modalities: { vision: false } }),
      "/metrics?": () => "llamacpp:requests_total 1\n",
      [`/${endpoint}?`]: () => body,
    });
    const inspect = () =>
      inspectLlamaServerRuntime({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: "embedding-model",
      });

    await expect(inspect()).resolves.toMatchObject({
      state: "ready",
      endpoints: { health: "ready", models: "ready", props: "ready", metrics: "ready" },
    });

    body = responseBytes(32 * 1024 * 1024);
    await expect(inspect()).resolves.toMatchObject({
      state: endpoint === "metrics" ? "ready" : "failed",
      endpoints: {
        health: "ready",
        models: "ready",
        props: endpoint === "props" ? "unavailable" : "ready",
        metrics: endpoint === "metrics" ? "unavailable" : "ready",
      },
    });
  },
);
