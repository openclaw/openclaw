import { AsyncContext } from "../shared/async-context.js";

/** Why a run's plugin runtime is being refreshed: its own plugins tool, or a reload from outside. */
export type PluginRuntimeRefreshSource = "tool" | "reload";

type Refresh = {
  active: boolean;
  holds: number;
  consumer?: () => boolean;
  requested: boolean;
  source?: PluginRuntimeRefreshSource;
  // A reload-sourced request stays wanted only while its reload is still pending.
  stillWanted?: () => boolean;
  // Set when an attempt actually stopped before another model request for this refresh.
  stopped?: boolean;
};

const refreshScope = new AsyncContext<Refresh>(Symbol.for("openclaw.agentPluginRuntimeRefresh"));

/** Captured host control survives plugin callbacks without becoming run authority. */
export function captureAgentPluginRuntimeRefresh() {
  const owner = refreshScope.getStore();
  return {
    bindConsumer: (isCurrent: () => boolean) => {
      if (owner?.active) {
        owner.consumer = isCurrent;
      }
    },
    request: (
      source: PluginRuntimeRefreshSource = "tool",
      stillWanted?: () => boolean,
    ): boolean => {
      if (!owner?.active || owner.consumer?.() !== true) {
        return false;
      }
      owner.requested = true;
      // The run's own tool request wins: the continuation should verify that change.
      owner.source = owner.source === "tool" ? "tool" : source;
      owner.stillWanted = owner.source === "tool" ? undefined : stillWanted;
      return true;
    },
    /**
     * The step boundary: stop before another model request when a refresh is
     * pending. A reload that was cancelled or rolled back since its request is
     * dropped here instead of stopping the turn.
     */
    stopAtStep: (): boolean => {
      if (!owner?.active || !owner.requested || owner.holds !== 0) {
        return false;
      }
      if (owner.stillWanted && !owner.stillWanted()) {
        owner.requested = false;
        owner.source = undefined;
        owner.stillWanted = undefined;
        return false;
      }
      owner.stopped = true;
      return true;
    },
    /**
     * Whether the finished attempt hands its turn to a refresh continuation. A
     * reload can arrive during the final model step, so a reload-sourced refresh
     * continues only if the attempt actually stopped at a step boundary.
     */
    continuesAfterAttempt: (): boolean =>
      owner?.active === true &&
      owner.requested &&
      owner.holds === 0 &&
      (owner.source === "tool" || owner.stopped === true),
    /** Why the pending refresh was requested, while the run still owns it. */
    requestSource: () => (owner?.active ? owner.source : undefined),
    isRequested: () => owner?.active === true && owner.requested,
    /** True when captured inside an active run's refresh scope. */
    isOwned: () => owner?.active === true,
    isPending: () => owner?.active === true && owner.requested && owner.holds === 0,
    hold: () => {
      if (!owner?.active) {
        return () => {};
      }
      owner.holds += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          owner.holds -= 1;
        }
      };
    },
    assertActive: () => {
      if (owner && !owner.active) {
        throw new Error("Plugin runtime changed. Continue with the refreshed tool catalog.");
      }
    },
    /**
     * Rejects calls once the run's own plugins tool changed the runtime. A reload's
     * handover request does not: the reloading plugin keeps serving this generation
     * until the turn reaches its step boundary, so admitted steps finish first.
     */
    assertCurrent: () => {
      if (owner && (!owner.active || (owner.requested && owner.source === "tool"))) {
        throw new Error(
          "Plugin runtime changed. Continue with the refreshed tool catalog; do not repeat completed actions.",
        );
      }
    },
  };
}

/** One visible run owns refresh requests across all of its prepared runtime generations. */
export function createAgentPluginRuntimeRefresh() {
  let owner: Refresh | undefined;
  const close = () => {
    if (owner) {
      owner.active = false;
      owner.consumer = undefined;
      owner.requested = false;
      owner.source = undefined;
      owner.stillWanted = undefined;
      owner.stopped = undefined;
    }
  };
  return {
    run: <T>(run: () => T): T => {
      close();
      owner = { active: true, holds: 0, requested: false };
      return refreshScope.run(owner, run);
    },
    close,
  };
}
