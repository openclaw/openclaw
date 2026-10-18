import { spawnMspConnection } from "@muse-code/sdk";
import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { museEnvironment } from "./environment.js";

type AgentHarnessSetupVerificationContext = Parameters<NonNullable<AgentHarness["verifySetup"]>>[0];
type MuseCatalogEntry = { id: string; name: string; provider: string; nativeRuntime: string };

export async function readMuseCatalog(
  ctx: Pick<AgentHarnessSetupVerificationContext, "config" | "signal" | "assertCurrent">,
): Promise<MuseCatalogEntry[]> {
  const config = ctx.config.plugins?.entries?.muse?.config;
  const { env } = await museEnvironment();
  ctx.signal.throwIfAborted();
  ctx.assertCurrent();
  const host = spawnMspConnection({
    command: isRecord(config) && typeof config.binaryPath === "string" ? config.binaryPath : "muse",
    args: ["serve", "--no-session-log", "--disable-shell", "--disable-write"],
    env,
    shutdownTimeoutMs: 1000,
  });
  const abort = () => {
    void host.close();
  };
  ctx.signal.addEventListener("abort", abort, { once: true });
  try {
    const ready = await host.initialize({ clientInfo: { name: "openclaw", version: "1" } });
    ctx.signal.throwIfAborted();
    ctx.assertCurrent();
    const catalog = await ready.connection.request("model/list", {});
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
    await host.close();
  }
}

export async function verifyMuseSetup(ctx: AgentHarnessSetupVerificationContext): Promise<void> {
  const models = await readMuseCatalog(ctx);
  if (!models.some((model) => model.provider === ctx.provider && model.id === ctx.modelId)) {
    throw new Error(
      `Muse Code cannot access ${ctx.provider}/${ctx.modelId}. Select a model available to your Meta account.`,
    );
  }
}
