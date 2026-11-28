// Memory Core plugin module owns the remembered refusal of an implicit embeddings endpoint.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderRuntime,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySearchRuntimeDebug } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveEmbeddingProviderAdapterTransport } from "./embeddings.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import {
  classifyEmbeddingEndpointFailure,
  formatMemoryEmbeddingRefusal,
  isSameMemoryEmbeddingEndpoint,
  readMemoryEmbeddingEndpoint,
  type MemoryEmbeddingEndpoint,
  type MemoryEmbeddingRefusal,
} from "./manager-embedding-refusal.js";
import type { MemoryManagerProviderFactory } from "./manager-registry.js";

const log = createSubsystemLogger("memory");

export type MemoryEmbeddingProviderRequirement = {
  mode: "fts-only" | "optional" | "required";
  provider: string;
  configuredProvider?: string;
};
export type MemoryEmbeddingBootstrapDebug = NonNullable<
  MemorySearchRuntimeDebug["embeddingBootstrap"]
>;

/**
 * An implicit (unset or auto) embedding provider probes its endpoint with the first real
 * request. "No embeddings route" (404/405/501) is remembered for that endpoint in the
 * published index; auth, rate and server errors only last until the next probe window.
 */
export abstract class MemoryEmbeddingRefusalOps extends MemoryManagerEmbeddingOps {
  protected abstract readonly providerRequirement: MemoryEmbeddingProviderRequirement;
  protected activeBackgroundCleanup = new Set<Promise<void>>();
  private statusEmbeddingRefusal?: string;
  /** The endpoint the configured provider calls, from its last refusal check. */
  private checkedEndpoint?: MemoryEmbeddingEndpoint;
  protected abstract markEmbeddingBootstrapFailure(err: unknown): MemoryEmbeddingBootstrapDebug;
  protected abstract refreshEmbeddingBootstrapFailure(
    failure: MemoryEmbeddingBootstrapDebug,
  ): MemoryEmbeddingBootstrapDebug;
  protected abstract ensureProviderInitialized(): Promise<void>;
  protected abstract retireProvider(provider: MemoryEmbeddingProvider | null): Promise<void>;

  /** A recorded refusal fails the provider like a missing credential: no embedding calls. */
  protected refusalCheckedProviderFactory(recheck?: boolean): MemoryManagerProviderFactory {
    return async (adapter, create) => {
      const result = await this.createProvider(adapter, create);
      const refusal = await this.recordedEmbeddingRefusal(result.runtime, recheck);
      if (refusal) {
        await this.retireProvider(result.provider);
        throw new Error(formatMemoryEmbeddingRefusal(refusal));
      }
      return result;
    };
  }

  /**
   * The remote endpoint an implicit (unset or auto) provider calls, from its cache identity.
   * With a configured fallback, a refusal is not remembered: each process tries the primary
   * and its failure hands off to the fallback, as before.
   */
  private implicitEmbeddingEndpoint(cacheKeyData: unknown): MemoryEmbeddingEndpoint | undefined {
    return this.providerRequirement.mode === "optional" &&
      (!this.settings.fallback || this.settings.fallback === "none") &&
      resolveEmbeddingProviderAdapterTransport(this.settings.provider, this.cfg) === "remote"
      ? readMemoryEmbeddingEndpoint(cacheKeyData)
      : undefined;
  }

  /** The refusal belongs to the published index, never to a reindex shadow. */
  private writeEmbeddingRefusal(refusal: MemoryEmbeddingRefusal | null): Promise<unknown> {
    const published = this.publishedDatabase;
    return published.settlePublication(() =>
      published.executePublication({ type: "index.writeEmbeddingRefusal", input: refusal }, () => {
        if (!published.isOpen) {
          throw new Error("Memory database owner closed before writing the embedding refusal");
        }
      }),
    );
  }

