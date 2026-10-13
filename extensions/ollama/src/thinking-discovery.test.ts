import { expectDefined } from "@openclaw/normalization-core";
import { clampThinkingLevel } from "openclaw/plugin-sdk/llm";
import type {
  ProviderRuntimeModel,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResponse, requestUrl } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const metadata = { digest: "first", thinking };
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
          model_info: { "test.context_length": 32768 },
          capabilities: ["completion", "thinking"],
          ...(metadata.thinking === undefined ? {} : { thinking: metadata.thinking }),
        });
      }
      if (pathname !== "/api/chat" || typeof init?.body !== "string") {
        throw new Error(`Unexpected Ollama request: ${pathname}`);
      }
      chatBodies.push(requireRecord(JSON.parse(init.body), "Ollama chat request"));
      return new Response(
        JSON.stringify({
          model: modelId,
          message: { role: "assistant", content: "ok" },
          done: true,
          done_reason: "stop",
        }) + "\n",
      );
    }),
  );
  return {
    metadata,
    requests,
    chatBodies,
    async discover(api: "ollama" | "openai-completions" = "ollama"): Promise<ProviderRuntimeModel> {
      const result = await ollamaProviderDiscovery.catalog.run({
        config: { models: { providers: { ollama: { baseUrl, api, models: [] } } } },
        agentDir: "/unused",
        env: { OLLAMA_API_KEY: "ollama-local" },
        resolveProviderApiKey: () => ({ apiKey: "ollama-local" }),
        resolveProviderAuth: () => ({ apiKey: "ollama-local", mode: "api_key", source: "env" }),
      });
      expect(result?.outcomes).toEqual([{ provider: "ollama", status: "ready" }]);
      const provider = expectDefined(
        result && "provider" in result ? result.provider : undefined,
        "discovered provider",
      );
      const model = expectDefined(provider.models[0], "discovered thinking model");
      return toDynamicOllamaModel({ provider: "ollama", providerConfig: provider, model });
    },
  };
}

