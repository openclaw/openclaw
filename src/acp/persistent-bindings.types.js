import { createHash } from "node:crypto";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { sanitizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizeText } from "./normalize-text.js";
export { normalizeText } from "./normalize-text.js";
export function normalizeMode(value) {
    const raw = normalizeOptionalLowercaseString(value);
    return raw === "oneshot" ? "oneshot" : "persistent";
}
export function normalizeBindingConfig(raw) {
    if (!raw || typeof raw !== "object") {
        return {};
    }
    const shape = raw;
    const mode = normalizeText(shape.mode);
    return {
        mode: mode ? normalizeMode(mode) : undefined,
        cwd: normalizeText(shape.cwd),
        backend: normalizeText(shape.backend),
        label: normalizeText(shape.label),
    };
}
function buildBindingHash(params) {
    return createHash("sha256")
        .update(`${params.channel}:${params.accountId}:${params.conversationId}`)
        .digest("hex")
        .slice(0, 16);
}
export function buildConfiguredAcpSessionKey(spec) {
    const hash = buildBindingHash({
        channel: spec.channel,
        accountId: spec.accountId,
        conversationId: spec.conversationId,
    });
    return `agent:${sanitizeAgentId(spec.agentId)}:acp:binding:${spec.channel}:${spec.accountId}:${hash}`;
}
export function toConfiguredAcpBindingRecord(spec) {
    return {
        bindingId: `config:acp:${spec.channel}:${spec.accountId}:${spec.conversationId}`,
        targetSessionKey: buildConfiguredAcpSessionKey(spec),
        targetKind: "session",
        conversation: {
            channel: spec.channel,
            accountId: spec.accountId,
            conversationId: spec.conversationId,
            parentConversationId: spec.parentConversationId,
        },
        status: "active",
        boundAt: 0,
        metadata: {
            source: "config",
            mode: spec.mode,
            agentId: spec.agentId,
            ...(spec.acpAgentId ? { acpAgentId: spec.acpAgentId } : {}),
            label: spec.label,
            ...(spec.backend ? { backend: spec.backend } : {}),
            ...(spec.cwd ? { cwd: spec.cwd } : {}),
        },
    };
}
export function parseConfiguredAcpSessionKey(sessionKey) {
    const trimmed = sessionKey.trim();
    if (!trimmed.startsWith("agent:")) {
        return null;
    }
    const rest = trimmed.slice(trimmed.indexOf(":") + 1);
    const nextSeparator = rest.indexOf(":");
    if (nextSeparator === -1) {
        return null;
    }
    const tokens = rest.slice(nextSeparator + 1).split(":");
    if (tokens.length !== 5 || tokens[0] !== "acp" || tokens[1] !== "binding") {
        return null;
    }
    const channel = normalizeOptionalLowercaseString(tokens[2]);
    if (!channel) {
        return null;
    }
    return {
        channel: channel,
        accountId: normalizeAccountId(tokens[3] ?? "default"),
    };
}
export function resolveConfiguredAcpBindingSpecFromRecord(record) {
    if (record.targetKind !== "session") {
        return null;
    }
    const conversationId = record.conversation.conversationId.trim();
    if (!conversationId) {
        return null;
    }
    const agentId = normalizeText(record.metadata?.agentId) ??
        resolveAgentIdFromSessionKey(record.targetSessionKey);
    if (!agentId) {
        return null;
    }
    return {
        channel: record.conversation.channel,
        accountId: normalizeAccountId(record.conversation.accountId),
        conversationId,
        parentConversationId: normalizeText(record.conversation.parentConversationId),
        agentId,
        acpAgentId: normalizeText(record.metadata?.acpAgentId),
        mode: normalizeMode(record.metadata?.mode),
        cwd: normalizeText(record.metadata?.cwd),
        backend: normalizeText(record.metadata?.backend),
        label: normalizeText(record.metadata?.label),
    };
}
export function toResolvedConfiguredAcpBinding(record) {
    const spec = resolveConfiguredAcpBindingSpecFromRecord(record);
    if (!spec) {
        return null;
    }
    return {
        spec,
        record,
    };
}
