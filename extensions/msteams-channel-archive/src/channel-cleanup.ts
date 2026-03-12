import type {
  Logger,
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
  type MSTeamsConfig,
} from "openclaw/plugin-sdk/msteams";
import type { MSTeamsChannelArchiveStore } from "./archive-store.js";

export type MSTeamsChannelArchivePluginConfig = {
  cleanup?: {
    enabled?: boolean;
    intervalMinutes?: number;
  };
};

type CleanupSettings = {
  enabled: boolean;
  intervalMs: number;
};

type GraphCredentials = {
  tenantId: string;
  appId: string;
  appPassword: string;
};

type GraphTeam = {
  id?: string;
};

type GraphChannel = {
  id?: string;
};

type ChannelExistenceChecker = (params: {
  accessToken: string;
  teamId: string;
  channelId: string;
}) => Promise<boolean>;

type GraphTeamResolver = (params: {
  accessToken: string;
  archive: {
    conversationId: string;
    teamId?: string;
    channelId?: string;
  };
}) => Promise<string | null>;

type CleanupSweepDeps = {
  logger: Logger;
  store: Pick<MSTeamsChannelArchiveStore, "listChannelArchives" | "pruneConversation">;
  getAccessToken: () => Promise<string>;
  channelExists: ChannelExistenceChecker;
  resolveGraphTeamId?: GraphTeamResolver;
};

export type CleanupSweepResult = {
  scanned: number;
  pruned: number;
  skipped: number;
};

const DEFAULT_CLEANUP_INTERVAL_MINUTES = 30;
const MIN_CLEANUP_INTERVAL_MINUTES = 5;

class GraphRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GraphRequestError";
  }
}

