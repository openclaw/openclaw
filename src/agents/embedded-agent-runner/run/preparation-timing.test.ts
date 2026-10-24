import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { flushDiagnosticsTimeline } from "../../../infra/diagnostics-timeline.js";
import { createEmbeddedAttemptPreparation as createPreparation } from "./attempt-preparation.js";
import { measureEmbeddedAgentPreparation as measurePreparation } from "./preparation-timing.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  vi.restoreAllMocks();
  flushDiagnosticsTimeline();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

describe("embedded agent preparation", () => {
  it("emits the canonical span name with stage attribution", async () => {
    const timeline = join(tempDirs.make("openclaw-agent-preparation-"), "timeline.jsonl");
    vi.stubEnv("OPENCLAW_DIAGNOSTICS", "timeline");
    vi.stubEnv("OPENCLAW_DIAGNOSTICS_TIMELINE_PATH", timeline);

    await measurePreparation("runtime", async () => "async");
    expect(await measurePreparation("attempt.tool-base", () => "sync")).toBe("sync");

    flushDiagnosticsTimeline();
    const events = (await readFile(timeline, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toMatchObject(
      ["runtime", "runtime", "attempt.tool-base", "attempt.tool-base"].map((stage) => ({
        name: "agent.prepare",
        phase: "agent.prepare",
        attributes: { stage },
      })),
    );
  });
  const prepare = createPreparation({ assertCurrent: () => {} });
  it("amortizes event-loop admission across inexpensive concurrent stages", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    let controlTurns = 0;
    let running = true;
    const control = () => {
      if (running) {
        controlTurns++;
        setImmediate(control);
      }
    };
    setImmediate(control);
    try {
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          for (let stage = 0; stage < 4; stage++) {
            await prepare("attempt.tool-catalog", () => stage);
          }
        }),
      );
      expect(controlTurns).toBeGreaterThan(0);
      expect(controlTurns).toBeLessThanOrEqual(4);
    } finally {
      running = false;
      await yieldToEventLoop();
    }
  });

  it("lets control callbacks advance before a burst of preparation stages finishes", async () => {
    const started: number[] = [];
    let observedStarts = -1;
    const controlCallback = createDeferred();
    await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        prepare("attempt.tool-catalog", () => {
          started.push(index);
          if (index === 0) {
            setImmediate(() => {
              observedStarts = started.length;
              controlCallback.resolve();
            });
          }
        }),
      ),
    );
    await controlCallback.promise;
    expect(started).toEqual(Array.from({ length: 32 }, (_, index) => index));
    expect(observedStarts).toBeGreaterThan(0);
    expect(observedStarts).toBeLessThanOrEqual(16);
  });

  it("yields after expensive synchronous work before admitting the next stage", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const events: string[] = [];
    await Promise.all([
      prepare("attempt.bootstrap", () => {
        events.push("expensive");
        elapsed += 10;
        setImmediate(() => events.push("control"));
      }),
      prepare("attempt.tool-catalog", () => events.push("next")),
    ]);
    expect(events).toEqual(["expensive", "control", "next"]);
  });

  it("preserves caller context and overlaps asynchronous preparation", async () => {
    const context = new AsyncLocalStorage<string>();
    const observed: Array<string | undefined> = [];
    const firstWait = createDeferred();
    const first = context.run("first", () =>
      prepare("attempt.bootstrap", async () => {
        observed.push(context.getStore());
        await firstWait.promise;
        observed.push(context.getStore());
      }),
    );
    const second = context.run("second", () =>
      prepare("attempt.bootstrap", async () => {
        observed.push(context.getStore());
        await yieldToEventLoop();
        firstWait.resolve();
      }),
    );
    await Promise.all([first, second]);
    expect(observed).toEqual(["first", "second", "first"]);
  });

  it("rejects stale queued work before acquisition without blocking other attempts", async () => {
    const controller = new AbortController();
    const cancelled = createPreparation({
      assertCurrent: () => controller.signal.throwIfAborted(),
    });
    const acquire = vi.fn();
    const pending = cancelled("attempt.bundle-tools", acquire);
    const failure = new Error("cancelled before acquisition");
    controller.abort(failure);
    await expect(pending).rejects.toBe(failure);
    expect(acquire).not.toHaveBeenCalled();
    await expect(prepare("attempt.tool-catalog", () => 1)).resolves.toBe(1);
    await expect(
      prepare("attempt.tool-catalog", () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(prepare("attempt.tool-catalog", () => 2)).resolves.toBe(2);
  });
});
