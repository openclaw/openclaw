import { parseModelRef } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { runScenarioFlow as RunScenarioFlow } from "./scenario-flow-runner.js";
import type { runQaSuiteScenarioDefinition as RunScenario } from "./suite-runtime-flow.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import { runQaScenarioWithFlakeRetry } from "./suite-support.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import { runQaSuiteCleanupSteps } from "./suite.js";

const launch = vi.hoisted(() => vi.fn());
const runScenarioFlow = vi.hoisted(() => vi.fn<typeof RunScenarioFlow>());

vi.mock("playwright-core", () => ({ chromium: { launch } }));
vi.mock("./scenario-flow-runner.js", () => ({ runScenarioFlow }));

function makeBrowser() {
  const page = {
    on: vi.fn(),
    goto: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    title: vi.fn(async () => "QA"),
    url: vi.fn(() => "http://127.0.0.1:3000/chat"),
    locator: vi.fn(() => ({
      waitFor: vi.fn(async () => undefined),
      textContent: vi.fn(async () => "page body"),
    })),
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  return { page, context, browser };
}

function makeEnv() {
  return {
    lab: {},
    webSessionIds: new Set<string>(),
    gateway: {} as QaSuiteRuntimeEnv["gateway"],
    transport: {
      id: "qa-channel",
      label: "QA Channel",
      accountId: "qa-channel",
      waitReady: vi.fn(),
      createGatewayConfig: vi.fn(),
      buildAgentDelivery: vi.fn(),
      requiredPluginIds: [],
      supportedActions: [],
      handleAction: vi.fn(),
      createReportNotes: vi.fn(),
      reset: vi.fn(),
      sendInbound: vi.fn(),
      sendNativeCommand: vi.fn(),
      waitForNoOutbound: vi.fn(),
      waitForOutbound: vi.fn(),
      waitForOutboundSequence: vi.fn(),
      state: createQaBusState(),
      waitForCondition: vi.fn(),
    },
    outputDir: "/artifacts",
    repoRoot: "/repo",
    providerMode: "mock-openai",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-mini",
    mock: null,
    cfg: {},
  } satisfies Parameters<typeof RunScenario>[0]["env"];
}

beforeEach(() => {
  vi.resetModules();
  launch.mockReset();
  runScenarioFlow.mockReset();
});

describe("QA web acquisition across the real scenario DSL", () => {
  it.each(["navigation", "title"] as const)(
    "rejects late %s success, permits finally web use and preserves retry and cleanup ownership",
    async (phase) => {
      const web = await import("./web-runtime.js");
      const runtime = await import("./suite-runtime-flow.js");
      const actualFlow = await vi.importActual<typeof import("./scenario-flow-runner.js")>(
        "./scenario-flow-runner.js",
      );
      const env = makeEnv();
      const first = makeBrowser();
      const fixtures = [first];
      const started = createDeferred<void>();
      const released = createDeferred<void>();
      const contextError = new Error("first context cleanup failed");
      first.context.close.mockRejectedValueOnce(contextError);
      const waitForRelease = async () => {
        started.resolve();
        await released.promise;
      };
      if (phase === "navigation") {
        first.page.goto.mockImplementationOnce(waitForRelease);
      } else {
        first.page.title.mockImplementationOnce(async () => {
          await waitForRelease();
          return "late title";
        });
      }
      launch.mockResolvedValueOnce(first.browser).mockImplementation(() => {
        const fixture = makeBrowser();
        fixtures.push(fixture);
        return Promise.resolve(fixture.browser);
      });
      const captures: Parameters<typeof RunScenarioFlow>[0][] = [];
      const rawSteps: Promise<unknown>[] = [];
      const openings: Promise<unknown>[] = [];
      const fulfilled = vi.fn();
      runScenarioFlow.mockImplementation((params) => {
        captures.push(params);
        const runSteps = params.api.runScenario;
        const open = params.api.webOpenPage as typeof web.qaWebOpenPage;
        return actualFlow.runScenarioFlow({
          ...params,
          api: {
            ...params.api,
            webOpenPage: (input: Parameters<typeof open>[0]) => {
              const opening = open(input).then((page) => {
                fulfilled(params, page);
                return page;
              });
              openings.push(opening.catch((error: unknown) => error));
              return opening;
            },
            runScenario: (name, steps) =>
              runSteps(
                name,
                steps.map((step) => ({
                  ...step,
                  run: () => {
                    const pending = step.run();
                    rawSteps.push(pending.catch((error: unknown) => error));
                    return pending;
                  },
                })),
              ),
          },
        });
      });
      const scenario = makeQaSuiteTestScenario("web-deadline-ownership", { config: {} });
      if (scenario.execution.kind !== "flow") {
        throw new Error("expected flow scenario");
      }
      scenario.execution.timeoutMs = 30;
      const openAction = (saveAs: string) => ({
        call: "webOpenPage",
        args: [{ url: first.page.url(), channel: "chrome" }],
        saveAs,
      });
      scenario.execution.flow = {
        steps: [
          {
            name: "Open and clean up",
            actions: [
              {
                try: {
                  actions: [openAction("normalPage")],
                  finally: [
                    openAction("cleanupPage"),
                    {
                      call: "webSnapshot",
                      args: [{ pageId: { ref: "cleanupPage.pageId" } }],
                      saveAs: "cleanupSnapshot",
                    },
                  ],
                },
              },
              { set: "laterAction", value: true },
            ],
          },
        ],
      };
      const runs: Promise<unknown>[] = [];
      const runAttempt = (nextScenario = scenario) => {
        const run = runtime.runQaSuiteScenarioDefinition({
          env,
          scenario: nextScenario,
          runScenario: runtime.runQaSuiteScenarioSteps,
          splitModelRef: (raw) => parseModelRef(raw, "openai"),
          formatErrorMessage: String,
          liveTurnTimeoutMs: () => 60_000,
          resolveQaLiveTurnTimeoutMs: () => 60_000,
          constants: {
            imageUnderstandingPngBase64: "small",
            imageUnderstandingLargePngBase64: "large",
            imageUnderstandingValidPngBase64: "valid",
          },
        });
        runs.push(run);
        return run;
      };

      vi.useFakeTimers();
      try {
        const retried = runQaScenarioWithFlakeRetry(() => runAttempt());
        runs.push(retried);
        await Promise.race([
          started.promise,
          retried.then(() => {
            throw new Error("flow settled before the held acquisition started");
          }),
        ]);
        await vi.advanceTimersByTimeAsync(5_030);
        expect(await retried).toMatchObject({
          status: "pass",
          details: expect.stringContaining(
            "passed on retry; first attempt: QA scenario flow timed out after 30ms",
          ),
        });
        expect(first.context.close).toHaveBeenCalledOnce();
        expect(first.browser.close).toHaveBeenCalledOnce();
        expect(captures[0]?.vars).not.toHaveProperty("normalPage");
        released.resolve();
        const reason = captures[0]?.api.signal?.reason;
        expect(reason).toBeInstanceOf(Error);
        expect(reason).toHaveProperty("message", "QA scenario flow timed out after 30ms");
        await expect(rawSteps[0]).resolves.toBe(reason);
        const failedOpen = await openings[0];
        expect(failedOpen).toBeInstanceOf(AggregateError);
        if (!(failedOpen instanceof AggregateError)) {
          throw failedOpen;
        }
        expect(failedOpen.cause).toBe(reason);
        expect(failedOpen.errors[0]).toBe(reason);
        expect(failedOpen.errors[1]).toBe(contextError);
        expect(fulfilled.mock.calls.some(([params]) => params === captures[0])).toBe(false);
        expect(captures[0]?.vars).not.toHaveProperty("normalPage");
        expect(captures[0]?.vars).not.toHaveProperty("laterAction");
        expect(captures[0]?.vars?.cleanupSnapshot).toMatchObject({ text: "page body" });
        const cleanupPage = captures[0]?.vars?.cleanupPage as { pageId: string };
        expect(env.webSessionIds.has(cleanupPage.pageId)).toBe(true);
        await expect(web.qaWebSnapshot(cleanupPage)).resolves.toMatchObject({ text: "page body" });
        expect(
          (await runAttempt({ ...scenario, id: "later-web", title: "Later web" })).status,
        ).toBe("pass");
        expect(captures.map(({ api }) => api.signal?.aborted)).toEqual([true, false, false]);
        expect(captures[1]?.vars).toHaveProperty("laterAction", true);
        expect(captures[2]?.vars).toHaveProperty("laterAction", true);
        const finishTransport = vi.fn(async () => undefined);
        const stopGateway = vi.fn(async () => undefined);
        const failures = await runQaSuiteCleanupSteps([
          { phase: "web sessions", run: () => web.closeQaWebSessions(env.webSessionIds) },
          { phase: "transport", run: finishTransport },
          { phase: "gateway", run: stopGateway },
        ]);
        expect(failures).toHaveLength(1);
        expect(failures[0]?.phase).toBe("web sessions");
        const cleanupError = failures[0]?.error;
        expect(cleanupError).toBeInstanceOf(AggregateError);
        if (!(cleanupError instanceof AggregateError)) {
          throw cleanupError;
        }
        expect(cleanupError.errors).toHaveLength(1);
        expect(cleanupError.errors[0]).toBe(contextError);
        expect(env.webSessionIds.size).toBe(1);
        expect(finishTransport).toHaveBeenCalledOnce();
        expect(stopGateway).toHaveBeenCalledOnce();
        for (const fixture of fixtures) {
          expect(fixture.context.close).toHaveBeenCalledOnce();
          expect(fixture.browser.close).toHaveBeenCalledOnce();
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        try {
          released.resolve();
          await Promise.allSettled([...runs, ...rawSteps, ...openings]);
          await expect(web.closeQaWebSessions()).rejects.toMatchObject({ errors: [contextError] });
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      }
    },
  );
});
