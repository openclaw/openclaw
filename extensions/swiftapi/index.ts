import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type SwiftAPIConfig = {
  key: string;
  baseUrl?: string;
  failClosed?: boolean;
  attestTools?: string[];
  bypassTools?: string[];
  humanApprovedActionTypes?: string[];
  defaultHumanApproved?: boolean;
  strictActionTypeMapping?: boolean;
  attestMessageSending?: boolean;
};

type DerivedActionType = {
  actionType: string;
  toolAction?: string;
  mapped: boolean;
};

type ActionData = Record<string, unknown>;

const EXEC_RUNTIME_TOOLS = new Set([
  "exec",
  "bash",
  "process",
  "shell",
  "shell_command",
  "terminal",
]);
const FS_READ_TOOLS = new Set(["read", "glob", "grep"]);
const FS_WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);
const CONTROL_PLANE_TOOLS = new Set(["sessions_spawn", "sessions_send", "subagents", "gateway"]);

const CRON_READ_ACTIONS = new Set(["status", "list", "runs"]);
const CRON_MUTATION_ACTIONS = new Set(["add", "update", "remove", "run", "wake"]);

const MESSAGE_SEND_ACTIONS = new Set(["send", "reply", "thread-reply", "sendwitheffect", "poll"]);
const MESSAGE_BROADCAST_ACTIONS = new Set(["broadcast"]);
const MESSAGE_ATTACHMENT_ACTIONS = new Set([
  "sendattachment",
  "sticker",
  "sticker-upload",
  "emoji-upload",
]);
const MESSAGE_MODERATION_ACTIONS = new Set([
  "kick",
  "ban",
  "timeout",
  "removeparticipant",
  "addparticipant",
  "role-add",
  "role-remove",
  "channel-delete",
  "channel-edit",
  "topic-create",
]);
const MESSAGE_MUTATION_ACTIONS = new Set([
  "delete",
  "unsend",
  "pin",
  "unpin",
  "renamegroup",
  "setgroupicon",
  "channel-create",
  "channel-move",
  "category-create",
  "category-edit",
  "category-delete",
  "permissions",
]);

function normalizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function toLowerTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function deriveActionType(toolName: string, params: Record<string, unknown>): DerivedActionType {
  const normalizedTool = normalizeSegment(toolName);
  const toolActionRaw = toLowerTrimmedString(params.action);
  const toolAction = toolActionRaw ? normalizeSegment(toolActionRaw) : undefined;

  if (EXEC_RUNTIME_TOOLS.has(normalizedTool)) {
    return { actionType: "exec_runtime", toolAction, mapped: true };
  }

  if (FS_READ_TOOLS.has(normalizedTool)) {
    return { actionType: "fs_read", toolAction, mapped: true };
  }

  if (FS_WRITE_TOOLS.has(normalizedTool)) {
    return { actionType: "fs_write", toolAction, mapped: true };
  }

  if (CONTROL_PLANE_TOOLS.has(normalizedTool)) {
    return { actionType: "control_plane", toolAction, mapped: true };
  }

  if (normalizedTool === "cron") {
    if (toolAction && CRON_READ_ACTIONS.has(toolAction)) {
      return { actionType: "cron_read", toolAction, mapped: true };
    }
    if (toolAction && CRON_MUTATION_ACTIONS.has(toolAction)) {
      return { actionType: "cron_mutation", toolAction, mapped: true };
    }
    return { actionType: "cron_mutation", toolAction, mapped: false };
  }

  if (normalizedTool === "message") {
    if (!toolAction) {
      return { actionType: "message_send", mapped: true };
    }
    if (MESSAGE_BROADCAST_ACTIONS.has(toolAction)) {
      return { actionType: "message_broadcast", toolAction, mapped: true };
    }
    if (MESSAGE_ATTACHMENT_ACTIONS.has(toolAction)) {
      return { actionType: "message_attachment", toolAction, mapped: true };
    }
    if (MESSAGE_MODERATION_ACTIONS.has(toolAction)) {
      return { actionType: "message_moderation", toolAction, mapped: true };
    }
    if (MESSAGE_MUTATION_ACTIONS.has(toolAction)) {
      return { actionType: "message_mutation", toolAction, mapped: true };
    }
    if (MESSAGE_SEND_ACTIONS.has(toolAction)) {
      return { actionType: "message_send", toolAction, mapped: true };
    }
    return { actionType: "message_mutation", toolAction, mapped: false };
  }

  if (
    normalizedTool === "web_fetch" ||
    normalizedTool === "web_search" ||
    normalizedTool === "browser"
  ) {
    return { actionType: "network_egress", toolAction, mapped: true };
  }

  if (normalizedTool === "image" || normalizedTool === "tts") {
    return { actionType: "media_generation", toolAction, mapped: true };
  }

  return {
    actionType: `tool_${normalizeSegment(normalizedTool) || "unknown"}`,
    toolAction,
    mapped: false,
  };
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function actionTypeSet(values?: string[]): Set<string> {
  return new Set((values ?? []).map((entry) => normalizeSegment(entry)).filter(Boolean));
}

function buildActionData(params: {
  actionType: string;
  toolName: string;
  toolAction?: string;
  eventParams: Record<string, unknown>;
  agentId?: string;
  sessionKey?: string;
  defaultHumanApproved: boolean;
  humanApprovedActionTypes: Set<string>;
  strictActionType: boolean;
}): ActionData {
  const explicitHumanApproved =
    parseBoolean(params.eventParams.human_approved) ??
    parseBoolean(params.eventParams.humanApproved) ??
    undefined;

  const humanApproved =
    explicitHumanApproved ??
    (params.humanApprovedActionTypes.has(normalizeSegment(params.actionType))
      ? true
      : params.defaultHumanApproved);

  return {
    source: "openclaw_extension",
    agent_id: params.agentId ?? "unknown",
    session_key: params.sessionKey ?? "",
    tool_name: params.toolName,
    tool_action: params.toolAction ?? null,
    tool_params: params.eventParams,
    human_approved: humanApproved,
    strict_action_type: params.strictActionType,
  };
}

async function attestAction(params: {
  baseUrl: string;
  key: string;
  actionType: string;
  actionData: ActionData;
}): Promise<{ approved: boolean; denialReason?: string; status?: number; body?: string }> {
  if (!params.baseUrl.startsWith("https://")) {
    throw new Error("SwiftAPI baseUrl must use HTTPS to protect authority keys");
  }
  const res = await fetch(`${params.baseUrl}/attest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SwiftAPI-Authority": params.key,
    },
    body: JSON.stringify({
      action_type: params.actionType,
      action_data: params.actionData,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { approved: false, status: res.status, body };
  }

  const attestation = (await res.json().catch(() => null)) as {
    approved?: boolean;
    denial_reason?: string;
  } | null;

  if (attestation?.approved === false) {
    return {
      approved: false,
      denialReason: attestation.denial_reason ?? "policy violation",
    };
  }

  return { approved: true };
}

function deriveOutboundMessageActionType(params: {
  to: string;
  metadata?: Record<string, unknown>;
}): "message_send" | "message_broadcast" {
  const to = params.to.trim().toLowerCase();
  const metadata = params.metadata ?? {};

  const actionValue =
    toLowerTrimmedString(metadata.action) ?? toLowerTrimmedString(metadata.messageAction);
  if (actionValue && normalizeSegment(actionValue) === "broadcast") {
    return "message_broadcast";
  }

  if (metadata.broadcast === true || metadata.isBroadcast === true) {
    return "message_broadcast";
  }

  const targets = Array.isArray(metadata.targets) ? metadata.targets : undefined;
  if (targets && targets.length > 1) {
    return "message_broadcast";
  }

  if (
    to === "@all" ||
    to === "all" ||
    to === "broadcast" ||
    to === "*" ||
    to.startsWith("@all ") ||
    to.startsWith("broadcast:")
  ) {
    return "message_broadcast";
  }

  if (to.includes(",") || to.includes(";")) {
    return "message_broadcast";
  }

  return "message_send";
}

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as SwiftAPIConfig;

  if (!cfg.key) {
    api.logger.error("swiftapi: no authority key configured, plugin disabled");
    return;
  }

  const baseUrl = (cfg.baseUrl ?? "https://swiftapi.ai").replace(/\/$/, "");
  const failClosed = cfg.failClosed !== false;
  const strictActionTypeMapping = cfg.strictActionTypeMapping !== false;
  const attestMessageSending = cfg.attestMessageSending !== false;
  const defaultHumanApproved = cfg.defaultHumanApproved === true;

  const attestTools = cfg.attestTools?.length
    ? new Set(cfg.attestTools.map((entry) => normalizeSegment(entry)))
    : null;
  const bypassTools = new Set((cfg.bypassTools ?? []).map((entry) => normalizeSegment(entry)));
  const humanApprovedActionTypes = actionTypeSet(cfg.humanApprovedActionTypes);

  api.logger.info("swiftapi: attestation gate active");

  api.on(
    "before_tool_call",
    async (event, ctx) => {
      const normalizedTool = normalizeSegment(event.toolName);
      const eventParams = (event.params ?? {}) as Record<string, unknown>;

      if (bypassTools.has(normalizedTool)) {
        return;
      }

      if (attestTools && !attestTools.has(normalizedTool)) {
        return;
      }

      const derived = deriveActionType(event.toolName, eventParams);
      if (strictActionTypeMapping && !derived.mapped) {
        return {
          block: true,
          blockReason: `SwiftAPI: strict mapping blocked unmapped action type for tool '${event.toolName}'`,
        };
      }

      const actionData = buildActionData({
        actionType: derived.actionType,
        toolName: event.toolName,
        toolAction: derived.toolAction,
        eventParams,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        defaultHumanApproved,
        humanApprovedActionTypes,
        strictActionType: strictActionTypeMapping,
      });

      try {
        const result = await attestAction({
          baseUrl,
          key: cfg.key,
          actionType: derived.actionType,
          actionData,
        });

        if (!result.approved) {
          if (result.status) {
            return {
              block: true,
              blockReason:
                `SwiftAPI: attestation denied (${result.status}). ${result.body ?? ""}`.trim(),
            };
          }
          return {
            block: true,
            blockReason: `SwiftAPI: action denied — ${result.denialReason ?? "policy violation"}`,
          };
        }

        return;
      } catch (err) {
        if (failClosed) {
          api.logger.error(`swiftapi: attestation failed: ${String(err)}`);
          return {
            block: true,
            blockReason: "SwiftAPI: attestation service unavailable (fail-closed mode)",
          };
        }
        api.logger.warn(`swiftapi: attestation check failed, fail-open: ${String(err)}`);
        return;
      }
    },
    { priority: 100 },
  );

  if (attestMessageSending) {
    api.on("message_sending", async (event, ctx) => {
      const actionType = deriveOutboundMessageActionType({
        to: event.to ?? "",
        metadata: (event.metadata ?? {}) as Record<string, unknown>,
      });
      const actionData: ActionData = {
        source: "openclaw_extension",
        channel_id: ctx.channelId,
        account_id: ctx.accountId ?? null,
        conversation_id: ctx.conversationId ?? null,
        recipient: event.to,
        content_length: event.content.length,
        metadata: event.metadata ?? {},
        human_approved:
          humanApprovedActionTypes.has(actionType) ||
          humanApprovedActionTypes.has("message_send") ||
          defaultHumanApproved,
        strict_action_type: strictActionTypeMapping,
      };

      try {
        const result = await attestAction({
          baseUrl,
          key: cfg.key,
          actionType,
          actionData,
        });

        if (!result.approved) {
          const denialReason = result.status
            ? `attestation denied (${result.status})`
            : (result.denialReason ?? "policy violation");
          api.logger.warn(`swiftapi: outbound message blocked — ${denialReason}`);
          return { cancel: true };
        }
      } catch (err) {
        if (failClosed) {
          api.logger.warn(`swiftapi: outbound message blocked fail-closed: ${String(err)}`);
          return { cancel: true };
        }
        api.logger.warn(`swiftapi: outbound message attestation failed, fail-open: ${String(err)}`);
      }

      return;
    });
  }
}

export const __testing = {
  deriveActionType,
  deriveOutboundMessageActionType,
  normalizeSegment,
};
