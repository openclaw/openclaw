import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { buildGoogleProvider } from "../../../../extensions/google/api.js";
import * as loop from "../../../../packages/agent-core/src/agent-loop.test-support.js";
import { buildGoogleGenerateContentParams } from "../../../../packages/ai/src/providers/google-shared.js";
import { prepareFinalModelRequestJson } from "../../../../packages/ai/src/transports/model-request-body.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import * as search from "../../tool-search.js";
import { describeProviderPrefix } from "../prompt-cache-provider-prefix.js";
import * as promptState from "../provider-prompt-state.js";
import * as sessionPrompt from "../session-prompt-state.js";
import { prepareEmbeddedAttemptClientTools } from "./attempt-client-tools.js";
import * as deferred from "./attempt-deferred-tool-resolver.js";

describe("Vertex wire functionDeclarations ordering", () => {
  type Decl = Record<string, unknown> & { name: string };
  const okResult = { content: [{ type: "text" as const, text: "ok" }], details: {} };
  const wireTool = (name: string) => ({ name, description: name, parameters: { type: "object" } });
  const agentTool = (name: string): AnyAgentTool => ({
    ...wireTool(name),
    label: name,
    execute: async () => okResult,
  });
  const mk = (provider: string, api: "google-vertex" | "google-generative-ai", baseUrl: string) =>
    makeProviderModelFixture({ id: "gemini-3.1-pro-preview", provider, api, baseUrl });
  const initTools = ["exec", "read", "write"].map(wireTool);
  const promTools = [...initTools, wireTool("alpha")];
  const gApi = "google-generative-ai";
  const vModel = mk("google-vertex", "google-vertex", "https://aiplatform.googleapis.com");
  const legV = mk("google", gApi, "https://us-central1-aiplatform.googleapis.com/v1beta1");
  const aiStudio = mk("google", gApi, "https://generativelanguage.googleapis.com/v1beta");
  const vRoutes = [vModel, legV];
  const flags = {
    catalogToolHookContext: undefined,
    codeModeControlsEnabledForRun: false,
    deferredDirectoryToolsCallable: false,
  };
  const getDecls = (tools: unknown) =>
    (tools as Array<{ functionDeclarations: Decl[] }> | undefined)?.[0]?.functionDeclarations;

  async function captureDecls(model: typeof vModel, tools: typeof initTools) {
    const opts = { model, modelId: model.id, provider: model.provider };
    const fn = expectDefined(buildGoogleProvider().createStreamFn?.(opts), "stream");
    let captured: Decl[] | undefined;
    const onPayload = (p: unknown) => {
      captured = getDecls((p as { tools?: unknown }).tools);
      throw new Error("Synthetic capture");
    };
    const msg = [{ role: "user" as const, content: "hi", timestamp: 1 }];
    const res = await fn(model, { messages: msg, tools }, { apiKey: "k", onPayload });
    expect((await res.result()).errorMessage).toContain("Synthetic capture");
    return expectDefined(captured, "functionDeclarations");
  }

  it("keeps Vertex wire declarations append-only while direct AI Studio stays alphabetical", async () => {
    for (const model of vRoutes) {
      const before = await captureDecls(model, initTools);
      const after = await captureDecls(model, promTools);
      expect(after.map((e) => e.name)).toEqual(["exec", "read", "write", "alpha"]);
      expect(after.slice(0, before.length)).toEqual(before);
    }
    const sorted = (await captureDecls(aiStudio, promTools)).map((e) => e.name);
    expect(sorted).toEqual(["alpha", "exec", "read", "write"]);
  });

  it("preserves pinned append-only order in sessionToolAllowlist and prepareSessionToolSurface", () => {
    const base = ["exec", "read", "write"].map(agentTool);
    const withAlpha = [...base, agentTool("alpha")];
    const prepared = prepareEmbeddedAttemptClientTools({
      ...flags,
      attempt: { config: {}, sessionId: "v-a", sessionKey: "agent:main:main", runId: "v-r" },
      effectiveTools: withAlpha,
      pinTools: (input) => input,
      replaySafetyOptions: {},
      sessionAgentId: "main",
      toolSearchRuntimeConfig: {},
      uncompactedEffectiveTools: withAlpha,
      clientTools: [],
    });
    expect(prepared.sessionToolAllowlist).toEqual(["exec", "read", "write", "alpha"]);

    using retained = sessionPrompt.retainEmbeddedSessionPromptState("vertex-append-order");
    const req = { state: retained.state, routeKey: "v", toolPolicy: "p1", entries: [] };
    const surf = (tools: AnyAgentTool[]) =>
      sessionPrompt.prepareSessionToolSurface({ ...req, admitNewTools: true, tools });
    expect(surf(base).map((t) => t.name)).toEqual(["exec", "read", "write"]);
    const comp = agentTool("computer");
    expect(sessionPrompt.promoteSessionTool(retained.state, comp)).toBe(true);
    const next = surf([...base, comp, agentTool("alpha")]).map((t) => t.name);
    expect(next).toEqual(["exec", "read", "write", "computer", "alpha"]);
  });

  it("records Vertex cachePrefix via prepareFinalModelRequestJson without transformPayload", async () => {
    const state: promptState.ProviderPromptState = {};
    const done = {
      async *[Symbol.asyncIterator]() {},
      result: async () => ({ stopReason: "stop" }),
    };
    const wrapped = promptState.wrapStreamFnWithProviderPromptState({
      state,
      effectiveContextTokenBudget: 128_000,
      streamFn: async (_model, ctx, opts) => {
        const finalJson = expectDefined(prepareFinalModelRequestJson(opts), "finalJson");
        const txt = (v: unknown) => (typeof v === "string" ? v : "");
        const wire = {
          systemInstruction: { parts: [{ text: ctx.systemPrompt ?? "" }] },
          tools: [{ functionDeclarations: (ctx.tools ?? []).map((t) => ({ name: t.name })) }],
          contents: ctx.messages.map((m) => ({ role: "user", parts: [{ text: txt(m.content) }] })),
          generationConfig: { maxOutputTokens: opts?.maxTokens ?? 8192 },
        };
        await opts?.onPayload?.(wire, vModel);
        expect(await finalJson(JSON.stringify(wire))).toBeInstanceOf(Uint8Array);
        return done as never;
      },
    });
    const m1 = [{ role: "user" as const, content: "t1", timestamp: 1 }];
    const m2 = [...m1, { role: "user" as const, content: "t2", timestamp: 2 }];
    const send = (tools: typeof initTools, messages: typeof m1, maxTokens: number) =>
      wrapped(vModel, { systemPrompt: "Stable", tools, messages }, { maxTokens });

    await send(initTools, m1, 8192);
    const first = expectDefined(state.lastAttempt, "first");
    expect(first.cachePrefix?.messageField).toBe("contents");
    await send(initTools, m2, 4096);
    const second = expectDefined(state.lastAttempt, "second");
    expect(describeProviderPrefix(first, second)).toBe("prefix-match");
    await send(promTools, m2, 4096);
    expect(describeProviderPrefix(second, expectDefined(state.lastAttempt, "third"))).toBe("tools");
  });

  it("loads on-demand tools in the same run on Vertex and legacy Vertex and appends declarations", async () => {
    for (const model of vRoutes) {
      const execute = vi.fn(async () => okResult);
      const target: AnyAgentTool = {
        ...loop.makeTool("alpha_pub"),
        catalogMode: "on-demand",
        execute,
      };
      const config = { tools: { toolSearch: { mode: "tools" as const } } };
      const ref = { ...search.createToolSearchCatalogRef(), loadsOnDemandTools: true as const };
      const ctx = { config, runtimeConfig: config, catalogRef: ref };
      onTestFinished(() => search.clearToolSearchCatalog(ctx));
      const all = [...search.createToolSearchTools(ctx), target];
      const { tools } = search.applyToolSearchCatalog({ ...ctx, tools: all });
      const promoted: string[] = [];
      const onPromoteTool = (t: AnyAgentTool) => promoted.push(t.name);
      const input = {
        attempt: { config, sessionId: "v-same-run", runId: "v-run" },
        clientTools: { ...flags, toolSearchCatalogRef: ref, onPromoteTool },
        customTools: tools,
        runAbortSignal: new AbortController().signal,
        sessionAgentId: "main",
      };
      deferred.installAttemptOnDemandToolLoader(input);
      const seen: Decl[][] = [];
      const turns = [
        [{ ...loop.makeCall("tool_describe", "c1"), arguments: { id: "alpha_pub" } }],
        [{ ...loop.makeCall("alpha_pub", "c2"), arguments: {} }],
        [{ type: "text" as const, text: "done" }],
      ];
      const { agent } = loop.captureAgent(tools, {
        resolveDeferredTool: deferred.createAttemptDeferredToolResolver(input),
        streamFn: loop.createTurnSequenceStream(turns, [], (context) => {
          const p = buildGoogleGenerateContentParams(model as never, context as never, {});
          seen.push(getDecls(p.config?.tools) ?? []);
        }),
      });
      await agent.prompt("look up and call alpha_pub");
      expect(promoted).toEqual(["alpha_pub"]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(seen).toHaveLength(3);
      const r1 = seen[0]?.map((e) => e.name) ?? [];
      expect(r1).not.toContain("alpha_pub");
      expect(seen[1]?.map((e) => e.name)).toEqual([...r1, "alpha_pub"]);
      expect(seen[1]?.slice(0, seen[0]?.length)).toEqual(seen[0]);
    }
  });
});