export function createChannelArchiveCleanupService(params: {
  api: OpenClawPluginApi;
  store: MSTeamsChannelArchiveStore;
}): OpenClawPluginService {
  const { api, store } = params;
  let cleanupTimer: NodeJS.Timeout | null = null;

  return {
    id: "msteams-channel-archive-cleanup",
    async start() {
      const settings = resolveCleanupSettings(
        (api.pluginConfig as MSTeamsChannelArchivePluginConfig | undefined) ?? {},
      );
      if (!settings.enabled) {
        api.logger.info?.("msteams-channel-archive: deleted-channel cleanup disabled");
        return;
      }

      const credentials = resolveGraphCredentials(api.config);
      if (!credentials) {
        api.logger.warn?.(
          "msteams-channel-archive: missing Teams app credentials; deleted-channel cleanup skipped",
        );
        return;
      }

      const runSweep = async (): Promise<void> => {
        const result = await runArchiveCleanupSweep({
          logger: api.logger,
          store,
          getAccessToken: async () => await fetchGraphAccessToken(credentials),
          channelExists: async (sweepParams) => await fetchGraphChannelExists(sweepParams),
        });
        api.logger.info?.(
          "msteams-channel-archive: deleted-channel cleanup sweep finished",
          result,
        );
      };

      try {
        await runSweep();
      } catch (error: unknown) {
        api.logger.warn?.("msteams-channel-archive: initial deleted-channel cleanup sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      cleanupTimer = setInterval(() => {
        void runSweep().catch((error: unknown) => {
          api.logger.warn?.("msteams-channel-archive: deleted-channel cleanup sweep failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, settings.intervalMs);
      cleanupTimer.unref?.();
    },
    async stop() {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
    },
  };
}

export async function runArchiveCleanupSweep(
  params: CleanupSweepDeps,
): Promise<CleanupSweepResult> {
  const {
    logger,
    store,
    getAccessToken,
    channelExists,
    resolveGraphTeamId = resolveGraphTeamIdForArchive,
  } = params;
  const archives = await store.listChannelArchives();

  let accessToken: string | null = null;
  let pruned = 0;
  let skipped = 0;
  // Cache: runtimeTeamId/channelId → resolved Graph team GUID, shared across the whole sweep
  // to avoid repeating a full-tenant team+channel scan for each archived channel.
  const graphTeamIdCache = new Map<string, string | null>();

  for (const archive of archives) {
    if (!archive.teamId || !archive.channelId) {
      skipped += 1;
      logger.warn?.(
        "msteams-channel-archive: skipping cleanup for archive missing team/channel ids",
        {
          conversationId: archive.conversationId,
        },
      );
      continue;
    }

    try {
      accessToken ??= await getAccessToken();
      const cacheKey = `${archive.teamId}::${archive.channelId}`;
      let graphTeamId: string | null;
      if (graphTeamIdCache.has(cacheKey)) {
        graphTeamId = graphTeamIdCache.get(cacheKey) ?? null;
      } else {
        graphTeamId = await resolveGraphTeamId({
          accessToken,
          archive,
        });
        graphTeamIdCache.set(cacheKey, graphTeamId);
      }
      if (!graphTeamId) {
        skipped += 1;
        logger.warn?.(
          "msteams-channel-archive: unable to resolve Graph team id for archived channel",
          {
            conversationId: archive.conversationId,
            teamId: archive.teamId,
            channelId: archive.channelId,
          },
        );
        continue;
      }
      const exists = await channelExists({
        accessToken,
        teamId: graphTeamId,
        channelId: archive.channelId,
      });
      if (!exists) {
        await store.pruneConversation(archive.conversationId);
        pruned += 1;
      }
    } catch (error) {
      skipped += 1;
      logger.warn?.("msteams-channel-archive: deleted-channel cleanup check failed", {
        conversationId: archive.conversationId,
        teamId: archive.teamId,
        channelId: archive.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    scanned: archives.length,
    pruned,
    skipped,
  };
}

function resolveCleanupSettings(config: MSTeamsChannelArchivePluginConfig): CleanupSettings {
  const intervalMinutes = Math.max(
    MIN_CLEANUP_INTERVAL_MINUTES,
    config.cleanup?.intervalMinutes ?? DEFAULT_CLEANUP_INTERVAL_MINUTES,
  );
  return {
    enabled: config.cleanup?.enabled ?? true,
    intervalMs: intervalMinutes * 60_000,
  };
}

function resolveGraphCredentials(config: OpenClawConfig): GraphCredentials | null {
  const teamsConfig = config.channels?.msteams as MSTeamsConfig | undefined;
  if (!teamsConfig) {
    return null;
  }

  const appId = normalizeSecretInputString(teamsConfig.appId);
  const appPassword = normalizeResolvedSecretInputString({
    value: teamsConfig.appPassword,
    path: "channels.msteams.appPassword",
  });
  const tenantId = normalizeSecretInputString(teamsConfig.tenantId);

  if (!appId || !appPassword || !tenantId) {
    return null;
  }

  return { appId, appPassword, tenantId };
}

async function fetchGraphAccessToken(credentials: GraphCredentials): Promise<string> {
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: credentials.appId,
        client_secret: credentials.appPassword,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );

  if (!response.ok) {
    throw new GraphRequestError(response.status, await response.text());
  }

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("Graph token response missing access_token");
  }
  return body.access_token;
}

async function fetchGraphChannelExists(params: {
  accessToken: string;
  teamId: string;
  channelId: string;
}): Promise<boolean> {
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(params.teamId)}/channels/${encodeURIComponent(params.channelId)}?$select=id`,
    {
      headers: {
        authorization: `Bearer ${params.accessToken}`,
      },
    },
  );

  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new GraphRequestError(response.status, await response.text());
  }
  return true;
}

function isGraphTeamId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

async function resolveGraphTeamIdForArchive(params: {
  accessToken: string;
  archive: {
    conversationId: string;
    teamId?: string;
    channelId?: string;
  };
}): Promise<string | null> {
  if (isGraphTeamId(params.archive.teamId)) {
    return params.archive.teamId;
  }
  const channelId = params.archive.channelId?.trim();
  if (!channelId) {
    return null;
  }

  const teams = await listGraphTeams(params.accessToken);
  for (const team of teams) {
    const graphTeamId = team.id?.trim();
    if (!graphTeamId) {
      continue;
    }
    const channels = await listGraphChannelsForTeam({
      accessToken: params.accessToken,
      teamId: graphTeamId,
    });
    if (channels.some((channel) => channel.id?.trim() === channelId)) {
      return graphTeamId;
    }
  }

  return null;
}

async function listGraphTeams(accessToken: string): Promise<GraphTeam[]> {
  const items = await fetchGraphCollection<GraphTeam>({
    accessToken,
    url: "https://graph.microsoft.com/v1.0/groups?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id",
  });
  return items;
}

async function listGraphChannelsForTeam(params: {
  accessToken: string;
  teamId: string;
}): Promise<GraphChannel[]> {
  return await fetchGraphCollection<GraphChannel>({
    accessToken: params.accessToken,
    url: `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(params.teamId)}/channels?$select=id`,
  });
}

async function fetchGraphCollection<T>(params: { accessToken: string; url: string }): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | undefined = params.url;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        authorization: `Bearer ${params.accessToken}`,
      },
    });
    if (!response.ok) {
      throw new GraphRequestError(response.status, await response.text());
    }
    const body = (await response.json()) as {
      value?: T[];
      "@odata.nextLink"?: string;
    };
    items.push(...(body.value ?? []));
    nextUrl = body["@odata.nextLink"];
  }

  return items;
}
