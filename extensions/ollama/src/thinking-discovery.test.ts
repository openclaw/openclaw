import { expectDefined } from "@openclaw/normalization-core";
import { clampThinkingLevel } from "openclaw/plugin-sdk/llm";
import type {
  ProviderRuntimeModel,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResponse, requestUrl } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModel } from "../model.test-support.js";
import { ollamaProviderDiscovery } from "../provider-discovery.js";
import { resolveThinkingProfile } from "../provider-policy-api.js";
import { toDynamicOllamaModel } from "./provider-models.js";
import {
  createConfiguredOllamaCompatStreamWrapper,
  createOllamaStreamFn,
} from "./stream.runtime.js";

const baseUrl = "http://127.0.0.1:11434";
const requireRecord = createRequireRecord("object", "expected-label");
type ThinkingLevel = NonNullable<ProviderWrapStreamFnContext["thinkingLevel"]>;

afterEach(() => vi.unstubAllGlobals());

function mockOllama(modelId: string, thinking: unknown) {
  const metadata: { digest: string; thinking: unknown; parameterCount?: number } = {
    digest: "first",
    thinking,
  };
  const requests: string[] = [];
  const chatBodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(requestUrl(input)).pathname;
      requests.push(pathname);
      if (pathname === "/api/tags") {
        return jsonResponse({ models: [{ name: modelId, digest: metadata.digest }] });
      }
      if (pathname === "/api/show") {
        return jsonResponse({
          model_info: {
            "test.context_length": 32768,
            "general.parameter_count": metadata.parameterCount,
          },
          capabilities: ["completion", "thinking"],
          ...(metadata.thinking === undefined ? {} : { thinking: metadata.thinking }),
        });
      }
      if (pathname !== "/api/chat" || typeof init?.body !== "string") {
        throw new Error(`Unexpected Ollama request: ${pathname}`);
      }
      chatBodies.push(requireRecord(JSON.parse(init.body), "Ollama chat request"));
      return jsonResponse({ message: { role: "assistant", content: "ok" }, done: true });
    }),
  );
  return {
    metadata,
    requests,
    chatBodies,
    async discover(
      api: "ollama" | "openai-completions" = "ollama",
      configuredModel?: Parameters<typeof toDynamicOllamaModel>[0]["model"],
    ): Promise<ProviderRuntimeModel> {
      const ollama = { baseUrl, api, models: configuredModel ? [configuredModel] : [] };
      const result = await ollamaProviderDiscovery.catalog.run({
        config: { models: { providers: { ollama } } },
        agentDir: "/unused",
        env: { OLLAMA_API_KEY: "ollama-local" },
        resolveProviderApiKey: () => ({ apiKey: "ollama-local" }),
        resolveProviderAuth: () => ({ apiKey: "ollama-local", mode: "api_key", source: "env" }),
      });
      expect(result?.outcomes).toMatchObject([{ provider: "ollama", status: "ready" }]);
      const provider = expectDefined(
        result && "provider" in result ? result.provider : undefined,
        "discovered provider",
      );
      const model = expectDefined(provider.models[0] ?? configuredModel, "thinking model");
      return toDynamicOllamaModel({ provider: "ollama", providerConfig: provider, model });
    },
  };
}

const chatContext = { messages: [{ role: "user" as const, content: "Hello", timestamp: 0 }] };

async function expectStop(stream: ReturnType<ReturnType<typeof createOllamaStreamFn>>) {
  expect((await (await stream).result()).stopReason).toBe("stop");
}

async function sendThinking(model: ProviderRuntimeModel, ...levels: ThinkingLevel[]) {
  for (const thinkingLevel of levels) {
    const streamFn = expectDefined(
      createConfiguredOllamaCompatStreamWrapper({
        provider: model.provider,
        modelId: model.id,
        model,
        thinkingLevel,
        streamFn: createOllamaStreamFn(baseUrl),
      }),
      "native Ollama stream wrapper",
    );
    await expectStop(streamFn(model, chatContext, {}));
  }
}

function profileFor(model: ProviderRuntimeModel) {
  return resolveThinkingProfile({ ...model, modelId: model.id });
}

const descriptor = (values: unknown) => ({ values });
const graded = ["low", "medium", "high"];
const extended = [false, "low", "medium", "xhigh"];
const fallback = [false, "low", "high", "high"];
type Mapping = [
  name: string,
  thinking: unknown,
  expected: unknown[],
  capability?: "xhigh" | "minimal" | "legacy",
];