async function sendThinking(model: ProviderRuntimeModel, thinkingLevel: ThinkingLevel) {
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
  const stream = await streamFn(
    model,
    { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
    {},
  );
  expect((await stream.result()).stopReason).toBe("stop");
}

function profileFor(model: ProviderRuntimeModel) {
  return resolveThinkingProfile({
    provider: model.provider,
    modelId: model.id,
    api: model.api,
    reasoning: model.reasoning,
    compat: model.compat,
    thinkingLevelMap: model.thinkingLevelMap,
  });
}

describe("Ollama discovered thinking contracts", () => {
  it("keeps native boolean mappings off the legacy OpenAI-compatible transport", async () => {
    const fixture = mockOllama("thinking-openai-compatible:latest", { values: [false, true] });
    const model = await fixture.discover("openai-completions");
    expect(model.api).toBe("openai-completions");
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it.each([
    {
      name: "boolean",
      thinking: { values: [false, true], default: true },
      expected: [false, true, true, true],
      xhigh: false,
    },
    {
      name: "mandatory boolean",
      thinking: { values: [true], default: true },
      expected: [true, true, true, true],
      xhigh: false,
    },
    {
      name: "graded xhigh",
      thinking: { values: [false, "low", "medium", "xhigh"], default: "medium" },
      expected: [false, "low", "xhigh", "xhigh"],
      xhigh: true,
    },
    {
      name: "mandatory graded",
      thinking: { values: ["low", "medium", "high"], default: "medium" },
      expected: ["low", "low", "high", "high"],
      xhigh: false,
    },
    {
      name: "native max",
      thinking: { values: [false, "low", "medium", "high", "max"], default: "high" },
      expected: [false, "low", "high", "max"],
      xhigh: false,
    },
    {
      name: "native minimal",
      thinking: { values: [false, "minimal", "low", "high"], default: "low" },
      expected: [false, "low", "high", "high"],
      xhigh: false,
      minimal: true,
      minimalFallback: "minimal",
    },
    {
      name: "missing descriptor",
      thinking: undefined,
      expected: [false, "low", "high", "high"],
      xhigh: false,
      minimalFallback: "minimal",
    },
    {
      name: "malformed descriptor",
      thinking: { values: "xhigh", default: "xhigh" },
      expected: [false, "low", "high", "high"],
      xhigh: false,
      minimalFallback: "minimal",
    },
  ])(
    "maps $name discovery to native requests",
    async ({ name, thinking, expected, xhigh, minimal = false, minimalFallback = "low" }) => {
      const fixture = mockOllama(`thinking-${name.replaceAll(" ", "-")}:latest`, thinking);
      const model = await fixture.discover();
      const profile = profileFor(model);
      expect(clampThinkingLevel(model, "xhigh")).toBe(xhigh ? "xhigh" : "high");
      expect(clampThinkingLevel(model, "minimal")).toBe(minimalFallback);
      expect(profile.levels.map(({ id }) => id)).toEqual([
        "off",
        ...(minimal ? ["minimal"] : []),
        "low",
        "medium",
        "high",
        ...(xhigh ? ["xhigh"] : []),
        "max",
      ]);
      for (const level of ["off", "low", "high", "max"] as const) {
        await sendThinking(model, level);
      }
      expect(fixture.chatBodies.map((body) => body.think)).toEqual(expected);
      for (const body of fixture.chatBodies) {
        expect(body.options).not.toHaveProperty("think");
      }
      if (xhigh) {
        await sendThinking(model, "xhigh");
        expect(fixture.chatBodies.at(-1)?.think).toBe("xhigh");
      }
      expect(fixture.requests.filter((path) => path === "/api/show")).toHaveLength(1);
    },
  );

  it("preserves explicit native think with implicit off and lets an enabled runtime level win", async () => {
    const fixture = mockOllama("thinking-precedence:latest", {
      values: [false, "low", "medium", "xhigh"],
      default: "medium",
    });
    const model = await fixture.discover();
    model.params = { think: "xhigh", thinking: "low" };
    await sendThinking(model, "off");
    await sendThinking(model, "low");
    model.params = { think: false, thinking: "xhigh" };
    await sendThinking(model, "off");
    expect(fixture.chatBodies.map((body) => body.think)).toEqual(["xhigh", "low", false]);
  });

  it("honors reasoning false even when discovery advertised thinking levels", async () => {
    const fixture = mockOllama("thinking-disabled:latest", {
      values: [false, "low", "medium", "xhigh"],
    });
    const model = await fixture.discover();
    model.reasoning = false;
    expect(profileFor(model).levels.map(({ id }) => id)).toEqual(["off"]);
    await sendThinking(model, "high");
    await sendThinking(model, "off");
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
    const fixture = mockOllama("thinking-mandatory-precedence:latest", {
      values: ["low", "medium", "high"],
    });
    const model = await fixture.discover();
    model.params = { think: "medium" };
    await sendThinking(model, "off");
    const streamFn = createOllamaStreamFn(baseUrl);
    const context = { messages: [{ role: "user" as const, content: "Hello", timestamp: 0 }] };
    expect((await (await streamFn(model, context, { reasoning: "off" })).result()).stopReason).toBe(
      "stop",
    );
    model.params = {};
    expect((await (await streamFn(model, context, { reasoning: "off" })).result()).stopReason).toBe(
      "stop",
    );
    expect(fixture.chatBodies.map((body) => body.think)).toEqual(["medium", "medium", "low"]);
  });

  it("reuses cached thinking metadata until the advertised model digest changes", async () => {
    const fixture = mockOllama("thinking-cache-version:latest", { values: [false, true] });
    await sendThinking(await fixture.discover(), "high");
    await sendThinking(await fixture.discover(), "high");
    expect(fixture.requests.filter((path) => path === "/api/show")).toHaveLength(1);

    fixture.metadata.digest = "second";
    fixture.metadata.thinking = { values: [false, "low", "medium", "xhigh"] };
    await sendThinking(await fixture.discover(), "high");
    expect(fixture.chatBodies.map((body) => body.think)).toEqual([true, true, "xhigh"]);
    expect(fixture.requests.filter((path) => path === "/api/show")).toHaveLength(2);
  });
});
