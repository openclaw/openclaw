import {
  getPluginCommandSpecs,
  listSkillCommandsForAgents,
  parseStrictPositiveInteger,
  type OpenClawConfig,
  type RuntimeEnv,
} from "../runtime-api.js";
import { listEnabledMattermostAccounts, type ResolvedMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostMe,
  fetchMattermostUserTeams,
  normalizeMattermostBaseUrl,
  type MattermostClient,
} from "./client.js";
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

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function collectPluginCommands(params: { runtime: RuntimeEnv }): MattermostCommandSpec[] {
  try {
    const specs: MattermostCommandSpec[] = [];
    const pluginCommands = getPluginCommandSpecs();
    for (const spec of pluginCommands) {
      const name = typeof spec.name === "string" ? spec.name.trim() : "";
      if (!name) continue;
      specs.push({
        trigger: name,
        description: spec.description || `Run plugin command ${name}`,
        autoComplete: true,
        autoCompleteHint: "[args]",
        originalName: name,
      });
    }
    return specs;
  } catch (err) {
    params.runtime.error?.(`mattermost: failed to list plugin commands: ${String(err)}`);
    return [];
  }
}

function buildSlashCommands(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  nativeSkills: boolean;
}): MattermostCommandSpec[] {
  const commandsToRegister: MattermostCommandSpec[] = [...DEFAULT_COMMAND_SPECS];
  if (params.nativeSkills) {
    try {
      const skillCommands = listSkillCommandsForAgents({ cfg: params.cfg as any });
      for (const spec of skillCommands) {
        const name = typeof spec.name === "string" ? spec.name.trim() : "";
        if (!name) continue;
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
      params.runtime.error?.(`mattermost: failed to list skill commands: ${String(err)}`);
    }
  }

  commandsToRegister.push(...collectPluginCommands({ runtime: params.runtime }));

  return commandsToRegister;
}

function dedupeSlashCommands(commands: MattermostCommandSpec[]): MattermostCommandSpec[] {
  const seen = new Set<string>();
  return commands.filter((cmd) => {
    const key = cmd.trigger.trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildTriggerMap(commands: MattermostCommandSpec[]): Map<string, string> {
  const triggerMap = new Map<string, string>();
  for (const cmd of commands) {
    if (cmd.originalName) {
      triggerMap.set(cmd.trigger, cmd.originalName);
    }
  }
  return triggerMap;
}

async function buildBotUserIdMap(params: {
  cfg: OpenClawConfig;
  account: ResolvedMattermostAccount;
  botUserId: string;
  runtime: RuntimeEnv;
}): Promise<Map<string, string>> {
  const botUserIdMap = new Map<string, string>();
  botUserIdMap.set(params.botUserId, params.account.accountId);

  const otherAccounts = listEnabledMattermostAccounts(params.cfg).filter(
    (a) => a.accountId !== params.account.accountId && a.botToken && a.baseUrl,
  );

  if (otherAccounts.length > 0) {
    const results = await Promise.allSettled(
      otherAccounts.map(async (a) => {
        const c = createMattermostClient({
          baseUrl: a.baseUrl!,
          botToken: a.botToken!,
        });
        const u = await fetchMattermostMe(c);
        return { mattermostUserId: u.id, accountId: a.accountId };
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        botUserIdMap.set(result.value.mattermostUserId, result.value.accountId);
      } else {
        params.runtime.error?.(
          `mattermost: failed to fetch user ID for bot account during slash setup: ${String(result.reason)}`,
        );
      }
    }
    params.runtime.log?.(
      `mattermost: slash DM routing map built with ${botUserIdMap.size} bot account(s)`,
    );
  }

  return botUserIdMap;
}

function warnOnSuspiciousCallbackUrl(params: {
  runtime: RuntimeEnv;
  baseUrl: string;
  callbackUrl: string;
}) {
  try {
    const mmHost = new URL(normalizeMattermostBaseUrl(params.baseUrl) ?? params.baseUrl).hostname;
    const callbackHost = new URL(params.callbackUrl).hostname;

    if (isLoopbackHost(callbackHost) && !isLoopbackHost(mmHost)) {
      params.runtime.error?.(
        `mattermost: slash commands callbackUrl resolved to ${params.callbackUrl} (loopback) while baseUrl is ${params.baseUrl}. This MAY be unreachable depending on your deployment. If native slash commands don't work, set channels.mattermost.commands.callbackUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).`,
      );
    }
  } catch {
    // Ignore malformed URLs and let the downstream registration fail naturally.
  }
}

async function registerSlashCommandsAcrossTeams(params: {
  client: MattermostClient;
  teams: Array<{ id: string }>;
  botUserId: string;
  callbackUrl: string;
  commands: MattermostCommandSpec[];
  runtime: RuntimeEnv;
}): Promise<{
  registered: MattermostRegisteredCommand[];
  teamRegistrationFailures: number;
}> {
  const registered: MattermostRegisteredCommand[] = [];
  let teamRegistrationFailures = 0;

  for (const team of params.teams) {
    try {
      const created = await registerSlashCommands({
        client: params.client,
        teamId: team.id,
        creatorUserId: params.botUserId,
        callbackUrl: params.callbackUrl,
        commands: params.commands,
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

  return { registered, teamRegistrationFailures };
}

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
    const envPort = parseStrictPositiveInteger(process.env.OPENCLAW_GATEWAY_PORT?.trim());
    const slashGatewayPort = envPort ?? params.cfg.gateway?.port ?? 18789;
    const slashCallbackUrl = resolveCallbackUrl({
      config: slashConfig,
      gatewayPort: slashGatewayPort,
      gatewayHost: params.cfg.gateway?.customBindHost ?? undefined,
    });

    warnOnSuspiciousCallbackUrl({
      runtime: params.runtime,
      baseUrl: params.baseUrl,
      callbackUrl: slashCallbackUrl,
    });

    const dedupedCommands = dedupeSlashCommands(
      buildSlashCommands({
        cfg: params.cfg,
        runtime: params.runtime,
        nativeSkills: slashConfig.nativeSkills === true,
      }),
    );
    const { registered, teamRegistrationFailures } = await registerSlashCommandsAcrossTeams({
      client: params.client,
      teams,
      botUserId: params.botUserId,
      callbackUrl: slashCallbackUrl,
      commands: dedupedCommands,
      runtime: params.runtime,
    });

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

    const triggerMap = buildTriggerMap(dedupedCommands);
    const botUserIdMap = await buildBotUserIdMap({
      cfg: params.cfg,
      account: params.account,
      botUserId: params.botUserId,
      runtime: params.runtime,
    });

    activateSlashCommands({
      account: params.account,
      commandTokens: registered.map((cmd) => cmd.token).filter(Boolean),
      registeredCommands: registered,
      triggerMap,
      botUserIdMap,
      api: { cfg: params.cfg, runtime: params.runtime },
      log: (msg) => params.runtime.log?.(msg),
    });

    params.runtime.log?.(
      `mattermost: slash commands registered (${registered.length} commands across ${teams.length} teams, callback=${slashCallbackUrl})`,
    );

    // Deferred plugin command registration: other plugins may not have loaded yet
    // when this monitor starts. Re-check after a delay and register any new ones.
    const registeredTriggers = new Set(registered.map((cmd) => cmd.trigger));
    setTimeout(async () => {
      try {
        const latePluginCommands = collectPluginCommands({ runtime: params.runtime }).filter(
          (cmd) => !registeredTriggers.has(cmd.trigger),
        );
        if (latePluginCommands.length === 0) return;

        params.runtime.log?.(
          `mattermost: registering ${latePluginCommands.length} deferred plugin command(s): ${latePluginCommands.map((c) => `/${c.trigger}`).join(", ")}`,
        );

        const lateTriggerMap = new Map<string, string>();
        for (const cmd of latePluginCommands) {
          if (cmd.originalName) lateTriggerMap.set(cmd.trigger, cmd.originalName);
        }

        const { registered: lateRegistered } = await registerSlashCommandsAcrossTeams({
          client: params.client,
          teams,
          botUserId: params.botUserId,
          callbackUrl: slashCallbackUrl,
          commands: latePluginCommands,
          runtime: params.runtime,
        });

        // Merge new tokens into the active slash command handler
        const newTokens = lateRegistered.map((cmd) => cmd.token).filter(Boolean);
        if (newTokens.length > 0) {
          activateSlashCommands({
            account: params.account,
            commandTokens: [...registered.map((c) => c.token).filter(Boolean), ...newTokens],
            registeredCommands: [...registered, ...lateRegistered],
            triggerMap: new Map([...triggerMap, ...lateTriggerMap]),
            botUserIdMap,
            api: { cfg: params.cfg, runtime: params.runtime },
            log: (msg) => params.runtime.log?.(msg),
          });

          // Update local tracking
          for (const cmd of lateRegistered) {
            registered.push(cmd);
            registeredTriggers.add(cmd.trigger);
          }
          for (const [k, v] of lateTriggerMap) {
            triggerMap.set(k, v);
          }
        }
      } catch (err) {
        params.runtime.error?.(
          `mattermost: deferred plugin command registration error: ${String(err)}`,
        );
      }
    }, 5_000);
  } catch (err) {
    params.runtime.error?.(`mattermost: failed to register slash commands: ${String(err)}`);
  }
}
