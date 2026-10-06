import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it, vi } from "vitest";
import {
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
} from "./run-attempt-test-harness.js";
import type { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";

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

/** Exercise speed changes under the attempt suite's shared lifecycle and cleanup. */
export function registerCodexFastModeTests({
  createRunPaths,
  writeExistingBinding,
  completeStartedRun,
}: FastModeFixtures) {
  it.each([
    { name: "fast on", fastMode: true, expectedServiceTier: "priority" },
    {
      name: "fast on with flex baseline",
      fastMode: true,
      configuredServiceTier: "flex",
      expectedServiceTier: "priority",
    },
    {
      name: "fast off",
      fastMode: false,
      configuredServiceTier: "priority",
      expectedServiceTier: null,
    },
    {
      name: "fast auto active",
      fastMode: () => true,
      expectedServiceTier: "priority",
    },
    {
      name: "fast on with configured tier",
      fastMode: true,
      configuredServiceTier: "ultrafast",
      expectedServiceTier: "priority",
    },
    {
      name: "fast off with configured tier",
      fastMode: false,
      configuredServiceTier: "ultrafast",
      expectedServiceTier: null,
    },
    {
      name: "fast auto active with configured tier",
      fastMode: () => true,
      configuredServiceTier: "ultrafast",
      expectedServiceTier: "priority",
    },
    {
      name: "configured non-priority tier",
      fastMode: undefined,
      configuredServiceTier: "flex",
      expectedServiceTier: "flex",
    },
    {
      name: "configured Ultrafast without a shared selection",
      fastMode: undefined,
      configuredServiceTier: "ultrafast",
      expectedServiceTier: "priority",
    },
  ] satisfies Array<{
    name: string;
    fastMode: EmbeddedRunAttemptParams["fastMode"];
    configuredServiceTier?: "flex" | "priority" | "ultrafast";
    expectedServiceTier?: "flex" | "priority" | "ultrafast" | null;
  }>)(
    "maps $name to app-server resume and turn service tier",
    async ({ fastMode, configuredServiceTier, expectedServiceTier }) => {
      const { sessionFile, workspaceDir } = createRunPaths();
      await writeExistingBinding(sessionFile, workspaceDir, { model: "gpt-5.2" });
      const { requests, waitForMethod, completeTurn } = createResumeHarness();
      const params = createParams(sessionFile, workspaceDir);
      params.fastMode = fastMode;
      const onAgentEvent = vi.fn();
      params.onAgentEvent = onAgentEvent;
      const options = configuredServiceTier
        ? { pluginConfig: { appServer: { serviceTier: configuredServiceTier } } }
        : {};
      const run = runCodexAppServerAttempt(params, options);
      await completeStartedRun(run, waitForMethod, completeTurn, "thread-existing");
      for (const method of ["thread/resume", "turn/start"]) {
        const request = requests.find((entry) => entry.method === method);
        const requestParams = request?.params as Record<string, unknown> | undefined;
        expect(requestParams?.serviceTier).toBe(expectedServiceTier);
      }
      expect(onAgentEvent).toHaveBeenCalledWith({
        stream: "codex_app_server.lifecycle",
        data: expect.objectContaining({
          phase: "turn_starting",
          serviceTier: expectedServiceTier,
        }),
      });
    },
  );
  it("keeps shared Fast priority on new threads with a configured tier", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.fastMode = true;
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { serviceTier: "ultrafast" } },
    });
    await completeStartedRun(run, harness.waitForMethod, harness.completeTurn, "thread-1");
    for (const method of ["thread/start", "turn/start"]) {
      expect(harness.requests.find((request) => request.method === method)?.params).toMatchObject({
        serviceTier: "priority",
      });
    }
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
    expect(requests.find((request) => request.method === "thread/resume")?.params).toMatchObject({
      serviceTier: null,
    });
    expect(requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      serviceTier: "priority",
    });
  });
  it.each([
    {
      name: "explicit Ultrafast",
      supported: true,
      fastMode: "ultrafast" as const,
      expected: "ultrafast",
      catalogRequests: 1,
    },
    {
      name: "explicit Ultrafast with the switch enabled",
      supported: true,
      fastMode: "ultrafast" as const,
      enableUltrafast: true,
      expected: "ultrafast",
      catalogRequests: 1,
    },
    {
      name: "explicit Ultrafast with the switch disabled",
      supported: true,
      fastMode: "ultrafast" as const,
      enableUltrafast: false,
      expected: "priority",
    },
    {
      name: "unsupported Ultrafast",
      supported: false,
      fastMode: "ultrafast" as const,
      expected: "priority",
      catalogRequests: 1,
    },
    {
      name: "Fast by default",
      supported: true,
      fastMode: true,
      expected: "priority",
    },
    {
      name: "Fast with the Ultrafast switch enabled",
      supported: true,
      fastMode: true,
      enableUltrafast: true,
      expected: "priority",
    },
    {
      name: "Fast with the Ultrafast switch disabled",
      supported: true,
      fastMode: true,
      enableUltrafast: false,
      expected: "priority",
    },
    {
      name: "Fast with unsupported Ultrafast",
      supported: false,
      fastMode: true,
      expected: "priority",
    },
    { name: "Fast off", supported: true, fastMode: false, expected: null },
    { name: "unspecified Fast mode", supported: true, fastMode: undefined, expected: undefined },
    {
      name: "auto activates after resume",
      supported: true,
      fastMode: false,
      activateAuto: true,
      expected: "priority",
    },
    {
      name: "inactive Auto",
      supported: true,
      fastMode: false,
      automatic: true,
      expected: null,
    },
    {
      name: "auto with the Ultrafast switch disabled",
      supported: true,
      fastMode: false,
      activateAuto: true,
      enableUltrafast: false,
      expected: "priority",
    },
    {
      name: "auto with unsupported Ultrafast",
      supported: false,
      fastMode: false,
      activateAuto: true,
      expected: "priority",
    },
  ])(
    "requires explicit Ultrafast for $name at the actual turn boundary",
    async ({
      supported,
      fastMode,
      activateAuto,
      automatic,
      enableUltrafast,
      expected,
      catalogRequests = 0,
    }) => {
      const { sessionFile, workspaceDir } = createRunPaths();
      await writeExistingBinding(sessionFile, workspaceDir, { model: "gpt-5.2" });
      const harness = createResumeHarness("thread-existing", async (method) => {
        if (method === "model/list") {
          return {
            data: [
              {
                id: "catalog-alias",
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
            nextCursor: null,
          };
        }
        return undefined;
      });
      const params = createParams(sessionFile, workspaceDir);
      let active = fastMode;
      params.fastMode = activateAuto || automatic ? () => active : fastMode;
      params.onAgentEvent = (event) => {
        if (
          event.stream === "codex_app_server.lifecycle" &&
          event.data.phase === "thread_ready" &&
          activateAuto
        ) {
          active = true;
        }
      };
      const run = runCodexAppServerAttempt(
        params,
        enableUltrafast === undefined ? {} : { pluginConfig: { appServer: { enableUltrafast } } },
      );
      await completeStartedRun(run, harness.waitForMethod, harness.completeTurn, "thread-existing");
      expect(
        harness.requests.find((request) => request.method === "turn/start")?.params,
      ).toMatchObject({
        serviceTier: expected,
      });
      expect(harness.requests.filter((request) => request.method === "model/list")).toHaveLength(
        catalogRequests,
      );
    },
  );

  it.each([
    {
      name: "unspecified Fast mode",
      fastMode: undefined,
      supported: true,
      baseline: undefined,
      expected: null,
    },
    { name: "Fast off", fastMode: false, supported: true, baseline: undefined, expected: null },
    {
      name: "Fast by default",
      fastMode: true,
      supported: true,
      baseline: undefined,
      expected: "priority",
    },
    {
      name: "revoked Ultrafast",
      fastMode: "ultrafast" as const,
      supported: false,
      baseline: undefined,
      expected: "priority",
    },
    {
      name: "inactive auto",
      fastMode: () => false,
      supported: true,
      baseline: undefined,
      expected: null,
    },
    {
      name: "unsupported priority baseline",
      fastMode: undefined,
      supported: false,
      baseline: "priority" as const,
      expected: "priority",
    },
    {
      name: "unsupported default baseline",
      fastMode: undefined,
      supported: false,
      baseline: undefined,
      expected: null,
    },
    {
      name: "configured Ultrafast without a shared selection",
      fastMode: undefined,
      supported: true,
      baseline: "ultrafast" as const,
      expected: "priority",
    },
  ])(
    "reselects the tier for $name after an explicit Ultrafast warm turn",
    async ({ fastMode, supported, baseline, expected }) => {
      const { sessionFile, workspaceDir } = createRunPaths();
      await writeExistingBinding(sessionFile, workspaceDir, { model: "gpt-5.2" });
      let catalogSupported = true;
      const harness = createResumeHarness("thread-existing", async (method) => {
        if (method === "model/list") {
          return {
            data: [
              {
                id: "catalog-alias",
                model: "gpt-5.4-codex",
                displayName: "Test model",
                description: "Test model",
                hidden: false,
                isDefault: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: "medium",
                serviceTiers: catalogSupported
                  ? [{ id: "ultrafast", name: "Ultrafast", description: "Faster" }]
                  : [],
              },
            ],
          };
        }
        return undefined;
      });
      for (let turn = 0; turn < 2; turn += 1) {
        catalogSupported = turn === 0 || supported;
        const params = createParams(sessionFile, workspaceDir);
        params.fastMode = turn === 0 ? "ultrafast" : fastMode;
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
      expect(harness.requests.filter((request) => request.method === "model/list")).toHaveLength(
        fastMode === "ultrafast" ? 2 : 1,
      );
    },
  );
}
