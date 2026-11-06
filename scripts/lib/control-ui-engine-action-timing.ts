/** Browser-local boundaries; passed intact to Playwright's evaluateHandle. */
export function createEngineActionTiming(trace: boolean) {
  let startMs = 0;
  let firstInputMs: number | undefined;
  let lastInputMs: number | undefined;
  let firstFocusMs: number | undefined;
  let lastCommitMs: number | undefined;
  let commitSource: "mutation" | "native-value" | undefined;
  let scenarioEndMs = 0;
  let inputCount = 0;
  let mutationCount = 0;
  const inputTypes = ["pointerdown", "keydown", "input", "wheel"];
  const mark = (name: string, startTime: number) => {
    if (trace) {
      performance.mark(`engine:${name}`, { startTime });
    }
  };
  const input = (event: Event) => {
    if (!event.isTrusted) {
      return;
    }
    const now = performance.now();
    firstInputMs ??= now;
    lastInputMs = now;
    inputCount++;
    // Native value edits need not produce MutationObserver records.
    if (event.type === "input") {
      lastCommitMs = now;
      commitSource = "native-value";
    }
    mark(`input:${event.type}`, now);
  };
  const mutations = (records: MutationRecord[]) => {
    if (firstInputMs !== undefined && records.length) {
      lastCommitMs = performance.now();
      commitSource = "mutation";
      mutationCount += records.length;
    }
  };
  const observer = new MutationObserver(mutations);
  const focus = () => {
    firstFocusMs ??= performance.now();
    mark("input:focusin", performance.now());
  };
  return {
    start() {
      startMs = performance.now();
      mark("run:start", startMs);
      for (const type of inputTypes) {
        document.addEventListener(type, input, true);
      }
      document.addEventListener("focusin", focus, true);
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      return performance.timeOrigin;
    },
    endScenario() {
      mutations(observer.takeRecords());
      scenarioEndMs = performance.now();
      observer.disconnect();
      for (const type of inputTypes) {
        document.removeEventListener(type, input, true);
      }
      document.removeEventListener("focusin", focus, true);
      mark("run:end", scenarioEndMs);
      if (lastCommitMs !== undefined) {
        mark("commit:last", lastCommitMs);
      }
    },
    finish() {
      const endMs = performance.now();
      const first = firstInputMs;
      const commit = lastCommitMs;
      const measured = first !== undefined && commit !== undefined;
      return {
        startMs,
        firstFocusMs,
        firstInputMs,
        lastInputMs,
        lastCommitMs,
        scenarioEndMs,
        endMs,
        inputCount,
        mutationCount,
        commitSource,
        driverMs: first !== undefined ? first - startMs : null,
        applicationMs: measured ? commit - first : null,
        settleMs: measured ? endMs - commit : null,
        assertionTailMs: measured ? scenarioEndMs - commit : null,
        browserSpanMs: endMs - startMs,
      };
    },
  };
}

export type EngineActionTiming = ReturnType<ReturnType<typeof createEngineActionTiming>["finish"]>;
