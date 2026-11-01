import { isDeepStrictEqual } from "node:util";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import {
  isUserModelAuthProfileId,
  withAuthProfileStoreAtEffect,
  withPersonalAuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import { z } from "zod";
import { readCodexPluginConfig, resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
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
    const assertCallerCurrent = () => {
      if (
        signal?.aborted ||
        hasCurrentClientAuthority?.() === false ||
        context.getRuntimeConfig() !== config
      ) {
        throw new Error("Account credentials changed. Refresh Models and try again.");
      }
    };
    const readUsage = async (
      preparedStore: AuthProfileStore,
      reader: { read?(): Promise<AuthProfileStore>; assertCurrent(): void },
    ) => {
      const store = structuredClone(preparedStore);
      const credential = store.profiles[profileId];
      if (!credential || credential.provider !== "openai" || credential.type === "api_key") {
        invalid("Select a saved Codex subscription login.");
        return;
      }
      const assertPrepared = () => {
        assertCallerCurrent();
        reader.assertCurrent();
      };
      assertPrepared();
      const { start } = resolveCodexAppServerRuntimeOptions({
        pluginConfig: readCodexPluginConfig(config.plugins?.entries?.codex?.config),
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
        assertCurrent: assertPrepared,
        // Account rows must never log into the operator's native Codex home or daemon.
        startOptions: {
          ...start,
          transport: "stdio",
          homeScope: "agent",
        },
      });
      const current = await reader.read?.();
      assertPrepared();
      if (current && !isDeepStrictEqual(current.profiles[profileId], credential)) {
        throw new Error("Account credentials changed. Refresh Models and try again.");
      }
      const snapshot = buildCodexAppServerUsageSnapshot(usage.rateLimits, {
        accountDetails: true,
      });
      respond(true, { updatedAt: Date.now(), providers: [snapshot] });
    };

    if (isUserModelAuthProfileId(profileId)) {
      const handled = await withPersonalAuthProfileStore(profileId, async (owner) => {
        const store = await owner.read();
        const readCurrentCredential = owner.readCurrentCredential;
        await readUsage(store, {
          assertCurrent: () => {
            if (!isDeepStrictEqual(readCurrentCredential(), store.profiles[profileId])) {
              throw new Error("Account credentials changed. Refresh Models and try again.");
            }
          },
        });
        return true;
      });
      if (!handled) {
        invalid("Select a saved Codex subscription login.");
      }
    } else {
      await withAuthProfileStoreAtEffect(
        agentDir,
        {
          profileId,
          allowKeychainPrompt: false,
          config,
          externalCliProviderIds: ["openai"],
          externalCliProfileIds: [profileId],
        },
        async (reader) => readUsage(await reader.read(), reader),
      );
    }
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
