/** Gateway-backed ACP session snapshots, controls, metadata, and usage updates. */
import type { SessionInfo, SessionUpdate } from "@agentclientprotocol/sdk";
import { toAcpSessionLineageMeta } from "@openclaw/acp-core/session-lineage-meta";
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeFastMode,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { GatewayClient } from "../gateway/client.js";
import type { GatewaySessionRow, SessionsListResult } from "../gateway/session-utils.js";
import {
  ACP_ELEVATED_LEVEL_CONFIG_ID,
  ACP_FAST_MODE_CONFIG_ID,
  ACP_REASONING_LEVEL_CONFIG_ID,
  ACP_RESPONSE_USAGE_CONFIG_ID,
  ACP_THOUGHT_LEVEL_CONFIG_ID,
  ACP_TIMEOUT_CONFIG_ID,
  ACP_TIMEOUT_SECONDS_CONFIG_ID,
  ACP_TRACE_LEVEL_CONFIG_ID,
  ACP_VERBOSE_LEVEL_CONFIG_ID,
  buildSessionMetadata,
  buildSessionPresentation,
  buildSessionUsageSnapshot,
  type GatewaySessionPresentationRow,
  type SessionSnapshot,
} from "./translator.presentation.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

const STRING_CONFIG_FIELDS = new Map<
  string,
  "thinkingLevel" | "verboseLevel" | "traceLevel" | "reasoningLevel" | "elevatedLevel"
>([
  [ACP_THOUGHT_LEVEL_CONFIG_ID, "thinkingLevel"],
  [ACP_VERBOSE_LEVEL_CONFIG_ID, "verboseLevel"],
  [ACP_TRACE_LEVEL_CONFIG_ID, "traceLevel"],
  [ACP_REASONING_LEVEL_CONFIG_ID, "reasoningLevel"],
  [ACP_ELEVATED_LEVEL_CONFIG_ID, "elevatedLevel"],
]);

export class AcpTranslatorSessionState {
  constructor(
    private readonly gateway: GatewayClient,
    private readonly sessionUpdates: AcpTranslatorSessionUpdates,
    private readonly log: (msg: string) => void,
  ) {}

  async getSnapshot(
    sessionKey: string,
    overrides?: Partial<GatewaySessionPresentationRow>,
  ): Promise<SessionSnapshot> {
    try {
      const row = await this.getGatewaySessionRow(sessionKey);
      return {
        ...buildSessionPresentation({ row, overrides }),
        metadata: buildSessionMetadata({ row, sessionKey }),
        usage: buildSessionUsageSnapshot(row),
      };
    } catch (err) {
      this.log(`session presentation fallback for ${sessionKey}: ${String(err)}`);
      return {
        ...buildSessionPresentation({ overrides }),
        metadata: buildSessionMetadata({ sessionKey }),
      };
    }
  }

  async getExistingSnapshot(sessionKey: string): Promise<SessionSnapshot> {
    const row = await this.getGatewaySessionRow(sessionKey);
    if (!row) {
      throw new Error(`Session ${sessionKey} not found`);
    }
    return {
      ...buildSessionPresentation({ row }),
      metadata: buildSessionMetadata({ row, sessionKey }),
      usage: buildSessionUsageSnapshot(row),
    };
  }

  mapGatewaySession(session: GatewaySessionRow, fallbackCwd: string): SessionInfo {
    const cwd =
      normalizeOptionalString(session.spawnedCwd) ??
      normalizeOptionalString(session.spawnedWorkspaceDir) ??
      fallbackCwd;
    return {
      sessionId: session.key,
      cwd,
      title: session.derivedTitle ?? session.displayName ?? session.label ?? session.key,
      updatedAt: timestampMsToIsoString(session.updatedAt),
      _meta: toAcpSessionLineageMeta(session),
    };
  }

  async sendSnapshotUpdate(
    session: { sessionId: string; sessionKey: string; ledgerSessionId?: string },
    sessionSnapshot: SessionSnapshot,
    options: { includeControls: boolean; record: boolean; runId?: string },
  ): Promise<void> {
    const emit = (update: SessionUpdate) =>
      this.sessionUpdates.emit({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        update,
      });
    if (options.includeControls) {
      await emit({
        sessionUpdate: "current_mode_update",
        currentModeId: sessionSnapshot.modes.currentModeId,
      });
      await emit({
        sessionUpdate: "config_option_update",
        configOptions: sessionSnapshot.configOptions,
      });
    }
    if (sessionSnapshot.metadata) {
      await emit({
        sessionUpdate: "session_info_update",
        ...sessionSnapshot.metadata,
      });
    }
    if (sessionSnapshot.usage) {
      await emit({
        sessionUpdate: "usage_update",
        used: sessionSnapshot.usage.used,
        size: sessionSnapshot.usage.size,
        _meta: {
          source: "gateway-session-store",
          approximate: true,
        },
      });
    }
  }

  resolveConfigPatch(
    configId: string,
    value: string | boolean,
  ): {
    overrides: Partial<GatewaySessionPresentationRow>;
    patch?: Record<string, string | boolean | null>;
  } {
    if (typeof value !== "string") {
      throw new Error(
        `ACP bridge does not support non-string session config option values for "${configId}".`,
      );
    }
    const field = STRING_CONFIG_FIELDS.get(configId);
    if (field) {
      const patch = { [field]: value };
      return { patch, overrides: patch };
    }
    switch (configId) {
      case ACP_FAST_MODE_CONFIG_ID: {
        const fastMode = normalizeFastMode(value);
        if (fastMode === undefined) {
          throw new Error(`Unsupported fast mode value: ${value}`);
        }
        return {
          patch: { fastMode },
          overrides: { fastMode },
        };
      }
      case ACP_RESPONSE_USAGE_CONFIG_ID: {
        const next = value === "inherit" ? null : value;
        return {
          patch: { responseUsage: next },
          overrides: { responseUsage: next as GatewaySessionPresentationRow["responseUsage"] },
        };
      }
      case ACP_TIMEOUT_CONFIG_ID:
      case ACP_TIMEOUT_SECONDS_CONFIG_ID:
        return {
          overrides: {},
        };
      default:
        throw new Error(`ACP bridge mode does not support session config option "${configId}".`);
    }
  }

  private async getGatewaySessionRow(
    sessionKey: string,
  ): Promise<GatewaySessionPresentationRow | undefined> {
    const result = await this.gateway.request<SessionsListResult>("sessions.list", {
      limit: 200,
      search: sessionKey,
      includeDerivedTitles: true,
    });
    return result.sessions.find((entry) => entry.key === sessionKey);
  }
}
