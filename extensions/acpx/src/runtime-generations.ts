/** Runtime generations and physical-record cleanup custody for ACPX resets. */
import type { AcpxRuntime as BaseAcpxRuntime } from "acpx/runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { AcpRuntimeError } from "../runtime-api.js";
import type { AcpxGeneration, ResetAwareSessionStore } from "./runtime-session-store.js";

export class AcpxGenerationRegistry {
  private readonly generations = new Map<string, AcpxGeneration>();
  // The shared runtime can still hold a retired owner. Retain only resource
  // isolation after ordinary close, not a private runtime or full record.
  private readonly isolatedSessionResources = new Set<string>();
  private readonly privateDelegates = new Set<BaseAcpxRuntime>();
  private readonly retiringDelegates = new WeakSet<BaseAcpxRuntime>();
  private nextGenerationId = 0;
  private readonly generationOwner = Symbol("acpx-runtime-owner");
  private stopping = false;

  constructor(
    private readonly sessionStore: Pick<ResetAwareSessionStore, "isFresh" | "markFresh">,
    private readonly delegate: BaseAcpxRuntime,
    private readonly createDelegate: () => BaseAcpxRuntime,
  ) {}

  get isStopping(): boolean {
    return this.stopping;
  }

  assertRunning(): void {
    if (this.stopping) {
      throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime is shut down.");
    }
  }

  fromCaptured(resource: string, captured: AcpxGeneration | undefined): AcpxGeneration {
    // Handles may cross plugin instances, but process-local custody may not.
    return captured?.owner === this.generationOwner ? captured : this.currentGeneration(resource);
  }

  prepareFresh(resource: string): void {
    const generation = this.generations.get(resource);
    if (generation) {
      this.retireGeneration(generation);
    } else {
      this.sessionStore.markFresh(resource);
    }
  }

  resolveDelegate(generation: AcpxGeneration, nativeTools: boolean): BaseAcpxRuntime {
    this.assertRunning();
    if (generation.delegate && generation.nativeTools !== nativeTools) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP session tool ownership changed.");
    }
    if (!generation.delegate) {
      // Reset successors need isolation from the prior runtime's queued work.
      generation.delegate = generation.afterReset ? this.createDelegate() : this.delegate;
      generation.nativeTools = nativeTools;
      if (generation.delegate !== this.delegate) {
        this.privateDelegates.add(generation.delegate);
      }
    }
    return generation.delegate;
  }

  currentGeneration(resource: string): AcpxGeneration {
    this.assertRunning();
    let generation = this.generations.get(resource);
    if (!generation) {
      const fresh = this.sessionStore.isFresh(resource);
      const afterReset = fresh || this.isolatedSessionResources.has(resource);
      if (afterReset) {
        this.isolatedSessionResources.add(resource);
      }
      generation = {
        id: ++this.nextGenerationId,
        owner: this.generationOwner,
        resource,
        ensureQueue: new KeyedAsyncQueue(),
        retired: false,
        activeOperations: 0,
        pendingAdmissions: 0,
        admissionState: "unadmitted",
        activeRecordOperations: new Map(),
        closedRecordIds: new Set(),
        records: new Map(),
        closeCompleted: false,
        afterReset,
        awaitPriorWrites: fresh,
      };
      this.generations.set(resource, generation);
    }
    return generation;
  }

  async runAdmission<T>(
    resource: string,
    run: (generation: AcpxGeneration) => Promise<T>,
  ): Promise<T> {
    const generation = this.currentGeneration(resource);
    // Queued callers already captured this generation; the first failure cannot retire it under them.
    generation.pendingAdmissions += 1;
    try {
      return await generation.ensureQueue.enqueue(resource + "\u0000" + generation.id, async () => {
        try {
          const result = await run(generation);
          generation.admissionState = "admitted";
          return result;
        } catch (error) {
          if (generation.admissionState !== "admitted") {
            generation.admissionState = "failed";
          }
          throw error;
        }
      });
    } finally {
      generation.pendingAdmissions -= 1;
      this.releaseIdleGeneration(generation);
    }
  }

  retireGeneration(generation: AcpxGeneration): void {
    generation.retired = true;
    if (this.generations.get(generation.resource) === generation) {
      this.generations.delete(generation.resource);
      this.sessionStore.markFresh(generation.resource);
    }
    this.releaseRetiredDelegate(generation);
  }

  private releaseRetiredDelegate(generation: AcpxGeneration): void {
    const delegate = generation.delegate;
    if (
      !generation.retired ||
      generation.activeOperations !== 0 ||
      generation.pendingAdmissions !== 0 ||
      !delegate ||
      delegate === this.delegate ||
      this.retiringDelegates.has(delegate)
    ) {
      return;
    }
    this.retiringDelegates.add(delegate);
    // Post-reset runtimes belong to one generation. The normal shared runtime
    // stays service-owned because it may still host unrelated sessions.
    void delegate.shutdown().then(
      () => this.privateDelegates.delete(delegate),
      () => {
        /* Retain failed cleanup for service shutdown to report. */
      },
    );
  }

  retainGenerationOperation(generation: AcpxGeneration, recordId: string): () => void {
    generation.activeOperations += 1;
    generation.activeRecordOperations.set(
      recordId,
      (generation.activeRecordOperations.get(recordId) ?? 0) + 1,
    );
    return () => {
      const remaining = (generation.activeRecordOperations.get(recordId) ?? 1) - 1;
      if (remaining === 0) {
        generation.activeRecordOperations.delete(recordId);
        generation.closedRecordIds.delete(recordId);
      } else {
        generation.activeRecordOperations.set(recordId, remaining);
      }
      generation.activeOperations -= 1;
      this.releaseIdleGeneration(generation);
    };
  }

  private releaseIdleGeneration(generation: AcpxGeneration): void {
    if (
      !generation.retired &&
      (generation.closeCompleted || generation.admissionState === "failed") &&
      generation.pendingAdmissions === 0 &&
      generation.activeOperations === 0 &&
      generation.records.size === 0 &&
      this.generations.get(generation.resource) === generation
    ) {
      // Empty failed admission owns no reset intent or persistent-state mutation.
      generation.retired = true;
      this.generations.delete(generation.resource);
    }
    this.releaseRetiredDelegate(generation);
  }

  assertCurrentGeneration(generation: AcpxGeneration): void {
    if (this.stopping || generation.retired) {
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        "ACP runtime operation was superseded by reset.",
      );
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const results = await Promise.allSettled(
      [this.delegate, ...this.privateDelegates].map((delegate) => delegate.shutdown()),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      throw new AggregateError(errors, "ACP runtime shutdown failed.");
    }
    this.privateDelegates.clear();
    this.generations.clear();
    this.isolatedSessionResources.clear();
  }
}
