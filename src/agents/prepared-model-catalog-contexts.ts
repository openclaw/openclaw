import { materializeErrorStack, throwIfSettledRejected } from "../infra/error-graph-internal.js";
import { hasRetainedPluginRuntimeCloseError } from "../plugins/runtime-close-error.js";
import type { PreparedModelCatalogWorkerTask } from "./prepared-model-catalog-worker.types.js";

const RETIREMENT_PREFIX = "openclaw:catalog-agent-retirement:";

/** Both fields are normalized once by the parent lifecycle owner. */
export function preparedCatalogOwnerKey(agentId: string, agentDir: string): string {
  return JSON.stringify([agentId, agentDir]);
}

export function encodePreparedCatalogRetirement(owners: readonly string[]): string {
  return RETIREMENT_PREFIX + JSON.stringify(owners);
}

export function decodePreparedCatalogRetirement(key?: string): readonly string[] | undefined {
  if (!key?.startsWith(RETIREMENT_PREFIX)) {
    return undefined;
  }
  const owners: unknown = JSON.parse(key.slice(RETIREMENT_PREFIX.length));
  if (!Array.isArray(owners) || !owners.every((owner) => typeof owner === "string")) {
    throw new Error("Invalid catalog retirement owners");
  }
  return owners;
}

type Generation = { release(): void | Promise<void> };
type ContextIdentity = PreparedModelCatalogWorkerTask["context"];
type CatalogContext<T> = ContextIdentity & {
  prepared: T;
  owners: Set<string>;
  unknownOwner: boolean;
};
type Admission<T> = {
  identity: ContextIdentity;
  owner: string | undefined;
  previous: CatalogContext<T> | undefined;
  touched: Set<CatalogContext<T>>;
  retired: boolean;
  settled?: PromiseWithResolvers<void>;
};

/** One serial catalog task may overlap authoritative agent-retirement notifications. */
export class PreparedCatalogContexts<T extends Generation> {
  private readonly contexts = new Map<string | undefined, CatalogContext<T>>();
  private active?: Admission<T>;
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly cleanupFailures = new Map<string, unknown>();
  private readonly releasing = new Set<{ owners: Set<string>; completion: Promise<void> }>();

  get(workspaceDir: string | undefined) {
    return this.contexts.get(workspaceDir);
  }

  values() {
    return this.contexts.values();
  }

  begin(identity: ContextIdentity, owner: string | undefined): Admission<T> {
    const previous = this.get(identity.workspaceDir);
    if (previous) {
      if (owner === undefined) {
        previous.unknownOwner = true;
      } else {
        previous.owners.add(owner);
      }
    }
    return (this.active = {
      identity,
      owner,
      previous,
      touched: new Set(previous ? [previous] : []),
      retired: false,
    });
  }

  assertCurrent(admission: Admission<T>): void {
    if (admission.retired) {
      throw new Error("Prepared model catalog owner retired during discovery");
    }
  }

  publish(admission: Admission<T>, prepared: T): void {
    this.assertCurrent(admission);
    const previous = admission.previous;
    const next = {
      ...admission.identity,
      prepared,
      owners: previous?.owners ?? new Set(admission.owner === undefined ? [] : [admission.owner]),
      unknownOwner: previous?.unknownOwner ?? admission.owner === undefined,
    };
    this.contexts.set(admission.identity.workspaceDir, next);
    admission.touched.add(next);
  }

  invalidate(admission: Admission<T>): void {
    if (this.get(admission.identity.workspaceDir) === admission.previous) {
      this.contexts.delete(admission.identity.workspaceDir);
    }
  }

  recordCleanupFailure(owner: string | undefined, error: unknown): void {
    // Plugin lifetimes keep native prerequisites after a retained close failure.
    // Keep the first failure visible to deletion until this physical worker exits.
    if (
      owner !== undefined &&
      !this.cleanupFailures.has(owner) &&
      hasRetainedPluginRuntimeCloseError(error)
    ) {
      materializeErrorStack(error);
      this.cleanupFailures.set(owner, error);
    }
  }

