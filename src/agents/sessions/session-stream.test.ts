import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { afterEach, expect, it, vi } from "vitest";
import type { Context, Model, SimpleStreamOptions } from "../../llm/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { createSessionStreamFn } from "./session-stream.js";
import { SettingsManager } from "./settings-manager.js";

const model: Model = {
  provider: "session-stream-fixture",
  id: "synthetic-model",
  name: "Synthetic model",
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};
const context: Context = { systemPrompt: "Synthetic prompt", messages: [] };

function createRegistry() {
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "synthetic-registry-key");
  const registry = ModelRegistry.inMemory(authStorage);
  const providerIo = vi.fn((_model: Model, _context: Context, _options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    stream.end();
    return stream;
  });
  registry.registerProvider(model.provider, {
    api: model.api,
    baseUrl: model.baseUrl,
    headers: {
      "X-OpenRouter-Title": "Synthetic registry title",
      "X-Provider": "synthetic-provider-header",
    },
    streamSimple: providerIo,
  });
  return { registry, authStorage, providerIo };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["abort", "closed owner", "credential failure"] as const)(
  "does not dispatch after %s while credentials are pending",
  async (failure) => {
    const { registry, authStorage, providerIo } = createRegistry();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    vi.spyOn(authStorage, "getApiKey").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      if (failure === "credential failure") {
        throw new Error("Synthetic credential unavailable");
      }
      return "synthetic-registry-key";
    });
    let current = true;
    const stream = createSessionStreamFn(registry, SettingsManager.inMemory(), undefined, () => {
      if (!current) {
        throw new Error("Synthetic owner closed");
      }
    });
    const controller = new AbortController();
    const pending = Promise.resolve(stream(model, context, { signal: controller.signal }));
    const reason = new Error("Synthetic stream aborted");
    const rejected = expect(pending).rejects.toThrow(
      failure === "abort"
        ? reason
        : failure === "closed owner"
          ? "Synthetic owner closed"
          : "Synthetic credential unavailable",
    );
    try {
      await entered.promise;
      if (failure === "abort") {
        controller.abort(reason);
      } else if (failure === "closed owner") {
        current = false;
      }
    } finally {
      release.resolve();
    }
    await rejected;
    expect(providerIo).not.toHaveBeenCalled();
  },
);

it("rechecks the admitted owner after lazy transport preparation", async () => {
  const { registry, providerIo } = createRegistry();
  let current = true;
  let authResolved = false;
  const resolveAuth = registry.getApiKeyAndHeaders.bind(registry);
  vi.spyOn(registry, "getApiKeyAndHeaders").mockImplementation(async (...args) => {
    const auth = await resolveAuth(...args);
    authResolved = true;
    return auth;
  });
  const stream = createSessionStreamFn(registry, SettingsManager.inMemory(), false, () => {
    if (!current) {
      throw new Error("Synthetic owner closed during preparation");
    }
    if (authResolved) {
      queueMicrotask(() => {
        current = false;
      });
    }
  });
  await expect(stream(model, context, {})).rejects.toThrow(
    "Synthetic owner closed during preparation",
  );
  expect(providerIo).not.toHaveBeenCalled();
});

it("refuses a retained stream before resolving credentials after its owner closes", async () => {
  const { registry, providerIo } = createRegistry();
  const credentials = vi.spyOn(registry, "getApiKeyAndHeaders");
  const stream = createSessionStreamFn(registry, SettingsManager.inMemory(), false, () => {
    throw new Error("Synthetic owner already closed");
  });
  await expect(stream(model, context, {})).rejects.toThrow("Synthetic owner already closed");
  expect(credentials).not.toHaveBeenCalled();
  expect(providerIo).not.toHaveBeenCalled();
});
