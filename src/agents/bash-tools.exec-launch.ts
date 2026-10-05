import type { SpawnInitiation } from "../process/spawn-initiation.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

export class ExecProcessPreflightError extends Error {
  constructor(readonly result: AgentToolResult<ExecToolDetails>) {
    super("exec denied by final preflight");
  }

  static unwrap(error: unknown): AgentToolResult<ExecToolDetails> {
    if (error instanceof ExecProcessPreflightError) {
      return error.result;
    }
    throw error;
  }
}

/** Retain launch custody separately from process lifetime and proven-no-initiation fallback. */
export function createExecLaunchLifecycle(
  initialInitiation?: SpawnInitiation,
  initialRelease?: (reason?: "retry") => void,
) {
  let initiateSpawn = initialInitiation;
  let releaseSpawn = initialRelease;
  let initiated = false;
  const release = (reason?: "retry") => releaseSpawn?.(reason);
  return {
    get initiated() {
      return initiated;
    },
    release,
    async prepare(
      assertSource: (() => void) | undefined,
      beforeSpawn: (() => Promise<AgentToolResult<ExecToolDetails> | undefined>) | undefined,
    ) {
      assertSource?.();
      const denied = await beforeSpawn?.();
      assertSource?.();
      if (denied) {
        throw new ExecProcessPreflightError(denied);
      }
    },
    dispose() {
      release();
      releaseSpawn = undefined;
      initiateSpawn = undefined;
    },
    wrap(assertCurrent: () => void, assertPolicy?: () => void): SpawnInitiation {
      return (launch, settlement) => {
        assertCurrent();
        assertPolicy?.();
        const initiate = () => {
          initiated = true;
          return launch();
        };
        try {
          return initiateSpawn ? initiateSpawn(initiate, settlement) : initiate();
        } finally {
          if (!settlement) {
            release();
          }
        }
      };
    },
  };
}
