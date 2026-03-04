import type { Server } from "node:http";
import type { Request, Response } from "express";
import {
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  keepHttpServerTaskAlive,
  mergeAllowlist,
  summarizeMapping,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/msteams";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { formatUnknownError } from "./errors.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { registerMSTeamsHandlers, type MSTeamsActivityHandler } from "./monitor-handler.js";
import { createMSTeamsPollStoreFs, type MSTeamsPollStore } from "./polls.js";
import {
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { createMSTeamsAdapter, loadMSTeamsSdkWithAuth } from "./sdk.js";
import { resolveMSTeamsCredentials } from "./token.js";

export type MonitorMSTeamsOpts = {
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  conversationStore?: MSTeamsConversationStore;
  pollStore?: MSTeamsPollStore;
};

export type MonitorMSTeamsResult = {
  app: unknown;
  shutdown: () => Promise<void>;
};

const MSTEAMS_WEBHOOK_MAX_BODY_BYTES = DEFAULT_WEBHOOK_MAX_BODY_BYTES;
const MSTEAMS_WEBHOOK_INACTIVITY_TIMEOUT_MS = 30_000;
const MSTEAMS_WEBHOOK_REQUEST_TIMEOUT_MS = 30_000;
const MSTEAMS_WEBHOOK_HEADERS_TIMEOUT_MS = 15_000;

export type ApplyMSTeamsWebhookTimeoutsOpts = {
  inactivityTimeoutMs?: number;
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
};

export function applyMSTeamsWebhookTimeouts(
  httpServer: Server,
  opts?: ApplyMSTeamsWebhookTimeoutsOpts,
): void {
  const inactivityTimeoutMs = opts?.inactivityTimeoutMs ?? MSTEAMS_WEBHOOK_INACTIVITY_TIMEOUT_MS;
  const requestTimeoutMs = opts?.requestTimeoutMs ?? MSTEAMS_WEBHOOK_REQUEST_TIMEOUT_MS;
  const headersTimeoutMs = Math.min(
    opts?.headersTimeoutMs ?? MSTEAMS_WEBHOOK_HEADERS_TIMEOUT_MS,
    requestTimeoutMs,
  );

  httpServer.setTimeout(inactivityTimeoutMs);
  httpServer.requestTimeout = requestTimeoutMs;
  httpServer.headersTimeout = headersTimeoutMs;
}

/**
 * Attempt to repair a JSON string that contains invalid bare-backslash escape
 * sequences such as \p, \q, \c (not defined by RFC 8259).
 *
 * The repair regex uses alternation so that already-valid `\\` pairs are
 * consumed first and left untouched, while only lone bare-backslash escapes
 * are double-escaped.
 *
 * Examples:
 *   "\\q"  (valid JSON: literal \q)   → unchanged
 *   "\q"   (invalid JSON: bare \q)    → "\\q"
 *   "\\\q" (valid \\ + invalid \q)   → "\\\\q"
 */
const REPAIR_BARE_ESCAPE_RE = /(\\.)+|\\([^"\\/bfnrtu])/g;

function repairJsonEscapes(raw: string): string {
  return raw.replace(
    REPAIR_BARE_ESCAPE_RE,
    (match: string, _doubled: string | undefined, invalid: string | undefined) =>
      // If the invalid-escape group matched, repair it; otherwise leave \\\\ pairs untouched.
      invalid !== undefined ? "\\\\" + invalid : match,
  );
}

export async function monitorMSTeamsProvider(
  opts: MonitorMSTeamsOpts,
): Promise<MonitorMSTeamsResult> {
  const core = getMSTeamsRuntime();
  const log = core.logging.getChildLogger({ name: "msteams" });
  let cfg = opts.cfg;
  let msteamsCfg = cfg.channels?.msteams;
  if (!msteamsCfg?.enabled) {
    log.debug?.("msteams provider disabled");
    return { app: null, shutdown: async () => {} };
  }

  const creds = resolveMSTeamsCredentials(msteamsCfg);
  if (!creds) {
    log.error("msteams credentials not configured");
    return { app: null, shutdown: async () => {} };
  }
  const appId = creds.appId;

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  let allowFrom = msteamsCfg.allowFrom;
  let groupAllowFrom = msteamsCfg.groupAllowFrom;
  let teamsConfig = msteamsCfg.teams;

  const cleanAllowEntry = (entry: string) =>
    entry
      .replace(/^(msteams|teams):/i, "")
      .replace(/^user:/i, "")
      .trim();

  const resolveAllowlistUsers = async (label: string, entries: string[]) => {
    if (entries.length === 0) {
      return { additions: [], unresolved: [] };
    }
    const resolved = await resolveMSTeamsUserAllowlist({ cfg, entries });
    const additions: string[] = [];
    const unresolved: string[] = [];
    for (const entry of resolved) {
      if (entry.resolved && entry.id) {
        additions.push(entry.id);
      } else {
        unresolved.push(entry.input);
      }
    }
    const mapping = resolved
      .filter((entry) => entry.resolved && entry.id)
      .map((entry) => `${entry.input}\u2192${entry.id}`);
    summarizeMapping(label, mapping, unresolved, runtime);
    return { additions, unresolved };
  };

  try {
    const allowEntries =
      allowFrom
        ?.map((entry) => cleanAllowEntry(String(entry)))
        .filter((entry) => entry && entry !== "*") ?? [];
    if (allowEntries.length > 0) {
      const { additions } = await resolveAllowlistUsers("msteams users", allowEntries);
      allowFrom = mergeAllowlist({ existing: allowFrom, additions });
    }

    if (Array.isArray(groupAllowFrom) && groupAllowFrom.length > 0) {
      const groupEntries = groupAllowFrom
        .map((entry) => cleanAllowEntry(String(entry)))
        .filter((entry) => entry && entry !== "*");
      if (groupEntries.length > 0) {
        const { additions } = await resolveAllowlistUsers("msteams group users", groupEntries);
        groupAllowFrom = mergeAllowlist({ existing: groupAllowFrom, additions });
      }
    }

    if (teamsConfig && Object.keys(teamsConfig).length > 0) {
      const entries: Array<{ input: string; teamKey: string; channelKey?: string }> = [];
      for (const [teamKey, teamCfg] of Object.entries(teamsConfig)) {
        if (teamKey === "*") {
          continue;
        }
        const channels = teamCfg?.channels ?? {};
        const channelKeys = Object.keys(channels).filter((key) => key !== "*");
        if (channelKeys.length === 0) {
          entries.push({ input: teamKey, teamKey });
          continue;
        }
        for (const channelKey of channelKeys) {
          entries.push({
            input: `${teamKey}/${channelKey}`,
            teamKey,
            channelKey,
          });
        }
      }

      if (entries.length > 0) {
        const resolved = await resolveMSTeamsChannelAllowlist({
          cfg,
          entries: entries.map((entry) => entry.input),
        });
        const mapping: string[] = [];
        const unresolved: string[] = [];
        const nextTeams = { ...teamsConfig };

        resolved.forEach((entry, idx) => {
          const source = entries[idx];
          if (!source) {
            return;
          }
          const sourceTeam = teamsConfig?.[source.teamKey] ?? {};
          if (!entry.resolved || !entry.teamId) {
            unresolved.push(entry.input);
            return;
          }
          mapping.push(
            entry.channelId
              ? `${entry.input}\u2192${entry.teamId}/${entry.channelId}`
              : `${entry.input}\u2192${entry.teamId}`,
          );
          const existing = nextTeams[entry.teamId] ?? {};
          const mergedChannels = {
            ...sourceTeam.channels,
            ...existing.channels,
          };
          const mergedTeam = { ...sourceTeam, ...existing, channels: mergedChannels };
          nextTeams[entry.teamId] = mergedTeam;
          if (source.channelKey && entry.channelId) {
            const sourceChannel = sourceTeam.channels?.[source.channelKey];
            if (sourceChannel) {
              nextTeams[entry.teamId] = {
                ...mergedTeam,
                channels: {
                  ...mergedChannels,
                  [entry.channelId]: {
                    ...sourceChannel,
                    ...mergedChannels?.[entry.channelId],
                  },
                },
              };
            }
          }
        });

        teamsConfig = nextTeams;
        summarizeMapping("msteams channels", mapping, unresolved, runtime);
      }
    }
  } catch (err) {
    runtime.log?.(`msteams resolve failed; using config entries. ${String(err)}`);
  }

  msteamsCfg = {
    ...msteamsCfg,
    allowFrom,
    groupAllowFrom,
    teams: teamsConfig,
  };
  cfg = {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: msteamsCfg,
    },
  };

  const port = msteamsCfg.webhook?.port ?? 3978;
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "msteams");
  const MB = 1024 * 1024;
  const agentDefaults = cfg.agents?.defaults;
  const mediaMaxBytes =
    typeof agentDefaults?.mediaMaxMb === "number" && agentDefaults.mediaMaxMb > 0
      ? Math.floor(agentDefaults.mediaMaxMb * MB)
      : 8 * MB;
  const conversationStore = opts.conversationStore ?? createMSTeamsConversationStoreFs();
  const pollStore = opts.pollStore ?? createMSTeamsPollStoreFs();

  log.info(`starting provider (port ${port})`);

  const express = await import("express");

  const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
  const { ActivityHandler, MsalTokenProvider, authorizeJWT } = sdk;

  const tokenProvider = new MsalTokenProvider(authConfig);
  const adapter = createMSTeamsAdapter(authConfig, sdk);

  const handler = registerMSTeamsHandlers(new ActivityHandler() as MSTeamsActivityHandler, {
    cfg,
    runtime,
    appId,
    adapter: adapter as unknown as MSTeamsAdapter,
    tokenProvider,
    textLimit,
    mediaMaxBytes,
    conversationStore,
    pollStore,
    log,
  });

  const expressApp = express.default();

  // Use raw body parser so we can repair invalid JSON escape sequences that some
  // Bot Framework clients include in activity payloads (e.g. conversationUpdate
  // activities with bare backslashes like \p or \q that are not valid per RFC 8259).
  // The strict express.json() parser throws SyntaxError on such payloads, which
  // causes a non-200 response and puts Azure Bot Service into exponential backoff,
  // dropping all subsequent messages until the backoff window expires.
  expressApp.use(express.raw({ type: "application/json", limit: MSTEAMS_WEBHOOK_MAX_BODY_BYTES }));
  expressApp.use((req: Request, _res: Response, next: (err?: unknown) => void) => {
    if (Buffer.isBuffer(req.body)) {
      const rawText = req.body.toString("utf-8");
      try {
        req.body = JSON.parse(rawText);
      } catch {
        // Attempt to repair invalid escape sequences.
        // IMPORTANT: the alternation /(\\)+|\([^...])/ consumes valid \\\\ pairs
        // first so that they are never misidentified as bare-backslash escapes.
        // See repairJsonEscapes() above for full explanation.
        const fixed = repairJsonEscapes(rawText);
        try {
          req.body = JSON.parse(fixed);
          log.warn("msteams: repaired invalid JSON escape sequences in Bot Framework activity");
        } catch (parseErr) {
          next(parseErr);
          return;
        }
      }
    }
    next();
  });
  expressApp.use((err: unknown, _req: Request, res: Response, next: (err?: unknown) => void) => {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 413) {
      res.status(413).json({ error: "Payload too large" });
      return;
    }
    if (err instanceof SyntaxError) {
      // JSON could not be repaired; acknowledge with HTTP 200 to prevent Azure
      // Bot Service from entering exponential backoff for an unrecoverable payload.
      log.error("msteams: unrecoverable JSON parse error in Bot Framework activity", {
        error: String(err),
      });
      res.status(200).end();
      return;
    }
    next(err);
  });
  expressApp.use(authorizeJWT(authConfig));

  const configuredPath = msteamsCfg.webhook?.path ?? "/api/messages";
  const messageHandler = (req: Request, res: Response) => {
    void adapter
      .process(req, res, (context: unknown) => handler.run!(context))
      .catch((err: unknown) => {
        log.error("msteams webhook failed", { error: formatUnknownError(err) });
      });
  };

  expressApp.post(configuredPath, messageHandler);
  if (configuredPath !== "/api/messages") {
    expressApp.post("/api/messages", messageHandler);
  }

  log.debug?.("listening on paths", {
    primary: configuredPath,
    fallback: "/api/messages",
  });

  const httpServer = expressApp.listen(port);
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      httpServer.off("error", onError);
      log.info(`msteams provider started on port ${port}`);
      resolve();
    };
    const onError = (err: unknown) => {
      httpServer.off("listening", onListening);
      log.error("msteams server error", { error: String(err) });
      reject(err);
    };
    httpServer.once("listening", onListening);
    httpServer.once("error", onError);
  });
  applyMSTeamsWebhookTimeouts(httpServer);

  httpServer.on("error", (err) => {
    log.error("msteams server error", { error: String(err) });
  });

  const shutdown = async () => {
    log.info("shutting down msteams provider");
    return new Promise<void>((resolve) => {
      httpServer.close((err) => {
        if (err) {
          log.debug?.("msteams server close error", { error: String(err) });
        }
        resolve();
      });
    });
  };

  await keepHttpServerTaskAlive({
    server: httpServer,
    abortSignal: opts.abortSignal,
    onAbort: shutdown,
  });

  return { app: expressApp, shutdown };
}
