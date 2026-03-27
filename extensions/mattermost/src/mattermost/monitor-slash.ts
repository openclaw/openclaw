import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  listSkillCommandsForAgents,
  parseStrictPositiveInteger,
  type OpenClawConfig,
  type RuntimeEnv,
} from "../runtime-api.js";
import { getMattermostRuntime } from "../runtime.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  fetchMattermostUserTeams,
  normalizeMattermostBaseUrl,
  type MattermostClient,
} from "./client.js";
import {
  DEFAULT_COMMAND_SPECS,
  MattermostIncompleteBlindCreateError,
  cleanupSlashCommands,
  isSlashCommandsEnabled,
  loadPersistedSlashCommandState,
  mergePersistedSlashCommands,
  registerSlashCommands,
  removePersistedSlashCommands,
  resolveCallbackUrl,
  resolveSlashCommandCachePath,
  resolveSlashCommandConfig,
  savePersistedSlashCommandState,
  type MattermostCommandSpec,
  type MattermostPersistedSlashCommandState,
  type MattermostRegisteredCommand,
  type MattermostSlashCommandConfig,
} from "./slash-commands.js";
import { activateSlashCommands } from "./slash-state.js";

export type MattermostMonitorSlashLifecycle = {
  cachePath: string;
  ownerId: string;
};

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function buildSlashCommands(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  nativeSkills: boolean;
}): MattermostCommandSpec[] {
  const commandsToRegister: MattermostCommandSpec[] = [...DEFAULT_COMMAND_SPECS];
  if (!params.nativeSkills) {
    return commandsToRegister;
  }
  try {
    const skillCommands = listSkillCommandsForAgents({ cfg: params.cfg });
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

function resolveSlashCachePath(accountId: string): string {
  return resolveSlashCommandCachePath(
    getMattermostRuntime().state.resolveStateDir(process.env, os.homedir),
    accountId,
  );
}

async function claimSlashCommandCacheOwnership(params: {
  cachePath: string;
  ownerId: string;
  cachedState: MattermostPersistedSlashCommandState;
  log?: (msg: string) => void;
}): Promise<MattermostPersistedSlashCommandState> {
  if (params.cachedState.commands.length === 0) {
    return params.cachedState;
  }
  await savePersistedSlashCommandState(
    params.cachePath,
    {
      ownerId: params.ownerId,
      commands: params.cachedState.commands,
    },
    params.log,
  );
  return {
    ownerId: params.ownerId,
    commands: params.cachedState.commands,
  };
}

async function registerSlashCommandsAcrossTeams(params: {
  client: MattermostClient;
  teams: Array<{ id: string }>;
  botUserId: string;
  callbackUrl: string;
  commands: MattermostCommandSpec[];
  cachedState: MattermostPersistedSlashCommandState;
  runtime: RuntimeEnv;
}): Promise<{
  activeRegistered: MattermostRegisteredCommand[];
  persistedCommands: MattermostRegisteredCommand[];
  teamRegistrationFailures: number;
}> {
  const activeRegistered: MattermostRegisteredCommand[] = [];
  const recoverableCommands: MattermostRegisteredCommand[] = [];
  const successfullyRefreshedTeamIds = new Set<string>();
  let teamRegistrationFailures = 0;

  for (const team of params.teams) {
    try {
      const created = await registerSlashCommands({
        client: params.client,
        teamId: team.id,
        creatorUserId: params.botUserId,
        callbackUrl: params.callbackUrl,
        commands: params.commands,
        cachedCommands: params.cachedState.commands,
        log: (msg) => params.runtime.log?.(msg),
      });
      successfullyRefreshedTeamIds.add(team.id);
      activeRegistered.push(...created);
    } catch (err) {
      if (err instanceof MattermostIncompleteBlindCreateError) {
        recoverableCommands.push(...err.recoverableCommands);
      }
      teamRegistrationFailures += 1;
      params.runtime.error?.(
        `mattermost: failed to register slash commands for team ${team.id}: ${String(err)}`,
      );
    }
  }

  const persistedAfterSuccess = mergePersistedSlashCommands({
    cachedCommands: params.cachedState.commands,
    registeredCommands: activeRegistered,
    refreshedTeamIds: successfullyRefreshedTeamIds,
  });

  const recoveryTeamIds = new Set(
    recoverableCommands.map((cmd) => cmd.teamId.trim()).filter(Boolean),
  );
  const persistedCommands =
    recoveryTeamIds.size > 0
      ? mergePersistedSlashCommands({
          cachedCommands: persistedAfterSuccess,
          registeredCommands: recoverableCommands,
          refreshedTeamIds: recoveryTeamIds,
        })
      : persistedAfterSuccess;

  return {
    activeRegistered,
    persistedCommands,
    teamRegistrationFailures,
  };
}

async function isCurrentSlashCacheOwner(params: {
  cachePath: string;
  ownerId: string;
  log?: (msg: string) => void;
}): Promise<boolean> {
  const currentState = await loadPersistedSlashCommandState(params.cachePath, params.log);
  return !currentState.ownerId || currentState.ownerId === params.ownerId;
}

export async function registerMattermostMonitorSlashCommands(params: {
  client: MattermostClient;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  account: ResolvedMattermostAccount;
  baseUrl: string;
  botUserId: string;
}): Promise<MattermostMonitorSlashLifecycle | null> {
  const commandsRaw = params.account.config.commands as
    | Partial<MattermostSlashCommandConfig>
    | undefined;
  const slashConfig = resolveSlashCommandConfig(commandsRaw);
  if (!isSlashCommandsEnabled(slashConfig)) {
    return null;
  }

  const lifecycle: MattermostMonitorSlashLifecycle = {
    cachePath: resolveSlashCachePath(params.account.accountId),
    ownerId: randomUUID(),
  };

  try {
    let cachedState = await loadPersistedSlashCommandState(lifecycle.cachePath, (msg) =>
      params.runtime.log?.(msg),
    );
    cachedState = await claimSlashCommandCacheOwnership({
      cachePath: lifecycle.cachePath,
      ownerId: lifecycle.ownerId,
      cachedState,
      log: (msg) => params.runtime.log?.(msg),
    });

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

    const { activeRegistered, persistedCommands, teamRegistrationFailures } =
      await registerSlashCommandsAcrossTeams({
        client: params.client,
        teams,
        botUserId: params.botUserId,
        callbackUrl: slashCallbackUrl,
        commands: dedupedCommands,
        cachedState,
        runtime: params.runtime,
      });

    if (persistedCommands.length > 0) {
      await savePersistedSlashCommandState(
        lifecycle.cachePath,
        {
          ownerId: lifecycle.ownerId,
          commands: persistedCommands,
        },
        (msg) => params.runtime.log?.(msg),
      );
    } else {
      await removePersistedSlashCommands(lifecycle.cachePath, (msg) => params.runtime.log?.(msg));
    }

    if (activeRegistered.length === 0) {
      params.runtime.error?.(
        "mattermost: native slash commands enabled but no commands could be registered; keeping slash callbacks inactive",
      );
      return lifecycle;
    }

    if (teamRegistrationFailures > 0) {
      params.runtime.error?.(
        `mattermost: slash command registration completed with ${teamRegistrationFailures} team error(s)`,
      );
    }

    activateSlashCommands({
      account: params.account,
      commandTokens: activeRegistered.map((cmd) => cmd.token).filter(Boolean),
      registeredCommands: activeRegistered,
      triggerMap: buildTriggerMap(dedupedCommands),
      api: { cfg: params.cfg, runtime: params.runtime },
      log: (msg) => params.runtime.log?.(msg),
    });

    params.runtime.log?.(
      `mattermost: slash commands registered (${activeRegistered.length} commands across ${teams.length} teams, callback=${slashCallbackUrl})`,
    );
  } catch (err) {
    params.runtime.error?.(`mattermost: failed to register slash commands: ${String(err)}`);
  }

  return lifecycle;
}

export async function cleanupMattermostMonitorSlashCommands(params: {
  client: MattermostClient;
  lifecycle: MattermostMonitorSlashLifecycle | null;
  commands: MattermostRegisteredCommand[];
  log?: (msg: string) => void;
}): Promise<void> {
  const remainingCommands = await cleanupSlashCommands({
    client: params.client,
    commands: params.commands,
    log: params.log,
    shouldDelete:
      params.lifecycle == null
        ? undefined
        : async () =>
            await isCurrentSlashCacheOwner({
              cachePath: params.lifecycle!.cachePath,
              ownerId: params.lifecycle!.ownerId,
              log: params.log,
            }),
  });

  if (!params.lifecycle) {
    return;
  }

  const currentState = await loadPersistedSlashCommandState(params.lifecycle.cachePath, params.log);
  if (currentState.ownerId && currentState.ownerId !== params.lifecycle.ownerId) {
    return;
  }

  const activeTeamIds = new Set(params.commands.map((cmd) => cmd.teamId.trim()).filter(Boolean));
  const mergedCommands =
    activeTeamIds.size > 0
      ? mergePersistedSlashCommands({
          cachedCommands: currentState.commands,
          registeredCommands: remainingCommands,
          refreshedTeamIds: activeTeamIds,
        })
      : currentState.commands;

  if (mergedCommands.length > 0) {
    await savePersistedSlashCommandState(
      params.lifecycle.cachePath,
      {
        ownerId: params.lifecycle.ownerId,
        commands: mergedCommands,
      },
      params.log,
    );
    return;
  }

  await removePersistedSlashCommands(params.lifecycle.cachePath, params.log);
}
