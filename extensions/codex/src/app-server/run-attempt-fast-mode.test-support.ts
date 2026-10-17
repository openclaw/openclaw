import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it, vi } from "vitest";
import {
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import type { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { createCodexTestOAuthProfile } from "./test-support.js";

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

type Requests = ReturnType<typeof createResumeHarness>["requests"];
const requestsFor = (requests: Requests, method: string) =>
  requests.filter((request) => request.method === method);
const requestParams = (requests: Requests, method: string) =>
  requestsFor(requests, method)[0]?.params;
const turnTiers = (requests: Requests) =>
  requestsFor(requests, "turn/start").map(
    (request) => (request.params as { serviceTier?: string | null }).serviceTier,
  );

function modelCatalog(supported: boolean, id = "catalog-alias", paginated = false) {
  return {
    ...(paginated ? { nextCursor: null } : {}),
    data: [
      {
        id,
        model: "gpt-5.4-codex",
        displayName: "Test model",
        description: "Test model",
        hidden: false,
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: "medium",
        serviceTiers: supported
          ? [{ id: "ultrafast", name: "Ultrafast", description: "Faster" }]
          : [],
      },
    ],
  };
}

const catalogRequest =
  (supported: () => boolean, id?: string, paginated = false) =>
  async (method: string) =>
    method === "model/list" ? modelCatalog(supported(), id, paginated) : undefined;

type UltrafastCase = {
  name: string;
  supported: boolean;
  fastMode: EmbeddedRunAttemptParams["fastMode"];
  enableUltrafast: boolean;
  expected: string;
  nativeLimit: number | undefined;
  expectedLimit: number | undefined;
  fresh: boolean;
  nativeOwned: false | "metadata" | "omitted";
};

function ultrafastCase(name: string, overrides: Partial<UltrafastCase> = {}): UltrafastCase {
  return {
    name,
    supported: true,
    fastMode: "ultrafast",
    enableUltrafast: true,
    expected: "ultrafast",
    nativeLimit: 700_000,
    expectedLimit: 260_000,
    fresh: false,
    nativeOwned: false,
    ...overrides,
  };
}

/** Exercise speed changes under the attempt suite's shared lifecycle and cleanup. */
export function registerCodexFastModeTests({
  createRunPaths,
  writeExistingBinding,
  completeStartedRun,
}: FastModeFixtures) {
  it("maps fast on with flex baseline to app-server resume and turn service tier", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, { model: "gpt-5.2" });
    const { requests, waitForMethod, completeTurn } = createResumeHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.fastMode = true;
    const onAgentEvent = vi.fn();
    params.onAgentEvent = onAgentEvent;
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { serviceTier: "flex" } },
    });
    await completeStartedRun(run, waitForMethod, completeTurn, "thread-existing");
    for (const method of ["thread/resume", "turn/start"]) {
      expect(requestParams(requests, method)).toMatchObject({ serviceTier: "priority" });
    }
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "codex_app_server.lifecycle",
      data: expect.objectContaining({ phase: "turn_starting", serviceTier: "priority" }),
    });
  });

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
    expect(requestParams(requests, "thread/resume")).toMatchObject({ serviceTier: null });
    expect(requestParams(requests, "turn/start")).toMatchObject({ serviceTier: "priority" });
  });
  it.each([
    ultrafastCase("explicit Ultrafast with the switch disabled", {
      enableUltrafast: false,
      expected: "priority",
      expectedLimit: undefined,
    }),
    ...[false, true].flatMap((fresh) =>
      [
        [700_000, 260_000],
        [120_000, 120_000],
        [0, 0],
        [-1, -1],
        [undefined, 260_000],
      ].map(([nativeLimit, expectedLimit]) =>
        ultrafastCase(`Ultrafast ${fresh ? "start" : "resume"} with native limit ${nativeLimit}`, {
          nativeLimit,
          expectedLimit,
          fresh,
        }),
      ),
    ),
    ultrafastCase("unsupported Ultrafast", {
      supported: false,
      expected: "priority",
      expectedLimit: undefined,
    }),
    ultrafastCase("an adopted native model changed since the saved binding", {
      nativeOwned: "metadata",
    }),
    ultrafastCase("an adopted native model with omitted metadata", {
      expected: "priority",
      expectedLimit: undefined,
      nativeOwned: "omitted",
    }),
    ultrafastCase("Fast with the Ultrafast switch enabled", {
      fastMode: true,
      expected: "priority",
      expectedLimit: undefined,
    }),
  ])("requires explicit Ultrafast for $name at the actual turn boundary", async (row) => {
    const { fresh, nativeOwned, expectedLimit } = row;
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
            model_auto_compact_token_limit: row.nativeLimit,
            model_auto_compact_token_limit_scope: "body_after_prefix",
          },
          origins: {},
          layers: [],
        };
      }
      if (method === "model/list") {
        return modelCatalog(row.supported, undefined, true);
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
    params.fastMode = row.fastMode;
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { enableUltrafast: row.enableUltrafast } },
    });
    const method = fresh ? "thread/start" : "thread/resume";
    await Promise.race([run, harness.waitForMethod(method)]);
    const threadRequest = requestParams(harness.requests, method) as {
      config?: Record<string, unknown>;
    };
    expect(threadRequest.config?.model_auto_compact_token_limit).toBe(expectedLimit);
    expect(threadRequest.config?.model_auto_compact_token_limit_scope).toBe(
      expectedLimit === undefined ? undefined : "total",
    );
    await completeStartedRun(
      run,
      harness.waitForMethod,
      harness.completeTurn,
      fresh ? "thread-1" : "thread-existing",
    );
    expect(requestParams(harness.requests, "turn/start")).toMatchObject({
      serviceTier: row.expected,
    });
    expect(requestsFor(harness.requests, "model/list")).toHaveLength(
      row.fastMode === "ultrafast" && row.enableUltrafast ? 1 : 0,
    );
  });

  it.each([
    ["revoked Ultrafast", "ultrafast", undefined, "priority"],
    ["unsupported priority baseline", undefined, "priority", "priority"],
    // Removing the cap cold-resumes native defaults, clearing the previous tier override.
    ["unsupported default baseline", undefined, undefined, undefined],
  ] as const)(
    "reselects the tier for %s after an explicit Ultrafast warm turn",
    async (_name, fastMode, baseline, expected) => {
      const { sessionFile, workspaceDir } = createRunPaths();
      await writeExistingBinding(sessionFile, workspaceDir, { model: "gpt-5.2" });
      let catalogSupported = true;
      const harness = createResumeHarness(
        "thread-existing",
        catalogRequest(() => catalogSupported),
      );
      for (let turn = 0; turn < 2; turn += 1) {
        catalogSupported = turn === 0;
        const params = createParams(sessionFile, workspaceDir);
        params.fastMode = turn === 0 ? "ultrafast" : fastMode;
        const run = runCodexAppServerAttempt(params, {
          pluginConfig: { appServer: { serviceTier: baseline } },
        });
        await run.waitForTurnAccepted();
        await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
        await run;
      }
      expect(turnTiers(harness.requests)).toEqual(["ultrafast", expected]);
      const resumeConfigs = requestsFor(harness.requests, "thread/resume").map(
        (request) => (request.params as { config: Record<string, unknown> }).config,
      );
      expect(resumeConfigs.map((config) => config.model_auto_compact_token_limit)).toEqual([
        260_000,
        undefined,
      ]);
      expect(requestsFor(harness.requests, "model/list")).toHaveLength(
        fastMode === "ultrafast" ? 2 : 1,
      );
    },
  );

  it("keeps explicit Ultrafast when a ChatGPT sign-in thread resumes", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    // ChatGPT sign-in bindings store no provider; Codex owns the native provider.
    await writeExistingBinding(sessionFile, workspaceDir, {
      model: "gpt-5.2",
      modelProvider: undefined,
      authProfileId: "openai:work",
    });
    const harness = createResumeHarness(
      "thread-existing",
      catalogRequest(() => true, "gpt-5.4-codex", true),
    );
    // Turn 1 resumes the stored thread; turn 2 reuses the warm thread.
    for (let turn = 0; turn < 2; turn += 1) {
      const params = createParams(sessionFile, workspaceDir, { provider: "openai" });
      params.fastMode = "ultrafast";
      params.authProfileId = "openai:work";
      params.authProfileStore = {
        version: 1,
        profiles: { "openai:work": createCodexTestOAuthProfile("account-work") },
      };
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
      await run;
    }
    expect(requestsFor(harness.requests, "thread/resume")).toHaveLength(1);
    expect(turnTiers(harness.requests)).toEqual(["ultrafast", "ultrafast"]);
  });
}
