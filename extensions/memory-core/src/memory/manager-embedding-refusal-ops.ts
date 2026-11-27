// Memory Core plugin module owns the remembered refusal of an implicit embeddings endpoint.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemoryEmbeddingProviderRuntime } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
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
import type {
  MemoryEmbeddingBootstrapDebug,
  MemoryEmbeddingProviderRequirement,
} from "./manager-provider-lifecycle.js";

const log = createSubsystemLogger("memory");

/**
 * An implicit (unset or auto) embedding provider probes its endpoint with the first real
 * request. "No embeddings route" (404/405/501) is remembered for that endpoint in the
 * published index; auth, rate and server errors only last until the next probe window.
 */
export abstract class MemoryEmbeddingRefusalOps extends MemoryManagerEmbeddingOps {
  protected abstract readonly providerRequirement: MemoryEmbeddingProviderRequirement;
  protected activeBackgroundCleanup = new Set<Promise<void>>();
  protected abstract markEmbeddingBootstrapFailure(err: unknown): MemoryEmbeddingBootstrapDebug;
  protected abstract refreshEmbeddingBootstrapFailure(
    failure: MemoryEmbeddingBootstrapDebug,
  ): MemoryEmbeddingBootstrapDebug;

  private implicitEmbeddingEndpoint(
    runtime: MemoryEmbeddingProviderRuntime | undefined,
  ): MemoryEmbeddingEndpoint | undefined {
    return this.providerRequirement.mode === "optional" &&
      resolveEmbeddingProviderAdapterTransport(this.settings.provider, this.cfg) === "remote"
      ? readMemoryEmbeddingEndpoint(runtime?.cacheKeyData)
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
    const endpoint = failure && this.implicitEmbeddingEndpoint(this.providerRuntime);
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
  ): Promise<MemoryEmbeddingRefusal | undefined> {
    const endpoint = this.implicitEmbeddingEndpoint(runtime);
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
}
