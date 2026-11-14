// External attribution probe. Never include its samples in timing acceptance.
// Reuses the owner-registration boundary from control-ui-cold-load-probes.ts.
export function installInlineCommandRenderCounters() {
  const owners = new Map();
  const runOwners = new Map();
  const NativeWeakMap = window.WeakMap;
  class RegistrationWeakMap extends NativeWeakMap {
    set(host, owner) {
      super.set(host, owner);
      if (
        owner?.values &&
        owner.fields?.includes("chatToolMessages") &&
        typeof owner.notify === "function" &&
        host?.toolStreamById instanceof Map
      ) {
        runOwners.set(host, owner);
      }
      if (
        host instanceof HTMLElement &&
        host.localName === "openclaw-chat-pane" &&
        owner?.element === host &&
        typeof owner.render === "function"
      ) {
        owners.set(host, owner);
      }
      return this;
    }
  }
  window.WeakMap = RegistrationWeakMap;
  let active = false;
  let observer;
  let priorHook;
  let outputOnly;
  const originals = new Map();
  const runOriginals = new Map();
  const counts = {
    runPublications: 0,
    runAnimationFramesScheduled: 0,
    paneRenderCalls: 0,
    paneInvalidations: 0,
    paneCommits: 0,
    paneDomMutationRecords: 0,
    composerDomMutationRecords: 0,
    commandRowDomMutationRecords: 0,
    previewDomMutationRecords: 0,
  };
  const rows = new Map();
  const record = (records) => {
    for (const mutation of records) {
      counts.paneDomMutationRecords++;
      const element =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      if (element?.closest(".agent-chat__composer-shell")) {
        counts.composerDomMutationRecords++;
      }
      const row = element?.closest(".chat-tool-row");
      if (row) {
        counts.commandRowDomMutationRecords++;
        rows.set(row, (rows.get(row) ?? 0) + 1);
      }
      if (element?.closest(".chat-command-trail__preview")) {
        counts.previewDomMutationRecords++;
      }
    }
  };
  const hook = (host, phase) => {
    if (active && [...owners].some(([element, owner]) => host === element || host === owner)) {
      if (phase === "invalidate") {
        counts.paneInvalidations++;
      }
      if (phase === "commit") {
        counts.paneCommits++;
      }
    }
    if (typeof priorHook?.value === "function") {
      priorHook.value(host, phase);
    }
  };
  window.inlineCommandRenderCounters = {
    start() {
      if (active || owners.size === 0) {
        throw new Error("Expected captured pane owner before counters start");
      }
      // Existing registration maps must stop capturing before the measured work.
      window.WeakMap = NativeWeakMap;
      Object.defineProperty(
        RegistrationWeakMap.prototype,
        "set",
        Object.getOwnPropertyDescriptor(NativeWeakMap.prototype, "set"),
      );
      priorHook = Object.getOwnPropertyDescriptor(window, "openclawRenderLifecycleTestHook");
      const priorCallback = window.openclawRenderLifecycleTestHook;
      priorHook = { descriptor: priorHook, value: priorCallback };
      Object.defineProperty(window, "openclawRenderLifecycleTestHook", {
        configurable: true,
        value: hook,
      });
      for (const [host, owner] of owners) {
        const render = owner.render;
        originals.set(owner, render);
        owner.render = function (...args) {
          if (active && host.isConnected) {
            counts.paneRenderCalls++;
          }
          return render.apply(this, args);
        };
      }
      for (const [state, owner] of runOwners) {
        if (![...owners.values()].some((pane) => pane.state === state)) {
          continue;
        }
        const { notify, publish } = owner;
        runOriginals.set(owner, { notify, publish });
        owner.notify = function (...args) {
          if (active) {
            counts.runPublications++;
          }
          return notify.apply(this, args);
        };
        owner.publish = function (...args) {
          const previousFrame = this.frame;
          const result = publish.apply(this, args);
          if (active && this.frame !== null && this.frame !== previousFrame) {
            counts.runAnimationFramesScheduled++;
          }
          return result;
        };
      }
      if (runOriginals.size !== owners.size) {
        throw new Error("Expected one captured run owner per pane before counters start");
      }
      observer = new MutationObserver(record);
      for (const host of owners.keys()) {
        observer.observe(host, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      }
      active = true;
    },
    beginOutputOnly() {
      record(observer.takeRecords());
      outputOnly = { startAt: performance.now(), before: { ...counts } };
    },
    finish() {
      record(observer.takeRecords());
      observer.disconnect();
      active = false;
      for (const [owner, render] of originals) {
        owner.render = render;
      }
      for (const [owner, methods] of runOriginals) {
        owner.notify = methods.notify;
        owner.publish = methods.publish;
      }
      if (priorHook.descriptor) {
        Object.defineProperty(window, "openclawRenderLifecycleTestHook", priorHook.descriptor);
      } else {
        delete window.openclawRenderLifecycleTestHook;
      }
      return {
        counts,
        rows: [...rows.values()],
        paneOwners: owners.size,
        runOwners: runOriginals.size,
        outputOnly: outputOnly
          ? {
              startAt: outputOnly.startAt,
              endAt: performance.now(),
              counts: Object.fromEntries(
                Object.entries(counts).map(([key, value]) => [key, value - outputOnly.before[key]]),
              ),
            }
          : null,
        interpretation:
          "Pane render calls and explicit lifecycle notifications; row/preview DOM mutation records are not Solid render or binding counts. No snapshot-computation count is available at this boundary.",
        overhead:
          "Traffic-dependent wrappers and MutationObserver callbacks. Attribution only; exclude from CPU, latency, memory acceptance.",
      };
    },
  };
}
