import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatType } from "../../channels/chat-type.js";
import { parseSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { readSessionEntrySummariesInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Context, Model } from "../../llm/types.js";
import {
  attachRuntimePromptMediaFacts,
  readRuntimePromptMediaFacts,
} from "../../media/media-facts.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../../sessions/session-id-resolution.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../agent-project-settings.js";
import { resolveBootstrapFilesForPreparation } from "../bootstrap-files.js";
import { resolveUserTimezone } from "../date-time.js";
import { buildBootstrapContextForFiles } from "../embedded-agent-helpers/bootstrap.js";
import { convertToLlm, convertToLlmWithBlockImages } from "../sessions/messages.js";
import { SessionManager } from "../sessions/session-manager.js";
import { buildConfiguredAgentSystemPrompt } from "../system-prompt-config.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";
import { isCurrentEmbeddedRunAttachment } from "./run-state.js";
import { normalizeMessagesForLlmBoundary } from "./run/attempt-llm-boundary.js";
import { applyRuntimeContextCarrierRetention } from "./run/runtime-context-prompt.js";
import { resolveActiveEmbeddedRunBySessionFile } from "./runs.js";
import {
  createToolResultPromptProjectionState,
  parseSystemPromptRouteKey,
} from "./session-prompt-state.js";
import { replayToolResultPromptProjections } from "./tool-result-projection-replay.js";
import { restoreCacheTtlToolResultProjections } from "./tool-result-truncation.js";

function matchesModelRoute(routeKey: unknown, model: Model): boolean {
  const route = parseSystemPromptRouteKey(routeKey);
  return (
    route?.provider === model.provider &&
    route.model === model.id &&
    route.api === model.api &&
    route.baseUrl === (model.baseUrl ?? null)
  );
}

/** Rebuild only when a fork is requested; the transcript and live attempt own history. */
export async function prepareEmbeddedSessionForkContext(params: {
  target: Pick<SessionTranscriptRuntimeTarget, "agentId" | "sessionId"> &
    Partial<Pick<SessionTranscriptRuntimeTarget, "sessionKey" | "storePath">>;
  sessionFile: string;
  model: Model;
  config?: OpenClawConfig;
  workspaceDir: string;
  agentId: string;
  agentDir: string;
  bootstrapUserProfileId?: string;
  chatType?: ChatType;
  accountId?: string;
  peerId?: string;
  directApiKey?: boolean;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<Context> {
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  // SQLite-backed runs register under the canonical key, not the legacy transcript path.
  const attachment = resolveActiveEmbeddedRunBySessionFile(
    params.target.sessionKey ?? params.sessionFile,
  );
  const live =
    attachment &&
    attachment.sessionId === params.target.sessionId &&
    attachment.agentId === params.agentId &&
    isCurrentEmbeddedRunAttachment(attachment)
      ? attachment.handle.readSessionForkContext?.()
      : undefined;
  if (
    live &&
    live.model.provider === params.model.provider &&
    live.model.id === params.model.id &&
    live.model.api === params.model.api &&
    live.model.baseUrl === params.model.baseUrl
  ) {
    const messages = normalizeMessagesForLlmBoundary(
      live.projectMessages?.(live.messages) ?? live.messages,
      {
        ...live.boundary,
        sessionVersion: live.sessionVersion,
      },
    );
    const cloned = structuredClone({
      systemPrompt: live.systemPrompt,
      tools: live.tools,
      messages,
    });
    // Structured clone omits the runtime media symbol; preserve its current owner facts.
    messages.forEach((message, index) => {
      const media = readRuntimePromptMediaFacts(message);
      if (media) {
        attachRuntimePromptMediaFacts(cloned.messages[index]!, structuredClone(media));
      }
    });
    const context: Context = {
      ...cloned,
      messages: convertToLlmWithBlockImages(cloned.messages, live.blockImages ?? false),
    };
    if (live.projectMessages) {
      context.messages = convertToLlm(live.projectMessages(context.messages));
    }
    applyRuntimeContextCarrierRetention(context.messages, live.boundary?.appendOnlyRuntimeContext);
    return context;
  }

  const marker = parseSqliteSessionFileMarker(params.sessionFile);
  const storePath =
    params.target.storePath ??
    (marker?.agentId === params.target.agentId && marker.sessionId === params.target.sessionId
      ? marker.storePath
      : undefined);
  if (!storePath) {
    throw new Error("Session fork requires an existing session transcript.");
  }
  let sessionKey = params.target.sessionKey;
  if (!sessionKey) {
    const matches = await readSessionEntrySummariesInWorker({
      agentId: params.target.agentId,
      storePath,
    });
    assertCurrent();
    sessionKey = resolvePreferredSessionKeyForSessionIdMatches(
      matches
        .filter(({ entry }) => entry.sessionId === params.target.sessionId)
        .map(({ sessionKey: key, entry }) => [key, entry]),
      params.target.sessionId,
    );
  }
  if (!sessionKey) {
    throw new Error("Session fork could not resolve the existing session transcript.");
  }
  const target = { ...params.target, storePath, sessionKey };
  const manager = await SessionManager.openModelContextAsync(target, {
    cwd: params.workspaceDir,
    signal: params.signal,
  });
  assertCurrent();
  const entries = manager.getBranch();
  const reader = prepareSessionTranscriptHydration(target, undefined, params.signal);
  const toolResultProjectionState = createToolResultPromptProjectionState();
  if (
    entries.some((entry) => entry.type === "custom" && entry.customType === "openclaw.cache-ttl")
  ) {
    const result = await reader.readMaintenance({
      operation: "custom-branch",
      leafEntryId: manager.getLeafId(),
      customType: "openclaw.cache-ttl",
    });
    reader.assertCurrent();
    assertCurrent();
    if (!result.events) {
      throw new Error("Session fork transcript changed while preparing its model context.");
    }
    const projections = new Map(
      result.events.filter(isIndexedSessionEntry).map((entry) => [entry.id, entry]),
    );
    // Model navigation retains pre-compaction ancestry and resets, but omits custom payloads.
    restoreCacheTtlToolResultProjections(
      toolResultProjectionState,
      entries.map((entry) => projections.get(entry.id) ?? entry),
    );
  }
  const markerIndex = entries.findLastIndex(
    (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
  );
  let checkpointEntry = entries[markerIndex];
  const version = manager.getTranscriptSnapshotVersion();
  if (checkpointEntry && version) {
    // The model view keeps custom-entry navigation only; hydrate this one owner's checkpoint.
    const result = await reader.readCurrentTurnEntry({
      entryId: checkpointEntry.id,
      version,
      includeEntry: true,
    });
    reader.assertCurrent();
    assertCurrent();
    if (isIndexedSessionEntry(result.event) && result.event.type === "custom") {
      checkpointEntry = result.event;
    }
  }
  const data = checkpointEntry?.type === "custom" ? checkpointEntry.data : undefined;
  const historyId =
    entries.findLast((entry) => entry.type === "compaction" || entry.type === "reset")?.id ?? null;
  const checkpoint =
    isRecord(data) &&
    matchesModelRoute(data.routeKey, params.model) &&
    data.historyId === historyId &&
    !entries.slice(markerIndex + 1).some((entry) => entry.type === "model_change")
      ? data
      : undefined;
  let tools: Context["tools"];
  if (Array.isArray(checkpoint?.tools)) {
    // SAFETY: session-prompt-state writes this route/history-matched list as tool definitions, never executors.
    tools = checkpoint.tools as Context["tools"];
  }
  // Updates to renderedPrefix are already appended to history; replay the stable prefix.
  let systemPrompt = typeof checkpoint?.prefix === "string" ? checkpoint.prefix : undefined;
  if (systemPrompt === undefined) {
    const bootstrapFiles = await resolveBootstrapFilesForPreparation({
      config: params.config,
      workspaceDir: params.workspaceDir,
      agentId: params.agentId,
      sessionId: params.target.sessionId,
      sessionKey,
      bootstrapUserProfileId: params.bootstrapUserProfileId,
      chatType: params.chatType,
    });
    assertCurrent();
    systemPrompt = buildConfiguredAgentSystemPrompt({
      config: params.config,
      workspaceDir: params.workspaceDir,
      agentId: params.agentId,
      tools,
      contextFiles: buildBootstrapContextForFiles(bootstrapFiles, params),
      runtimeInfo: {
        agentId: params.agentId,
        sessionId: params.target.sessionId,
        sessionKey,
        model: `${params.model.provider}/${params.model.id}`,
      },
    });
  }
  assertCurrent();
  const policy = resolveTranscriptPolicy({
    provider: params.model.provider,
    modelId: params.model.id,
    modelApi: params.model.api,
    model: params.model,
    config: params.config,
    workspaceDir: params.workspaceDir,
    directApiKey: params.directApiKey,
  });
  const settings = createPreparedEmbeddedAgentSettingsManager({
    sessionId: params.target.sessionId,
    cwd: params.workspaceDir,
    agentDir: params.agentDir,
    cfg: params.config,
  });
  let messages = convertToLlmWithBlockImages(
    normalizeMessagesForLlmBoundary(
      replayToolResultPromptProjections(
        limitHistoryTurns(
          manager.buildSessionContext().messages,
          getHistoryLimitFromSessionKey(sessionKey, params.config, {
            accountId: params.accountId,
            peerId: params.peerId,
            chatType: params.chatType,
          }),
        ),
        toolResultProjectionState,
      ),
      {
        sessionVersion: manager.getHeader()?.version,
        appendOnlyRuntimeContext: policy.appendOnlyRuntimeContext,
        inHistorySystemUpdates: policy.inHistorySystemUpdates,
        timezone: resolveUserTimezone(params.config?.agents?.defaults?.userTimezone),
      },
    ),
    settings.getBlockImages(),
  );
  messages = convertToLlm(replayToolResultPromptProjections(messages, toolResultProjectionState));
  applyRuntimeContextCarrierRetention(messages, policy.appendOnlyRuntimeContext);
  return { systemPrompt, tools, messages };
}
