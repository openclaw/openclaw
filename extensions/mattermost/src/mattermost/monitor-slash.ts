import { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
import { isLoopbackHost } from "openclaw/plugin-sdk/gateway-runtime";
import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  fetchMattermostUserTeams,
  normalizeMattermostBaseUrl,
  type MattermostClient,
} from "./client.js";
import {
  prepareSkillCommandsForAgents,
  type OpenClawConfig,
  type RuntimeEnv,
} from "./runtime-api.js";
import {
  DEFAULT_COMMAND_SPECS,
  isSlashCommandsEnabled,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveSlashCommandConfig,
  type MattermostCommandSpec,
  type MattermostRegisteredCommand,
  type MattermostSlashCommandConfig,
} from "./slash-commands.js";
import { activateSlashCommands } from "./slash-state.js";

export async function registerMattermostMonitorSlashCommands(params: {
  client: MattermostClient;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  account: ResolvedMattermostAccount;
  baseUrl: string;
  botUserId: string;
}) {
  const commandsRaw = params.account.config.commands as
    | Partial<MattermostSlashCommandConfig>
    | undefined;
  const slashConfig = resolveSlashCommandConfig(commandsRaw);
  if (!isSlashCommandsEnabled(slashConfig)) {
    return;
  }

  try {
    const teams = await fetchMattermostUserTeams(params.client, params.botUserId);
    const slashCallbackUrl = resolveCallbackUrl({
      config: slashConfig,
      gatewayPort: resolveGatewayPort(params.cfg),
      gatewayHost: params.cfg.gateway?.customBindHost,
    });

    try {
      const mmHost = new URL(normalizeMattermostBaseUrl(params.baseUrl) ?? params.baseUrl).hostname;
      const callbackHost = new URL(slashCallbackUrl).hostname;
      if (isLoopbackHost(callbackHost) && !isLoopbackHost(mmHost)) {
        params.runtime.error?.(
          `mattermost: slash commands callbackUrl resolved to ${slashCallbackUrl} (loopback) while baseUrl is ${params.baseUrl}. This MAY be unreachable depending on your deployment. If native slash commands don't work, set channels.mattermost.commands.callbackUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).`,
        );
      }
    } catch {
      // Ignore malformed URLs and let the downstream registration fail naturally.
    }

    const cfg = params.cfg;
    const runtime = params.runtime;
    const commandsToRegister: MattermostCommandSpec[] = [...DEFAULT_COMMAND_SPECS];
    if (slashConfig.nativeSkills === true) {
      try {
        const skillCommands = await prepareSkillCommandsForAgents({ cfg });
        for (const spec of skillCommands) {
          const name = spec.name.trim();
          if (!name) {
            continue;
          }
          const trigger = name.startsWith("oc_") ? name : `oc_${name}`;
          commandsToRegister.push({
            trigger,
            description: spec.description || `Run skill ${name}`,
            autoComplete: true,
            autoCompleteHint: "[args]",
            originalName: name,
          });
        }
      } catch (err) {
        runtime.error?.(`mattermost: failed to list skill commands: ${String(err)}`);
      }
    }
    const seen = new Set<string>();
    const dedupedCommands = commandsToRegister.filter((cmd) => {
      const key = cmd.trigger.trim();
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    const registered: MattermostRegisteredCommand[] = [];
    let teamRegistrationFailures = 0;
    for (const team of teams) {
      try {
        const created = await registerSlashCommands({
          client: params.client,
          teamId: team.id,
          creatorUserId: params.botUserId,
          callbackUrl: slashCallbackUrl,
          commands: dedupedCommands,
          log: (msg) => params.runtime.log?.(msg),
        });
        registered.push(...created);
      } catch (err) {
        teamRegistrationFailures += 1;
        params.runtime.error?.(
          `mattermost: failed to register slash commands for team ${team.id}: ${String(err)}`,
        );
      }
    }

    if (registered.length === 0) {
      params.runtime.error?.(
        "mattermost: native slash commands enabled but no commands could be registered; keeping slash callbacks inactive",
      );
      return;
    }

    if (teamRegistrationFailures > 0) {
      params.runtime.error?.(
        `mattermost: slash command registration completed with ${teamRegistrationFailures} team error(s)`,
      );
    }

    const triggerMap = new Map<string, string>();
    for (const cmd of dedupedCommands) {
      if (cmd.originalName) {
        triggerMap.set(cmd.trigger, cmd.originalName);
      }
    }
    activateSlashCommands({
      account: params.account,
      registeredCommands: registered,
      triggerMap,
      api: { cfg: params.cfg, runtime: params.runtime },
      log: (msg) => params.runtime.log?.(msg),
    });

    params.runtime.log?.(
      `mattermost: slash commands registered (${registered.length} commands across ${teams.length} teams, callback=${slashCallbackUrl})`,
    );
  } catch (err) {
    params.runtime.error?.(`mattermost: failed to register slash commands: ${String(err)}`);
  }
}
