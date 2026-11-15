/** Browser-local boundaries; passed intact to Playwright's evaluateHandle. */
export function createEngineActionTiming(trace: boolean) {
  let startMs = 0;
  let firstInputMs: number | undefined;
  let lastInputMs: number | undefined;
  let firstFocusMs: number | undefined;
  let firstCommitMs: number | undefined;
  let lastCommitMs: number | undefined;
  let commitSource: "mutation" | "native-value" | undefined;
  let scenarioEndMs = 0;
  let inputCount = 0;
  let inputSource: "native" | "gateway" | undefined;
  let mutationCount = 0;
  const inputTypes = ["pointerdown", "keydown", "input", "wheel"];
  const eventTypes = [...inputTypes, "pointerup", "click"];
  const activations: Array<{
    type: string;
    startMs: number;
    pointerdownMs?: number;
    pointerupMs?: number;
    clickMs?: number;
    firstCommitMs?: number;
    lastCommitMs?: number;
    firstMutationMs?: number;
    firstMutationAfterClickMs?: number;
    lastMutationMs?: number;
    mutationCount: number;
    commitSource?: "mutation" | "native-value";
  }> = [];
  let active: (typeof activations)[number] | undefined;
  let activationsTruncated = false;
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
    if (event.type === "pointerup") {
      if (active?.type === "pointerdown" && active.clickMs === undefined) {
        active.pointerupMs = now;
      }
      mark("input:pointerup", now);
      return;
    }
    if (
      event.type === "click" &&
      active &&
      (active.type === "pointerdown" || active.type === "keydown") &&
      active.clickMs === undefined
    ) {
      active.clickMs = now;
      mark("input:click", now);
      return;
    }
    active = undefined;
    if (activations.length < 100) {
      active = { type: event.type, startMs: now, mutationCount: 0 };
      if (event.type === "pointerdown") {
        active.pointerdownMs = now;
      } else if (event.type === "click") {
        active.clickMs = now;
      }
      activations.push(active);
    } else {
      activationsTruncated = true;
    }
    // Click/up detail must not change the established input-count boundary.
    if (event.type === "click") {
      mark("input:click", now);
      return;
    }
    firstInputMs ??= now;
    inputSource ??= "native";
    lastInputMs = now;
    inputCount++;
    // Native value edits need not produce MutationObserver records.
    if (event.type === "input") {
      firstCommitMs ??= now;
      lastCommitMs = now;
      commitSource = "native-value";
      if (active) {
        active.firstCommitMs = now;
        active.lastCommitMs = now;
        active.commitSource = "native-value";
      }
    }
    mark(`input:${event.type}`, now);
  };
  const mutations = (records: MutationRecord[]) => {
    if (firstInputMs !== undefined && records.length) {
      const now = performance.now();
      firstCommitMs ??= now;
      lastCommitMs = now;
      commitSource = "mutation";
      mutationCount += records.length;
      if (active) {
        active.firstCommitMs ??= now;
        active.lastCommitMs = now;
        active.firstMutationMs ??= now;
        if (active.clickMs !== undefined) {
          active.firstMutationAfterClickMs ??= now;
        }
        active.lastMutationMs = now;
        active.mutationCount += records.length;
        active.commitSource = "mutation";
      }
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
      window.openclawEngineMarkGatewayInput = () => {
        const now = performance.now();
        firstInputMs ??= now;
        inputSource ??= "gateway";
        lastInputMs = now;
        inputCount++;
        active = undefined;
        mark("input:gateway", now);
      };
      for (const type of eventTypes) {
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
      for (const type of eventTypes) {
        document.removeEventListener(type, input, true);
      }
      document.removeEventListener("focusin", focus, true);
      delete window.openclawEngineMarkGatewayInput;
      mark("run:end", scenarioEndMs);
      if (firstCommitMs !== undefined) {
        mark("commit:first", firstCommitMs);
      }
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
        firstCommitMs,
        lastCommitMs,
        scenarioEndMs,
        endMs,
        inputCount,
        inputSource,
        mutationCount,
        commitSource,
        activations: activations.map((activation) =>
          Object.assign(activation, {
            firstCommitLatencyMs:
              activation.firstCommitMs !== undefined
                ? activation.firstCommitMs - activation.startMs
                : null,
            clickToFirstMutationMs:
              activation.clickMs !== undefined && activation.firstMutationAfterClickMs !== undefined
                ? activation.firstMutationAfterClickMs - activation.clickMs
                : null,
          }),
        ),
        activationsTruncated,
        driverMs: first !== undefined ? first - startMs : null,
        firstCommitLatencyMs:
          first !== undefined && firstCommitMs !== undefined ? firstCommitMs - first : null,
        applicationMs: measured ? commit - first : null,
        settleMs: measured ? endMs - commit : null,
        assertionTailMs: measured ? scenarioEndMs - commit : null,
        browserSpanMs: endMs - startMs,
      };
    },
  };
}

export type EngineActionTiming = ReturnType<ReturnType<typeof createEngineActionTiming>["finish"]>;

declare global {
  interface Window {
    /** Harness-only boundary, called immediately before a deferred Gateway response. */
    openclawEngineMarkGatewayInput?: () => void;
  }
}
