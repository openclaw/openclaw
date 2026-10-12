import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerPreparedAuthHandoff } from "./auth-bridge.js";
import { codexModel, createClientFactory } from "./bounded-turn.test-harness.js";
import {
  CodexAppServerLocalRequestCancellationError,
  CodexAppServerScopedRequestRejectedError,
} from "./rpc-error.js";
import * as sharedClient from "./shared-client.js";

// mock-isolation: Keep credential stores outside the native request boundary fixture.
vi.mock("./auth-bridge.js", () => ({
  resolveCodexAppServerPreparedAuthHandoff: vi.fn(async () => ({ nativeAuthProfile: true })),
}));

import { runCodexIsolatedCompletion } from "./isolated-completion.js";

type IsolatedParams = Parameters<NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>>[0];

function createParams(overrides: Partial<IsolatedParams> = {}): IsolatedParams {
  return {
    authorization: {
      owner: "harness",
      plan: { providerForAuth: "openai", authProfileProviderForAuth: "openai" },
      authProfileStore: { version: 1, profiles: {} },
    },
    config: {},
    provider: "openai",
    modelId: "gpt-5.4",
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    systemPrompt: "Name the conversation.",
    prompt: "Help me plan a garden.",
    timeoutMs: 5_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Codex isolated completion native boundary", () => {
  it.each(
    (["agent", "user"] as const).flatMap((homeScope) =>
      (["completed", "failed", "rejected"] as const).map((outcome) => ({ homeScope, outcome })),
    ),
  )(
    "reports only native request time for $homeScope isolation and $outcome turns",
    async ({ homeScope, outcome }) => {
      vi.useFakeTimers();
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      vi.mocked(resolveCodexAppServerPreparedAuthHandoff).mockImplementationOnce(async () => {
        now += 100;
        return { nativeAuthProfile: true };
      });
      const onRequestComplete = vi.fn();
      const fake = createClientFactory({
        terminalStatus: outcome === "failed" ? "failed" : "completed",
        terminalError: outcome === "failed" ? { message: "native request failed" } : undefined,
        beforeRequest: async (method) => {
          now += method === "turn/start" ? 25 : 10;
          if (method === "turn/start" && outcome === "rejected") {
            throw new Error("native request rejected");
          }
        },
      });
      let reportedBeforeCleanup = false;
      vi.spyOn(sharedClient, "createIsolatedCodexAppServerClient").mockImplementation(
        async (options) => {
          now += 200;
          const client = await fake.factory(options);
          vi.spyOn(client, "closeAndWait").mockImplementation(async () => {
            reportedBeforeCleanup = onRequestComplete.mock.calls.length === 1;
            now += 400;
            return { exited: true, cleanup: "closed" };
          });
          return client;
        },
      );

      const completion = runCodexIsolatedCompletion(createParams({ onRequestComplete }), {
        pluginConfig: { appServer: { homeScope } },
      });
      if (outcome === "completed") {
        await expect(completion).resolves.toMatchObject({
          assistant: { content: [{ type: "text", text: "The message was sent successfully." }] },
        });
      } else {
        await expect(completion).rejects.toThrow(
          outcome === "failed" ? "native request failed" : "native request rejected",
        );
      }
      expect(onRequestComplete).toHaveBeenCalledExactlyOnceWith(25);
      expect(reportedBeforeCleanup).toBe(true);
      expect(now).toBeGreaterThan(725);
      expect(fake.methods).toContain("thread/start");
      expect(fake.methods).toContain("turn/start");
    },
  );

  it.each(["auth", "client", "thread"] as const)(
    "does not report a duration when %s preparation rejects",
    async (stage) => {
      vi.useFakeTimers();
      const failure = new Error(`${stage} preparation failed`);
      const onRequestComplete = vi.fn();
      const fake = createClientFactory({
        beforeRequest: async (method) => {
          if (stage === "thread" && method === "thread/start") {
            throw failure;
          }
        },
      });
      if (stage === "auth") {
        vi.mocked(resolveCodexAppServerPreparedAuthHandoff).mockRejectedValueOnce(failure);
      }
      vi.spyOn(sharedClient, "createIsolatedCodexAppServerClient").mockImplementation(
        async (options) => {
          if (stage === "client") {
            throw failure;
          }
          return await fake.factory(options);
        },
      );

      await expect(
        runCodexIsolatedCompletion(createParams({ onRequestComplete }), {}),
      ).rejects.toBe(failure);
      expect(onRequestComplete).not.toHaveBeenCalled();
      expect(fake.methods).not.toContain("turn/start");
    },
  );

  it.each(["scope", "cancellation"] as const)(
    "does not report a duration for prewrite %s rejection",
    async (kind) => {
      vi.useFakeTimers();
      const cause = new Error("request not dispatched");
      const failure =
        kind === "scope"
          ? new CodexAppServerScopedRequestRejectedError("retired", { cause })
          : new CodexAppServerLocalRequestCancellationError("turn/start", "aborted", false, cause);
      const onRequestComplete = vi.fn();
      const fake = createClientFactory({
        beforeRequest: async (method) => {
          if (method === "turn/start") {
            throw failure;
          }
        },
      });

      await expect(
        runCodexIsolatedCompletion(createParams({ onRequestComplete }), {
          clientFactory: fake.factory,
        }),
      ).rejects.toBe(kind === "scope" ? cause : failure);
      expect(onRequestComplete).not.toHaveBeenCalled();
    },
  );

  it.each([
    { thinkLevel: undefined, supported: ["low", "high"], expected: "low" },
    { thinkLevel: "max", supported: ["medium", "xhigh"], expected: "xhigh" },
    { thinkLevel: "off", supported: ["none", "low"], expected: "none" },
  ] as const)(
    "maps requested reasoning $thinkLevel to native effort $expected",
    async ({ thinkLevel, supported, expected }) => {
      const fake = createClientFactory({
        models: [
          {
            ...codexModel(),
            supportedReasoningEfforts: supported.map((reasoningEffort) => ({
              reasoningEffort,
              description: reasoningEffort,
            })),
          },
        ],
      });

      await runCodexIsolatedCompletion(createParams({ thinkLevel }), {
        clientFactory: fake.factory,
      });

      const turn = fake.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
      expect(turn).toMatchObject({ effort: expected });
    },
  );

  it.each([undefined, "strict-visible"] as const)(
    "applies output policy %s to a successful native turn without an answer",
    async (outputTextPolicy) => {
      const fake = createClientFactory({ emptyAnswer: true });
      const completion = runCodexIsolatedCompletion(createParams({ outputTextPolicy }), {
        clientFactory: fake.factory,
      });

      if (outputTextPolicy === "strict-visible") {
        await expect(completion).resolves.toMatchObject({
          assistant: {
            stopReason: "stop",
            content: [{ type: "text", text: "" }],
          },
        });
      } else {
        await expect(completion).rejects.toThrow("isolated completion turn returned no text");
      }
    },
  );
});
