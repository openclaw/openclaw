import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { CodexAppServerRpcError } from "./app-server/rpc-error.js";
import type {
  CodexCatalogListRequest,
  CodexCatalogSourceAttempt,
} from "./session-catalog-list-request.js";
import { CatalogParamsError } from "./session-catalog-parsing.js";

const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

type SourceState = {
  failure?: { error: unknown; delayMs: number; retryAt: number; probing: boolean };
};

/** Source health is separate from query-keyed page sharing and cached page delivery. */
export class CodexCatalogSourceBackoff {
  private readonly sourcesByConfig = new WeakMap<OpenClawConfig, Map<string, SourceState>>();

  constructor(private readonly now: () => number) {}

  begin(
    config: OpenClawConfig,
    agentId: string | undefined,
    sourceHomeId: string | undefined,
    scope?: CodexCatalogListRequest,
  ): CodexCatalogSourceAttempt {
    let sources = this.sourcesByConfig.get(config);
    if (!sources) {
      sources = new Map();
      this.sourcesByConfig.set(config, sources);
    }
    const key = JSON.stringify([agentId, sourceHomeId ?? null]);
    if (scope) {
      return scope.attempt(sources, key, () => this.begin(config, agentId, sourceHomeId));
    }
    let state = sources.get(key);
    if (!state) {
      state = {};
      sources.set(key, state);
    }
    const failure = state.failure;
    if (failure && (failure.probing || failure.retryAt > this.now())) {
      return { allowed: false, error: failure.error };
    }
    if (failure) {
      failure.probing = true;
    }
    return {
      allowed: true,
      resolved: () => {
        if (sources.get(key) === state) {
          // Keep a healthy generation so an older failure cannot reopen the circuit.
          sources.set(key, {});
        }
      },
      rejected: (error) => {
        if (sources.get(key) !== state) {
          return;
        }
        if (
          error instanceof CatalogParamsError ||
          (error instanceof Error && error.name === "AbortError") ||
          (error instanceof CodexAppServerRpcError &&
            (error.code === -32600 || error.code === -32602))
        ) {
          if (failure) {
            failure.probing = false;
          }
          return;
        }
        // Preserve one immediate retry. Only the current generation advances source health.
        const delayMs = failure
          ? Math.min(failure.delayMs * 2 || INITIAL_BACKOFF_MS, MAX_BACKOFF_MS)
          : 0;
        sources.set(key, {
          failure: { error, delayMs, retryAt: this.now() + delayMs, probing: false },
        });
      },
      abandoned: () => {
        if (sources.get(key) === state && failure) {
          failure.probing = false;
        }
      },
    };
  }
}