  releaseGeneration(
    owner: string | undefined,
    generation: T,
    release = () => generation.release(),
  ): Promise<void> {
    const previous = this.active?.previous;
    return this.releaseForOwners(
      owner,
      previous?.prepared === generation ? previous.owners : undefined,
      release,
    );
  }

  private async releaseForOwners(
    owner: string | undefined,
    publishedOwners: ReadonlySet<string> | undefined,
    release: () => void | Promise<void>,
  ): Promise<void> {
    // The successor's owner set can change during cleanup. Record each generation's own
    // receipt before an enclosing release can hide its retained failure.
    const owners = new Set(publishedOwners);
    if (owner !== undefined) {
      owners.add(owner);
    }
    const completion = (async () => await release())();
    const pending = { owners, completion };
    this.releasing.add(pending);
    try {
      await completion;
    } catch (error) {
      for (const owner of owners) {
        this.recordCleanupFailure(owner, error);
      }
      throw error;
    } finally {
      this.releasing.delete(pending);
    }
  }

  async retire(owners: readonly string[]): Promise<void> {
    const results = await Promise.allSettled(
      owners.map((owner) => {
        const pending = this.retiring.get(owner);
        if (pending) {
          return pending;
        }
        const retirement = this.retireOwner(owner)
          .catch((error: unknown) => {
            this.recordCleanupFailure(owner, error);
            throw error;
          })
          .finally(() => this.retiring.delete(owner));
        this.retiring.set(owner, retirement);
        return retirement;
      }),
    );
    throwIfSettledRejected(results, "Catalog retirement failed");
  }

  private async retireOwner(owner: string): Promise<void> {
    const active = this.active;
    if (active?.owner === owner) {
      active.retired = true;
    }
    const releases: Promise<void>[] = [];
    let joinsActive = active?.owner === owner;
    for (const [workspace, context] of this.contexts) {
      context.owners.delete(owner);
      if (context.owners.size || context.unknownOwner) {
        continue;
      }
      this.contexts.delete(workspace);
      if (active?.touched.has(context)) {
        joinsActive = true;
      } else {
        releases.push(Promise.resolve().then(() => context.prepared.release()));
      }
    }
    // Never wait for an unrelated workspace's task. A targeted task releases its
    // detached generations in finally; the resource receipt joins that exact cleanup.
    if (joinsActive && active) {
      releases.push((active.settled ??= Promise.withResolvers<void>()).promise);
    } else {
      for (const pending of this.releasing) {
        if (pending.owners.has(owner)) {
          releases.push(pending.completion);
        }
      }
    }
    throwIfSettledRejected(await Promise.allSettled(releases), "Catalog retirement failed");
    if (this.cleanupFailures.has(owner)) {
      throw this.cleanupFailures.get(owner);
    }
  }

  async finish(admission: Admission<T>): Promise<void> {
    try {
      const results: PromiseSettledResult<void>[] = [];
      // A retirement can detach the successor while its predecessor releases.
      // Claim each detached generation once, then drain again before settling.
      for (;;) {
        const detached = [...admission.touched].filter(
          (context) => this.get(context.workspaceDir) !== context,
        );
        if (!detached.length) {
          break;
        }
        for (const context of detached) {
          admission.touched.delete(context);
        }
        results.push(
          ...(await Promise.allSettled(
            // Scope growth mutates release; read it only after admitted work drains.
            detached.map((context) =>
              this.releaseForOwners(admission.owner, context.owners, () =>
                context.prepared.release(),
              ),
            ),
          )),
        );
      }
      throwIfSettledRejected(results, "Catalog cleanup failed");
      admission.settled?.resolve();
    } catch (error) {
      this.recordCleanupFailure(admission.owner, error);
      admission.settled?.reject(error);
      throw error;
    } finally {
      admission.previous = undefined;
      admission.touched.clear();
      this.active = undefined;
    }
  }
}
