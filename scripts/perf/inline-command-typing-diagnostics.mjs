// Opt-in attribution for the existing workload, never a production input hook.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

export async function createTypingDiagnostics(page, composer, keyboardInput = false) {
  const clockProbes = [];
  const probeClock = async (phase) => {
    for (let probe = 0; probe < 3; probe++) {
      const sentAt = performance.now();
      const browserAt = await page.evaluate(() => performance.now());
      const receivedAt = performance.now();
      // Host-minus-browser offset lies within these bounds; never subtract the
      // two clocks directly or claim one-way dispatch latency from a midpoint.
      clockProbes.push({ phase, sentAt, browserAt, receivedAt });
    }
  };
  await composer.evaluate((target) => {
    if (document.activeElement !== target) {
      throw new Error("Expected the composer to retain keyboard focus");
    }
    const state = {
      events: [],
      inputs: [],
      eventTimings: [],
      eventTimingSupported: PerformanceObserver.supportedEntryTypes.includes("event"),
      eventTimingThresholdMs: 16,
    };
    window.inlineTypingDiagnostics = state;
    for (const type of ["keydown", "keypress", "beforeinput", "input", "keyup"]) {
      for (const capture of [true, false]) {
        document.addEventListener(
          type,
          (event) => {
            if (event.target !== target) {
              return;
            }
            const at = performance.now();
            if (type === "keydown" && capture) {
              state.checkpoint = state.inputs.length;
            }
            state.events.push({
              checkpoint: state.checkpoint,
              type,
              capture,
              at,
              timeStamp: event.timeStamp,
              isTrusted: event.isTrusted,
              focused: document.activeElement === target,
            });
            if (type === "input" && capture) {
              const checkpoint = state.inputs.length;
              const input = { checkpoint, inputAt: at, valueLength: target.value.length };
              state.inputs.push(input);
              performance.mark(`typing-${checkpoint}-input`);
              queueMicrotask(() => {
                input.microtaskAt = performance.now();
              });
              requestAnimationFrame(() => {
                input.firstFrameAt = performance.now();
                requestAnimationFrame(() => {
                  input.secondFrameAt = performance.now();
                });
              });
            }
          },
          capture,
        );
      }
    }
    state.recordEvents = (entries) => {
      for (const entry of entries) {
        if (entry.target !== target) {
          continue;
        }
        state.eventTimings.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          processingStart: entry.processingStart,
          processingEnd: entry.processingEnd,
          interactionId: entry.interactionId,
        });
      }
    };
    if (state.eventTimingSupported) {
      state.observer = new PerformanceObserver((list) => state.recordEvents(list.getEntries()));
      state.observer.observe({ type: "event", durationThreshold: 16 });
    }
  });
  await probeClock("before");
  const phases = [];
  return {
    async measure(index, expectedLength) {
      const start = performance.now();
      if (keyboardInput) {
        await page.keyboard.press("a");
      } else {
        await composer.press("a");
      }
      const pressedAt = performance.now();
      const frameWait = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const enteredAt = performance.now();
            requestAnimationFrame(() => {
              const firstAt = performance.now();
              requestAnimationFrame(() =>
                resolve({ enteredAt, firstAt, secondAt: performance.now() }),
              );
            });
          }),
      );
      const framedAt = performance.now();
      assert.equal((await composer.inputValue()).length, expectedLength);
      const readAt = performance.now();
      const wallMs = readAt - start;
      phases.push({
        checkpoint: phases.length,
        index,
        start,
        pressedAt,
        framedAt,
        readAt,
        wallMs,
        pressMs: pressedAt - start,
        frameRoundTripMs: framedAt - pressedAt,
        readbackMs: readAt - framedAt,
        browserFrameWaitMs: frameWait.secondAt - frameWait.enteredAt,
        frameWait,
      });
      return wallMs;
    },
    async finish() {
      await probeClock("after");
      const browser = await page.evaluate(() => {
        const state = window.inlineTypingDiagnostics;
        if (state.observer) {
          state.recordEvents(state.observer.takeRecords());
          state.observer.disconnect();
        }
        return {
          events: state.events,
          inputs: state.inputs,
          eventTimings: state.eventTimings,
          eventTimingSupported: state.eventTimingSupported,
          eventTimingThresholdMs: state.eventTimingThresholdMs,
          eventTimingInterpretation:
            "16 ms reporting floor, 8 ms quantization, asynchronous delivery; missing entries are not zero-duration interactions. Synthetic browser input timestamps exclude hardware and OS input queues. Input-to-rAF measures a frame opportunity, not painted pixels or INP.",
        };
      });
      assert.equal(browser.inputs.length, phases.length, "one browser input per checkpoint");
      for (const type of ["keydown", "keyup"]) {
        assert.equal(
          browser.events.filter((e) => e.type === type && e.capture).length,
          phases.length,
        );
      }
      assert(
        browser.events.every((event) => event.focused),
        "composer retains input focus",
      );
      for (let checkpoint = 0; checkpoint < phases.length; checkpoint++) {
        assert.equal(browser.inputs[checkpoint].valueLength, checkpoint + 1);
        assert(Number.isFinite(browser.inputs[checkpoint].secondFrameAt));
      }
      return { inputMode: keyboardInput ? "keyboard" : "locator", phases, clockProbes, ...browser };
    },
  };
}
