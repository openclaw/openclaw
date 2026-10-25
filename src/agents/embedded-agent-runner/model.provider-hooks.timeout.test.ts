import { createServer, type Server } from "node:http";
import { withFirstStreamEventTimeout } from "@openclaw/ai/internal/runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { StreamFn } from "../runtime/index.js";
import { guardModelFixtureAuth } from "./model.fixture.test-support.js";
import { resolveModelAsync } from "./model.js";
import type { ProviderRuntimeHooks } from "./model.provider-hooks.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";
import { makeModel } from "./model.test-harness.js";
import {
  resolveLlmFirstEventTimeoutMs,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./run/llm-idle-timeout.js";

const PROVIDER = "ai-brick";
const MODEL_ID = "ornith-1.0-35b";
const CONFIGURED_TIMEOUT_MS = 1_000;
const HOOK_TIMEOUT_MS = 2_500;
const HTTP_EVENT_DELAY_MS = 90;
const SHORT_CONTROL_TIMEOUT_MS = 20;

type RebuildingHookStage = "model" | "transport";

let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "provider-timeout" });
  const auth = guardModelFixtureAuth(state.root);
  return async () => {
    try {
      auth.verify();
    } finally {
      auth.spy.mockRestore();
      await state.cleanup();
    }
  };
});

function rebuildProviderModel(
  model: ProviderRuntimeModel,
  requestTimeoutMs?: number,
): ProviderRuntimeModel {
  const rebuilt = { ...model };
  delete rebuilt.requestTimeoutMs;
  if (requestTimeoutMs !== undefined) {
    rebuilt.requestTimeoutMs = requestTimeoutMs;
  }
  return rebuilt;
}

function createRebuildingRuntimeHooks(
  stage: RebuildingHookStage,
  requestTimeoutMs?: number,
): ProviderRuntimeHooks {
  const hooks = createProviderRuntimeTestMock();
  if (stage === "model") {
    return {
      ...hooks,
      normalizeProviderResolvedModelWithPlugin: ({ context }) =>
        rebuildProviderModel(context.model, requestTimeoutMs),
    };
  }
  return {
    ...hooks,
    applyProviderResolvedTransportWithPlugin: ({ context }) =>
      rebuildProviderModel(context.model, requestTimeoutMs),
  };
}

async function resolveProviderModel(params: {
  baseUrl?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Promise<ProviderRuntimeModel> {
  const result = await resolveModelAsync(
    PROVIDER,
    MODEL_ID,
    state.agentDir(),
    {
      models: {
        providers: {
          [PROVIDER]: {
            baseUrl: params.baseUrl ?? "http://127.0.0.1:8123/v1",
            api: "openai-completions",
            timeoutSeconds: CONFIGURED_TIMEOUT_MS / 1_000,
            models: [{ ...makeModel(MODEL_ID), contextWindow: 8_192, maxTokens: 512 }],
          },
        },
      },
    },
    {
      authStorage: { mocked: true } as never,
      modelRegistry: { find: () => null, getProviderMetadataOwners: () => undefined } as never,
      runtimeHooks: params.runtimeHooks ?? createProviderRuntimeTestMock(),
      skipAgentDiscovery: true,
      workspaceDir: state.workspaceDir,
    },
  );
  if (!result.model) {
    throw new Error(`Expected a resolved provider model: ${result.error ?? "unknown error"}`);
  }
  return result.model as ProviderRuntimeModel;
}

async function listenForDelayedSse(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    });
    response.flushHeaders();
    const timer = setTimeout(() => {
      response.end('data: {"message":"provider event"}\n\n');
    }, HTTP_EVENT_DELAY_MS);
    response.once("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Expected a loopback SSE server address");
  }
  return { server, url: `http://127.0.0.1:${address.port}/v1/stream` };
}

async function nextGuardedHttpEvent(
  url: string,
  wrap: (source: AsyncIterable<string>) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>,
): Promise<IteratorResult<unknown>> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) {
    throw new Error(`Expected an HTTP SSE response, received ${response.status}`);
  }
  const body = response.body;
  const source = (async function* () {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          return;
        }
        yield decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  })();
  let iterator: AsyncIterator<unknown> | undefined;
  try {
    iterator = (await wrap(source))[Symbol.asyncIterator]();
    return await iterator.next();
  } finally {
    // First-event return is fire-and-forget; idle timeout can leave next() pending.
    // Abort the native read and join the source itself before server/state disposal.
    controller.abort();
    await withTestTimeout(
      Promise.all([iterator?.return?.(), source.return(undefined)]),
      CONFIGURED_TIMEOUT_MS,
      "HTTP fixture source did not settle",
    );
    expect(body.locked).toBe(false);
  }
}

async function nextIdleGuardedHttpEvent(params: {
  url: string;
  model: ProviderRuntimeModel;
  timeoutMs: number;
}): Promise<IteratorResult<unknown>> {
  return await nextGuardedHttpEvent(params.url, async (source) => {
    const baseFn = (() => source) as unknown as StreamFn;
    return await streamWithIdleTimeout(baseFn, params.timeoutMs)(
      params.model as Parameters<StreamFn>[0],
      { messages: [] },
    );
  });
}

describe("provider request timeout across rebuilding runtime hooks", () => {
  it.each([
    ["transport", undefined, CONFIGURED_TIMEOUT_MS],
    ["model", HOOK_TIMEOUT_MS, HOOK_TIMEOUT_MS],
  ] as const)(
    "preserves timeout through the %s hook (override %s)",
    async (stage, override, expected) => {
      const model = await resolveProviderModel({
        runtimeHooks: createRebuildingRuntimeHooks(stage, override),
      });
      expect(model.requestTimeoutMs).toBe(expected);
    },
  );

  it("applies the surviving configured timeout to real HTTP first-event and idle guards", async () => {
    const { server, url } = await listenForDelayedSse();
    try {
      const model = await resolveProviderModel({
        baseUrl: url.replace(/\/stream$/, ""),
        runtimeHooks: createRebuildingRuntimeHooks("model"),
      });
      expect(model.requestTimeoutMs).toBe(CONFIGURED_TIMEOUT_MS);
      const timeoutParams = { model, modelRequestTimeoutMs: model.requestTimeoutMs };
      const guards = [
        {
          timeout: resolveLlmFirstEventTimeoutMs(timeoutParams),
          error: /first-event timeout/,
          next: (timeoutMs: number) =>
            nextGuardedHttpEvent(url, (source) =>
              withFirstStreamEventTimeout(source, { timeoutMs }),
            ),
        },
        {
          timeout: resolveLlmIdleTimeoutMs(timeoutParams),
          error: /LLM idle timeout/,
          next: (timeoutMs: number) => nextIdleGuardedHttpEvent({ url, model, timeoutMs }),
        },
      ];
      for (const { timeout, error, next } of guards) {
        expect(timeout).toBe(CONFIGURED_TIMEOUT_MS);
        await expect(next(SHORT_CONTROL_TIMEOUT_MS)).rejects.toThrow(error);
        expect((await next(timeout)).value).toContain("provider event");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
