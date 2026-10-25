import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import type { runScenarioFlow as RunScenarioFlow } from "./scenario-flow-runner.js";
import type { runQaSuiteScenarioDefinition as RunScenario } from "./suite-runtime-flow.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import { runQaScenarioWithFlakeRetry } from "./suite-support.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

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
    transport: createQaChannelTransport(createQaBusState()),
    outputDir: "/artifacts",
    repoRoot: "/repo",
    providerMode: "mock-openai",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-mini",
    mock: null,
    cfg: {},
  } satisfies Parameters<typeof RunScenario>[0]["env"];
}

function track<T>(pending: Promise<T>, tracked: Promise<unknown>[]) {
  tracked.push(pending.catch((error: unknown) => error));
  return pending;
}

beforeEach(() => {
  vi.resetModules();
  launch.mockReset();
  runScenarioFlow.mockReset();
});

it("rejects late navigation success, permits finally web use and preserves retry and cleanup ownership", async () => {
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
  first.page.goto.mockImplementationOnce(waitForRelease);
  launch.mockResolvedValueOnce(first.browser).mockImplementation(() => {
    const fixture = makeBrowser();
    fixtures.push(fixture);
    return Promise.resolve(fixture.browser);
  });
  const captures: Parameters<typeof RunScenarioFlow>[0][] = [];
  const openings: Promise<unknown>[] = [];
  runScenarioFlow.mockImplementation((params) => {
    captures.push(params);
    const open = params.api.webOpenPage as ReturnType<typeof web.createQaWebPageOpener>;
    params.api.webOpenPage = (input: Parameters<typeof open>[0]) => track(open(input), openings);
    return actualFlow.runScenarioFlow(params);
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
  const actions = [
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
  ];
  scenario.execution.flow = { steps: [{ name: "Open and clean up", actions }] };
  const runs: Promise<unknown>[] = [];
  const runAttempt = () =>
    track(
      runtime.runQaSuiteScenarioDefinition({
        env,
        scenario,
        constants: {
          imageUnderstandingPngBase64: "small",
          imageUnderstandingLargePngBase64: "large",
          imageUnderstandingValidPngBase64: "valid",
        },
      }),
      runs,
    );

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
    expect(captures[0]?.vars).not.toHaveProperty("normalPage");
    released.resolve();
    const reason = captures[0]?.api.signal?.reason;
    expect(reason).toHaveProperty("message", "QA scenario flow timed out after 30ms");
    await expect(openings[0]).resolves.toMatchObject({ errors: [reason, contextError] });
    expect(captures[0]?.vars).not.toHaveProperty("normalPage");
    expect(captures[0]?.vars).not.toHaveProperty("laterAction");
    expect(captures[0]?.vars?.cleanupSnapshot).toMatchObject({ text: "page body" });
    expect(captures.map(({ api }) => api.signal?.aborted)).toEqual([true, false]);
    expect(captures[1]?.vars?.laterAction).toBe(true);
    await expect(web.closeQaWebSessions(env.webSessionIds)).rejects.toMatchObject({
      errors: [contextError],
    });
    expect(env.webSessionIds.size).toBe(1);
    for (const fixture of fixtures) {
      expect(fixture.context.close).toHaveBeenCalledOnce();
      expect(fixture.browser.close).toHaveBeenCalledOnce();
    }
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    try {
      released.resolve();
      await Promise.allSettled([...runs, ...openings]);
      await expect(web.closeQaWebSessions()).rejects.toMatchObject({ errors: [contextError] });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  }
});
