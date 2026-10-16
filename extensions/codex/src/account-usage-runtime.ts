import { isDeepStrictEqual } from "node:util";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { ensureAuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { z } from "zod";
import { resolveCodexAppServerAuthProfileStore } from "./app-server/auth-profile.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { isCodexAppServerProxyLaunch } from "./app-server/launch-args.js";
import { buildCodexAppServerUsageSnapshot } from "./app-server/rate-limits.js";
import { readCodexAppServerUsage } from "./app-server/request.js";

const paramsSchema = z
  .object({ agentId: z.string().min(1), profileId: z.string().min(1) })
  .strict();

export async function handleCodexAccountUsage({
  params,
  respond,
  context,
  signal,
  hasCurrentClientAuthority,
}: GatewayRequestHandlerOptions): Promise<void> {
  const invalid = (message: string) =>
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) {
    invalid("Expected agentId and profileId.");
    return;
  }
  const { agentId, profileId } = parsed.data;
  const config = context.getRuntimeConfig();
  if (!listAgentIds(config).includes(agentId)) {
    invalid("Unknown agent.");
    return;
  }
  try {
    const agentDir = resolveAgentDir(config, agentId);
    const store = structuredClone(
      await resolveCodexAppServerAuthProfileStore({ agentDir, authProfileId: profileId, config }),
    );
    const credential = store.profiles[profileId];
    if (!credential || credential.provider !== "openai" || credential.type === "api_key") {
      invalid("Select a saved Codex subscription login.");
      return;
    }
    // Recheck the selected credential at disclosure, after the asynchronous usage request.
    const assertCurrent = () => {
      if (
        signal?.aborted ||
        hasCurrentClientAuthority?.() === false ||
        context.getRuntimeConfig() !== config ||
        !isDeepStrictEqual(
          ensureAuthProfileStore(agentDir, {
            profileId,
            allowKeychainPrompt: false,
            config,
            externalCliProviderIds: ["openai"],
            externalCliProfileIds: [profileId],
          }).profiles[profileId],
          store.profiles[profileId],
        )
      ) {
        throw new Error("Account credentials changed. Refresh Models and try again.");
      }
    };
    assertCurrent();
    const { start } = resolveCodexAppServerRuntimeOptions({
      pluginConfig: config.plugins?.entries?.codex?.config,
    });
    if (isCodexAppServerProxyLaunch(start.args)) {
      throw new Error(
        "Account usage is unavailable through a Codex proxy. Configure a direct app-server launch.",
      );
    }
    const usage = await readCodexAppServerUsage({
      agentDir,
      config,
      timeoutMs: 20_000,
      preparedAuth: { kind: "profile", profileId, store },
      authRequirement: "subscription",
      assertCurrent,
      // Account rows must never log into the operator's native Codex home or daemon.
      startOptions: {
        ...start,
        transport: "stdio",
        homeScope: "agent",
      },
    });
    assertCurrent();
    const snapshot = buildCodexAppServerUsageSnapshot(usage.rateLimits, {
      accountDetails: true,
    });
    respond(true, { updatedAt: Date.now(), providers: [snapshot] });
  } catch (error) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        error instanceof Error
          ? error.message
          : "Codex usage unavailable. Try refreshing the account.",
      ),
    );
  }
}
