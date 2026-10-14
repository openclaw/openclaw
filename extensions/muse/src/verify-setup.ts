import { spawnMspConnection } from "@muse-code/sdk";
import type { AgentHarnessSetupVerificationContext } from "openclaw/plugin-sdk/agent-harness";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { museEnvironment } from "./environment.js";

export async function verifyMuseSetup(ctx: AgentHarnessSetupVerificationContext): Promise<void> {
  ctx.signal.throwIfAborted();
  ctx.assertCurrent();
  const pluginConfig = ctx.config.plugins?.entries?.muse?.config;
  const config = isRecord(pluginConfig) ? pluginConfig : {};
  const env = await museEnvironment();
  ctx.signal.throwIfAborted();
  ctx.assertCurrent();
  const handshake = spawnMspConnection({
    command: typeof config.binaryPath === "string" ? config.binaryPath : "muse",
    args: ["serve", "--no-session-log", "--disable-shell", "--disable-write"],
    env,
    shutdownTimeoutMs: 1000,
  });
  const abort = () => {
    void handshake.close();
  };
  const timeout = setTimeout(abort, 30_000);
  timeout.unref();
  ctx.signal?.addEventListener("abort", abort, { once: true });
  if (ctx.signal?.aborted) {
    abort();
  }
  try {
    const host = await handshake.initialize({ clientInfo: { name: "openclaw", version: "1" } });
    ctx.signal?.throwIfAborted();
    ctx.assertCurrent();
    // Starting a session does not validate auth. Only the live provider catalog
    // proves Muse could authenticate without giving a model any tools to execute.
    const catalog = await host.connection.request("model/list", {});
    ctx.signal?.throwIfAborted();
    ctx.assertCurrent();
    if (
      catalog.source !== "providerCatalog" ||
      catalog.providerId !== ctx.provider ||
      !Array.isArray(catalog.models) ||
      !catalog.models.some(
        (model: unknown) =>
          isRecord(model) && model.providerId === ctx.provider && model.modelId === ctx.modelId,
      )
    ) {
      throw new Error(
        `Muse Code could not authenticate access to ${ctx.provider}/${ctx.modelId}. Sign in again, or select a model available to your Meta account.`,
      );
    }
  } catch (error) {
    ctx.signal?.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timeout);
    ctx.signal?.removeEventListener("abort", abort);
    await handshake.close();
  }
}