describe("Ollama discovered thinking contracts", () => {
  it("keeps manual model settings while discovering the mandatory native thinking format", async () => {
    const fixture = mockOllama("manual-mandatory-thinking:latest", descriptor([true]));
    fixture.metadata.parameterCount = 70_000_000_000;
    const settings = {
      name: "Manual thinking model",
      contextWindow: 8192,
      maxTokens: 2048,
      compat: { supportsTools: false },
    };
    const model = await fixture.discover("ollama", {
      ...createModel("manual-mandatory-thinking:latest", settings.name, { reasoning: true }),
      ...settings,
    });
    expect(model).toMatchObject({ ...settings, parameterCount: 70_000_000_000 });
    await sendThinking(model, "off", "high");
    expect(fixture.chatBodies.map((body) => body.think)).toEqual([true, true]);
  });

  it("keeps native boolean mappings off the legacy OpenAI-compatible transport", async () => {
    const fixture = mockOllama("thinking-openai-compatible:latest", { values: [false, true] });
    const model = await fixture.discover("openai-completions");
    expect(model.api).toBe("openai-completions");
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it.each<Mapping>([
    ["boolean", descriptor([false, true]), [false, true, true, true]],
    ["mandatory boolean", descriptor([true]), [true, true, true, true]],
    ["graded xhigh", descriptor(extended), [false, "low", "xhigh", "xhigh"], "xhigh"],
    ["mandatory graded", descriptor(graded), ["low", "low", "high", "high"]],
    ["native max", descriptor([false, ...graded, "max"]), [false, "low", "high", "max"]],
    ["native minimal", descriptor([false, "minimal", "low", "high"]), fallback, "minimal"],
    ["missing descriptor", undefined, fallback, "legacy"],
    ["malformed descriptor", descriptor("xhigh"), fallback, "legacy"],
  ])("maps %s discovery to native requests", async (name, thinking, expected, capability) => {
    const fixture = mockOllama(`thinking-${name.replaceAll(" ", "-")}:latest`, thinking);
    const model = await fixture.discover();
    const profile = profileFor(model);
    const xhigh = capability === "xhigh";
    expect(clampThinkingLevel(model, "xhigh")).toBe(xhigh ? "xhigh" : "high");
    expect(clampThinkingLevel(model, "minimal")).toBe(capability && !xhigh ? "minimal" : "low");
    expect(profile.levels.map(({ id }) => id)).toEqual([
      "off",
      ...(capability === "minimal" ? ["minimal"] : []),
      ...graded,
      ...(xhigh ? ["xhigh"] : []),
      "max",
    ]);
    await sendThinking(model, "off", "low", "high", "max");
    expect(fixture.chatBodies.map((body) => body.think)).toEqual(expected);
    for (const body of fixture.chatBodies) {
      expect(body.options).not.toHaveProperty("think");
    }
    if (xhigh) {
      await sendThinking(model, "xhigh");
      expect(fixture.chatBodies.at(-1)?.think).toBe("xhigh");
    }
    expect(fixture.requests.filter((path) => path === "/api/show")).toHaveLength(1);
  });

  it("preserves explicit native think with implicit off and lets an enabled runtime level win", async () => {
    const fixture = mockOllama("thinking-precedence:latest", descriptor(extended));
    const model = await fixture.discover();
    model.params = { think: "xhigh", thinking: "low" };
    await sendThinking(model, "off", "low");
    model.params = { think: false, thinking: "xhigh" };
    await sendThinking(model, "off");
    expect(fixture.chatBodies.map((body) => body.think)).toEqual(["xhigh", "low", false]);
  });

  it("honors reasoning false even when discovery advertised thinking levels", async () => {
    const fixture = mockOllama("thinking-disabled:latest", { values: extended });
    const model = await fixture.discover();
    model.reasoning = false;
    expect(profileFor(model).levels.map(({ id }) => id)).toEqual(["off"]);
    await sendThinking(model, "high", "off");
    expect(fixture.chatBodies.map((body) => body.think)).toEqual([undefined, false]);
  });

  it("lets an off-only descriptor replace a stale cloud thinking floor", async () => {
    const fixture = mockOllama("glm-5.3", { values: [false], default: false });
    const model = await fixture.discover();
    expect(model.reasoning).toBe(false);
    expect(profileFor(model).levels.map(({ id }) => id)).toEqual(["off"]);
    await sendThinking(model, "off");
    expect(fixture.chatBodies.map((body) => body.think)).toEqual([false]);
  });

  it("preserves configured effort over an implicit mandatory-thinking floor, including direct completions", async () => {
    const fixture = mockOllama("thinking-mandatory-precedence:latest", { values: graded });
    const model = await fixture.discover();
    model.params = { think: "medium" };
    await sendThinking(model, "off");
    const streamFn = createOllamaStreamFn(baseUrl);
    await expectStop(streamFn(model, chatContext, { reasoning: "off" }));
    model.params = {};
    await expectStop(streamFn(model, chatContext, { reasoning: "off" }));
    expect(fixture.chatBodies.map((body) => body.think)).toEqual(["medium", "medium", "low"]);
  });

  it("reuses cached thinking metadata until the advertised model digest changes", async () => {
    const fixture = mockOllama("thinking-cache-version:latest", { values: [false, true] });
    await sendThinking(await fixture.discover(), "high");
    await sendThinking(await fixture.discover(), "high");
    expect(fixture.requests.filter((path) => path === "/api/show")).toHaveLength(1);

    fixture.metadata.digest = "second";
    fixture.metadata.thinking = { values: extended };
    await sendThinking(await fixture.discover(), "high");
    expect(fixture.chatBodies.map((body) => body.think)).toEqual([true, true, "xhigh"]);
    expect(fixture.requests.filter((path) => path === "/api/show")).toHaveLength(2);
  });
});
