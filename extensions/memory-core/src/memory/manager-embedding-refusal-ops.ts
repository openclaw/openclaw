// Memory Core plugin module owns the remembered refusal of an implicit embeddings endpoint.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemoryEmbeddingProviderRuntime } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
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
  protected abstract markEmbeddingBootstrapFailure(err: unknown): MemoryEmbeddingBootstrapDebug;
  protected abstract refreshEmbeddingBootstrapFailure(
    failure: MemoryEmbeddingBootstrapDebug,
  ): MemoryEmbeddingBootstrapDebug;

  /** The remote endpoint an implicit (unset or auto) provider calls, from its cache identity. */
  private implicitEmbeddingEndpoint(cacheKeyData: unknown): MemoryEmbeddingEndpoint | undefined {
    return this.providerRequirement.mode === "optional" &&
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
  protected async recordedEmbeddingRefusal(
    runtime: MemoryEmbeddingProviderRuntime | undefined,
    recheck = false,
  ): Promise<MemoryEmbeddingRefusal | undefined> {
    const endpoint = recheck ? undefined : this.implicitEmbeddingEndpoint(runtime?.cacheKeyData);
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

  /** An explicit check that reached the endpoint clears its remembered refusal. */
  protected async forgetEmbeddingRefusal(): Promise<void> {
    const published = this.publishedDatabase;
    if (published.facts.embeddingRefusal && !published.readOnly) {
      await this.writeEmbeddingRefusal(null);
    }
  }

  /**
   * Status reads the stored refusal before any provider exists. It applies only while the
   * configuration still resolves to that implicit endpoint; a read-only status probe reports
   * it instead of a success it cannot record (`memory status --index` re-checks and clears).
   */
  protected projectStatusEmbeddingRefusal(
    refusal: MemoryEmbeddingRefusal | null | undefined,
  ): string | undefined {
    const endpoint = refusal
      ? this.implicitEmbeddingEndpoint(
          this.providerRuntime?.cacheKeyData ?? {
            provider: this.settings.provider,
            baseUrl: refusal.baseUrl,
            model: this.settings.model,
          },
        )
      : undefined;
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
