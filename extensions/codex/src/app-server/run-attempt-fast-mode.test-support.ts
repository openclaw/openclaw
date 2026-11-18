import { expect, it, vi } from "vitest";
import { createModelFixture } from "./model-fixture.test-support.js";
import {
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import type { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { createCodexTestOAuthProfile } from "./test-support.js";

function fastModeModel(supported: boolean, id = "catalog-alias") {
  return {
    ...createModelFixture(id),
    model: "gpt-5.4-codex",
    displayName: "Test model",
    description: "Test model",
    serviceTiers: supported ? [{ id: "ultrafast", name: "Ultrafast", description: "Faster" }] : [],
  };
}

type FastModeFixtures = {
  createRunPaths: () => { sessionFile: string; workspaceDir: string };
  writeExistingBinding: (
    sessionFile: string,
    workspaceDir: string,
    overrides?: Partial<Parameters<typeof writeCodexAppServerBinding>[1]>,
  ) => Promise<void>;
  completeStartedRun: (
    run: Promise<unknown>,
    waitForMethod: ReturnType<typeof createStartedThreadHarness>["waitForMethod"],
    completeTurn: ReturnType<typeof createStartedThreadHarness>["completeTurn"],
    threadId?: string,
  ) => Promise<void>;
};

type ModeCase = {
  name: string;
  options: {
    supported?: boolean;
    fastMode?: true | "ultrafast";
    enableUltrafast?: boolean;
    nativeLimit?: number;
    fresh?: boolean;
    nativeOwned?: "metadata" | "omitted";
  };
  tier: "priority" | "ultrafast";
  limit: number | undefined;
};

/** Exercise speed changes under the attempt suite's shared lifecycle and cleanup. */
export function registerCodexFastModeTests({
  createRunPaths,
  writeExistingBinding,
  completeStartedRun,
}: FastModeFixtures) {
  it("uses shared Fast priority when auto activates after resume", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, { model: "gpt-5.2" });
    const { requests, waitForMethod, completeTurn } = createResumeHarness();
    const params = createParams(sessionFile, workspaceDir);
    let fastMode = false;
    params.fastMode = () => fastMode;
    params.onAgentEvent = (event) => {
      if (event.stream === "codex_app_server.lifecycle" && event.data.phase === "thread_ready") {
        fastMode = true;
      }
    };
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { serviceTier: "ultrafast" } },
    });
    await completeStartedRun(run, waitForMethod, completeTurn, "thread-existing");
    expect(requests.find((request) => request.method === "thread/resume")?.params).toMatchObject({
      serviceTier: null,
    });
    expect(requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      serviceTier: "priority",
    });
  });
  it.each<ModeCase>([
    {
      name: "disabled switch",
      options: { enableUltrafast: false },
      tier: "priority",
      limit: undefined,
    },
    { name: "fresh capped limit", options: { fresh: true }, tier: "ultrafast", limit: 260_000 },
    { name: "smaller limit", options: { nativeLimit: 120_000 }, tier: "ultrafast", limit: 120_000 },
    { name: "zero limit", options: { nativeLimit: 0 }, tier: "ultrafast", limit: 0 },
    { name: "negative limit", options: { nativeLimit: -1 }, tier: "ultrafast", limit: -1 },
    {
      name: "missing limit",
      options: { nativeLimit: undefined },
      tier: "ultrafast",
      limit: 260_000,
    },
    {
      name: "unsupported model",
      options: { supported: false },
      tier: "priority",
      limit: undefined,
    },
    {
      name: "changed native model",
      options: { nativeOwned: "metadata" },
      tier: "ultrafast",
      limit: 260_000,
    },
    {
      name: "omitted native model",
      options: { nativeOwned: "omitted" },
      tier: "priority",
      limit: undefined,
    },
    {
      name: "Fast with flex baseline",
      options: { fastMode: true },
      tier: "priority",
      limit: undefined,
    },
  ])(
    "requires explicit Ultrafast for $name at the actual turn boundary",
    async ({ options, tier, limit }) => {
      const { supported, fastMode, enableUltrafast, nativeLimit, fresh, nativeOwned } = {
        supported: true,
        fastMode: "ultrafast" as const,
        enableUltrafast: true,
        nativeLimit: 700_000,
        fresh: false,
        nativeOwned: false,
        ...options,
      };
      const { sessionFile, workspaceDir } = createRunPaths();
      if (!fresh) {
        await writeExistingBinding(sessionFile, workspaceDir, {
          model: nativeOwned ? "previous-native-model" : "gpt-5.2",
          ...(nativeOwned ? { preserveNativeModel: true } : {}),
        });
      }
      const requestImpl = async (method: string) => {
        if (nativeOwned && method === "thread/resume") {
          return {
            ...threadStartResult("thread-existing"),
            model: nativeOwned === "metadata" ? "gpt-5.4-codex" : "previous-native-model",
          };
        }
        if (method === "config/read") {
          return {
            config: {
              model_auto_compact_token_limit: nativeLimit,
              model_auto_compact_token_limit_scope: "body_after_prefix",
            },
            origins: {},
            layers: [],
          };
        }
        if (method === "model/list") {
          return {
            data: [fastModeModel(supported)],
            nextCursor: null,
          };
        }
        return undefined;
      };
      const persistedThread = threadStartResult("thread-existing");
      const harness = fresh
        ? createStartedThreadHarness(requestImpl)
        : createResumeHarness(
            "thread-existing",
            requestImpl,
            nativeOwned === "metadata"
              ? {
                  ...persistedThread,
                  thread: { ...persistedThread.thread, model: "gpt-5.4-codex" },
                }
              : undefined,
          );
      const params = createParams(sessionFile, workspaceDir);
      params.fastMode = fastMode;
      const onAgentEvent = vi.fn();
      params.onAgentEvent = onAgentEvent;
      const run = runCodexAppServerAttempt(params, {
        pluginConfig: {
          appServer: {
            enableUltrafast,
            ...(fastMode === true ? { serviceTier: "flex" as const } : {}),
          },
        },
      });
      await Promise.race([run, harness.waitForMethod(fresh ? "thread/start" : "thread/resume")]);
      const threadRequest = harness.requests.find(
        (request) => request.method === (fresh ? "thread/start" : "thread/resume"),
      )?.params as { config?: Record<string, unknown> };
      expect(threadRequest.config?.model_auto_compact_token_limit).toBe(limit);
      expect(threadRequest.config?.model_auto_compact_token_limit_scope).toBe(
        limit === undefined ? undefined : "total",
      );
      await completeStartedRun(
        run,
        harness.waitForMethod,
        harness.completeTurn,
        fresh ? "thread-1" : "thread-existing",
      );
      expect(
        harness.requests.find((request) => request.method === "turn/start")?.params,
      ).toMatchObject({
        serviceTier: tier,
      });
      if (fastMode === true) {
        expect(threadRequest).toMatchObject({ serviceTier: "priority" });
        expect(onAgentEvent).toHaveBeenCalledWith({
          stream: "codex_app_server.lifecycle",
          data: expect.objectContaining({ phase: "turn_starting", serviceTier: "priority" }),
        });
      }
      expect(harness.requests.filter((request) => request.method === "model/list")).toHaveLength(
        fastMode === "ultrafast" && enableUltrafast ? 1 : 0,
      );
    },
  );

  it.each([
    ["revoked Ultrafast", "ultrafast", undefined, "priority", false],
    ["unsupported priority baseline", undefined, "priority", "priority", false],
    // Removing the cap cold-resumes native defaults, clearing the previous tier override.
    ["unsupported default baseline", undefined, undefined, undefined, false],
    ["ChatGPT sign-in", "ultrafast", undefined, "ultrafast", true],
  ] as const)(
    "reselects the tier for %s after an explicit Ultrafast warm turn",
    async (_name, fastMode, baseline, expected, oauth) => {
      const { sessionFile, workspaceDir } = createRunPaths();
      await writeExistingBinding(sessionFile, workspaceDir, {
        model: "gpt-5.2",
        ...(oauth ? { modelProvider: undefined, authProfileId: "openai:work" } : {}),
      });
      let catalogSupported = true;
      const harness = createResumeHarness("thread-existing", async (method) => {
        if (method === "model/list") {
          return {
            data: [fastModeModel(catalogSupported, oauth ? "gpt-5.4-codex" : undefined)],
          };
        }
        return undefined;
      });
      for (let turn = 0; turn < 2; turn += 1) {
        catalogSupported = turn === 0 || oauth;
        const params = createParams(sessionFile, workspaceDir, oauth ? { provider: "openai" } : {});
        params.fastMode = turn === 0 ? "ultrafast" : fastMode;
        if (oauth) {
          params.authProfileId = "openai:work";
          params.authProfileStore = {
            version: 1,
            profiles: { "openai:work": createCodexTestOAuthProfile("account-work") },
          };
        }
        const run = runCodexAppServerAttempt(params, {
          pluginConfig: { appServer: { serviceTier: baseline } },
        });
        await run.waitForTurnAccepted();
        await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
        await run;
      }
      expect(
        harness.requests
          .filter((request) => request.method === "turn/start")
          .map((request) => (request.params as { serviceTier?: string | null }).serviceTier),
      ).toEqual(["ultrafast", expected]);
      if (oauth) {
        expect(harness.requests.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
        return;
      }
      const resumeConfigs = harness.requests
        .filter((request) => request.method === "thread/resume")
        .map((request) => (request.params as { config: Record<string, unknown> }).config);
      expect(resumeConfigs.map((config) => config.model_auto_compact_token_limit)).toEqual([
        260_000,
        undefined,
      ]);
      expect(harness.requests.filter((request) => request.method === "model/list")).toHaveLength(
        fastMode === "ultrafast" ? 2 : 1,
      );
    },
  );
}
