import { AsyncContext } from "../shared/async-context.js";

/** Why a run's plugin runtime is being refreshed: its own plugins tool, or a reload from outside. */
export type PluginRuntimeRefreshSource = "tool" | "reload";

type Refresh = {
  active: boolean;
  holds: number;
  consumer?: () => boolean;
  requested: boolean;
  source?: PluginRuntimeRefreshSource;
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
    request: (source: PluginRuntimeRefreshSource = "tool"): boolean => {
      if (!owner?.active || owner.consumer?.() !== true) {
        return false;
      }
      owner.requested = true;
      // The run's own tool request wins: the continuation should verify that change.
      owner.source = owner.source === "tool" ? "tool" : source;
      return true;
    },
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
    assertCurrent: () => {
      if (owner && (!owner.active || owner.requested)) {
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