  protected markImplicitEmbeddingEndpointFailure(err: unknown): void {
    const failure = classifyEmbeddingEndpointFailure(err);
    const endpoint = failure && this.implicitEmbeddingEndpoint(this.providerRuntime?.cacheKeyData);
    if (!failure || !endpoint || !this.provider) {
      return;
    }
    void this.retireCurrentProvider();
    const debug = this.markEmbeddingBootstrapFailure(err);
    if (failure.kind === "transient") {
      return;
    }
    const refusal = { ...endpoint, status: failure.status, recordedAt: new Date().toISOString() };
    this.providerUnavailableReason = formatMemoryEmbeddingRefusal(refusal);
    this.refreshEmbeddingBootstrapFailure(debug);
    log.warn(`memory embeddings: ${this.providerUnavailableReason}`);
    if (this.publishedDatabase.readOnly) {
      return;
    }
    const write = this.writeEmbeddingRefusal(refusal)
      .catch((writeErr: unknown) => {
        log.warn(
          `memory embeddings: could not record the refusal: ${formatErrorMessage(writeErr)}`,
        );
      })
      .then(() => {
        this.activeBackgroundCleanup.delete(write);
      });
    this.activeBackgroundCleanup.add(write);
  }

  /** A remembered refusal for the endpoint this provider would call; a changed endpoint forgets it. */
  private async recordedEmbeddingRefusal(
    runtime: MemoryEmbeddingProviderRuntime | undefined,
    recheck = false,
  ): Promise<MemoryEmbeddingRefusal | undefined> {
    this.checkedEndpoint = this.implicitEmbeddingEndpoint(runtime?.cacheKeyData);
    const endpoint = recheck ? undefined : this.checkedEndpoint;
    if (!endpoint) {
      return undefined;
    }
    const published = this.publishedDatabase;
    await published.refreshFacts();
    const refusal = published.facts.embeddingRefusal;
    if (refusal && isSameMemoryEmbeddingEndpoint(refusal, endpoint)) {
      return refusal;
    }
    if (refusal && !published.readOnly) {
      await this.writeEmbeddingRefusal(null);
    }
    return undefined;
  }

  /** An explicit check that reached the refused endpoint clears its remembered refusal. */
  protected async forgetEmbeddingRefusal(): Promise<void> {
    const published = this.publishedDatabase;
    const refusal = published.facts.embeddingRefusal;
    // A healthy fallback says nothing about the primary endpoint that refused.
    const probed = this.implicitEmbeddingEndpoint(this.providerRuntime?.cacheKeyData);
    if (
      refusal &&
      probed &&
      isSameMemoryEmbeddingEndpoint(refusal, probed) &&
      !published.readOnly
    ) {
      await this.writeEmbeddingRefusal(null);
    }
  }

  /** Probes that only describe readiness treat a recorded refusal as unavailable, not fatal. */
  protected async ensureProviderInitializedOrRefused(): Promise<void> {
    try {
      await this.ensureProviderInitialized();
    } catch (err) {
      if (this.providerRequirement.mode !== "optional") {
        throw err;
      }
      this.markEmbeddingBootstrapFailure(err);
    }
  }

  /**
   * Only the provider's own identity says whether a recorded refusal covers today's endpoint.
   * Creating the provider sends no request; a covered endpoint stays refused. A writable
   * manager skips this: its explicit probe re-checks the endpoint and clears the record.
   */
  protected async withStatusRefusalIdentity<T extends { embeddingRefusal?: unknown }>(
    snapshot: T,
  ): Promise<T> {
    if (snapshot.embeddingRefusal && this.publishedDatabase.readOnly) {
      await this.ensureProviderInitializedOrRefused();
    }
    return snapshot;
  }

  /**
   * Status reads the stored refusal. It applies only while the configured provider still calls
   * that implicit endpoint; a read-only status probe reports it instead of a success it cannot
   * record (`memory status --index` re-checks and clears).
   */
  protected projectStatusEmbeddingRefusal(
    refusal: MemoryEmbeddingRefusal | null | undefined,
  ): string | undefined {
    const endpoint =
      this.implicitEmbeddingEndpoint(this.providerRuntime?.cacheKeyData) ?? this.checkedEndpoint;
    this.statusEmbeddingRefusal =
      refusal && endpoint && isSameMemoryEmbeddingEndpoint(refusal, endpoint)
        ? formatMemoryEmbeddingRefusal(refusal)
        : undefined;
    return this.statusEmbeddingRefusal;
  }

  protected readOnlyRecordedRefusal(): string | undefined {
    return this.publishedDatabase.readOnly ? this.statusEmbeddingRefusal : undefined;
  }
}
