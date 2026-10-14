import { createDeferredCore } from "../shared/deferred.js";
import { setPreparedModelRuntimeStartupStatus } from "./prepared-model-runtime.startup-status.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeReplacement,
} from "./prepared-model-runtime.types.js";

/** The startup wait is bounded; each published agent still owns complete runtime/auth facts. */
export class PreparedModelRuntimeStartup {
  readonly #foreground = createDeferredCore();
  #stage = "previous generation completion";
  readonly release = this.#foreground.promise;

  constructor(
    private readonly host: {
      replacement: PreparedModelRuntimeReplacement;
      owners: () => Iterable<PreparedModelRuntimeOwner>;
      isCurrent: () => boolean;
      timeoutMs: number;
      publish: (owners: PreparedModelRuntimeOwner[]) => void;
      onDegraded: (publish: () => void) => void;
      warn: (message: string) => void;
    },
  ) {}

  readonly progress = {
    onStage: (stage: string) => {
      this.#stage = stage;
      this.update();
    },
    onPublished: () => this.update(true),
  };

  update(publish = false): void {
    if (!this.host.isCurrent()) {
      return;
    }
    const configured = [...this.host.owners()].filter((owner) => owner.provenance === "configured");
    setPreparedModelRuntimeStartupStatus({
      degraded: this.host.replacement.degraded === true,
      pendingAgents: configured.flatMap((owner) =>
        owner.needsRefresh || !owner.snapshot || owner.pending
          ? [owner.input.agentId ?? owner.input.agentDir]
          : [],
      ),
      stage: this.#stage,
    });
    if (publish && this.host.replacement.degraded) {
      this.host.publish(
        configured.filter((owner) => owner.snapshot && !owner.needsRefresh && !owner.pending),
      );
    }
  }

  complete(): void {
    setPreparedModelRuntimeStartupStatus({ degraded: false, pendingAgents: [] });
  }

  wait(publication: Promise<void>): Promise<void> {
    const timer = setTimeout(() => {
      if (this.host.isCurrent()) {
        this.host.replacement.degraded = true;
        this.host.onDegraded(() => this.update(true));
        this.update(true);
        const pending = [...this.host.owners()].filter(
          (owner) => owner.needsRefresh || !owner.snapshot,
        );
        this.host.warn(
          `prepared model runtime startup degraded after ${this.host.timeoutMs}ms (${this.#stage}); ` +
            `still acquiring agents: ${pending.map((owner) => owner.input.agentId ?? owner.input.agentDir).join(", ")}; acquisition continues in the background`,
        );
        this.host.replacement.resolve();
      }
      this.#foreground.resolve();
    }, this.host.timeoutMs);
    timer.unref?.();
    void publication.catch((error: unknown) => {
      if (this.host.replacement.degraded) {
        this.host.warn(`background model runtime publication failed: ${String(error)}`);
      }
    });
    return Promise.race([publication, this.release]).finally(() => clearTimeout(timer));
  }
}
