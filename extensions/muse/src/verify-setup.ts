import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { MusePool } from "./runtime.js";

type AgentHarnessSetupVerificationContext = Parameters<NonNullable<AgentHarness["verifySetup"]>>[0];
type MuseCatalogEntry = { id: string; name: string; provider: string; nativeRuntime: string };

/** One lifecycle owner for read-only catalog hosts; every read still asks Meta for live access. */
export class MuseCatalogReader {
  private current: { binaryPath: string; pool: MusePool } | undefined;

  async read(
    ctx: Pick<AgentHarnessSetupVerificationContext, "config" | "signal" | "assertCurrent">,
  ): Promise<MuseCatalogEntry[]> {
    ctx.signal.throwIfAborted();
    ctx.assertCurrent();
    const config = ctx.config.plugins?.entries?.muse?.config;
    const binaryPath =
      isRecord(config) && typeof config.binaryPath === "string" ? config.binaryPath : "muse";
    if (this.current?.binaryPath !== binaryPath) {
      const previous = this.current;
      this.current = { binaryPath, pool: new MusePool(binaryPath, true) };
      await previous?.pool.dispose();
      ctx.signal.throwIfAborted();
      ctx.assertCurrent();
    }
    // Catalog checks do not need a workspace. The pool retires a host whenever
    // the managed credential or environment key changes, including before commit.
    const lease = await this.current.pool.acquire(undefined, undefined, true, ctx.signal);
    const abort = () => {
      void lease.runtime.close();
    };
    ctx.signal.addEventListener("abort", abort, { once: true });
    try {
      ctx.signal.throwIfAborted();
      ctx.assertCurrent();
      const catalog = await lease.runtime.host.connection.request("model/list", {});
      ctx.signal.throwIfAborted();
      ctx.assertCurrent();
      if (
        catalog.source !== "providerCatalog" ||
        catalog.providerId !== "meta" ||
        !Array.isArray(catalog.models)
      ) {
        throw new Error("Muse Code could not authenticate. Sign in again to access Meta models.");
      }
      return catalog.models.flatMap((model: unknown) =>
        isRecord(model) && model.providerId === "meta" && typeof model.modelId === "string"
          ? [
              {
                id: model.modelId,
                name: typeof model.displayLabel === "string" ? model.displayLabel : model.modelId,
                provider: "meta",
                nativeRuntime: "muse",
              },
            ]
          : [],
      );
    } finally {
      ctx.signal.removeEventListener("abort", abort);
      lease.release();
    }
  }

  async verify(ctx: AgentHarnessSetupVerificationContext): Promise<void> {
    const models = await this.read(ctx);
    if (!models.some((model) => model.provider === ctx.provider && model.id === ctx.modelId)) {
      throw new Error(
        `Muse Code cannot access ${ctx.provider}/${ctx.modelId}. Select a model available to your Meta account.`,
      );
    }
  }

  async dispose(): Promise<void> {
    await this.current?.pool.dispose();
  }
}
