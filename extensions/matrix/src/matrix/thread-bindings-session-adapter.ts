import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveThreadBindingFarewellText,
  type SessionBindingAdapterV2,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import type { MatrixClient } from "./sdk.js";
import { sendMessageMatrix } from "./send.js";
import {
  listBindingsForAccount,
  resolveBindingKey,
  toSessionBindingRecord,
  type MatrixThreadBindingManagerV2,
  type MatrixThreadBindingRecord,
} from "./thread-bindings-shared.js";

export function sameBindingIncarnation(a: MatrixThreadBindingRecord, b: MatrixThreadBindingRecord) {
  return (
    resolveBindingKey(a) === resolveBindingKey(b) &&
    a.boundAt === b.boundAt &&
    a.targetSessionKey === b.targetSessionKey &&
    a.targetKind === b.targetKind
  );
}

function buildMatrixBindingIntroText(params: {
  metadata?: Record<string, unknown>;
  targetSessionKey: string;
}): string {
  const introText = normalizeOptionalString(params.metadata?.introText);
  if (introText) {
    return introText;
  }
  const label = normalizeOptionalString(params.metadata?.label);
  const agentId =
    normalizeOptionalString(params.metadata?.agentId) ||
    resolveAgentIdFromSessionKey(params.targetSessionKey);
  const base = label || agentId || "session";
  return `⚙️ ${base} session active. Messages here go directly to this session.`;
}

async function sendBindingMessage(params: {
  cfg: OpenClawConfig;
  client: MatrixClient;
  accountId: string;
  roomId: string;
  threadId?: string;
  text: string;
}): Promise<string | null> {
  const trimmed = params.text.trim();
  if (!trimmed) {
    return null;
  }
  const result = await sendMessageMatrix(`room:${params.roomId}`, trimmed, {
    cfg: params.cfg,
    client: params.client,
    accountId: params.accountId,
    ...(params.threadId ? { threadId: params.threadId } : {}),
  });
  return result.messageId || null;
}

async function sendFarewellMessage(params: {
  cfg: OpenClawConfig;
  client: MatrixClient;
  accountId: string;
  record: MatrixThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
  reason?: string;
}): Promise<void> {
  const roomId = params.record.parentConversationId ?? params.record.conversationId;
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? params.record.idleTimeoutMs
      : params.defaultIdleTimeoutMs;
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number" ? params.record.maxAgeMs : params.defaultMaxAgeMs;
  const farewellText = resolveThreadBindingFarewellText({
    reason: params.reason,
    idleTimeoutMs,
    maxAgeMs,
  });
  await sendBindingMessage({
    cfg: params.cfg,
    client: params.client,
    accountId: params.accountId,
    roomId,
    threadId:
      params.record.parentConversationId &&
      params.record.parentConversationId !== params.record.conversationId
        ? params.record.conversationId
        : undefined,
    text: farewellText,
  }).catch(() => {});
}

export function createMatrixSessionBindingAdapter(
  params: { cfg: OpenClawConfig; accountId: string; client: MatrixClient },
  {
    manager,
    defaults,
    committedBindings,
    assertManagerCurrent,
    assertAcceptingMutation,
    mutateBindings,
  }: {
    manager: MatrixThreadBindingManagerV2;
    defaults: { idleTimeoutMs: number; maxAgeMs: number };
    committedBindings: ReadonlyMap<string, MatrixThreadBindingRecord>;
    assertManagerCurrent: () => void;
    assertAcceptingMutation: () => void;
    mutateBindings: (
      prepare: (current: MatrixThreadBindingRecord[]) => MatrixThreadBindingRecord[] | null,
      assertInputCurrent?: () => void,
    ) => Promise<MatrixThreadBindingRecord[]>;
  },
) {
  const { removeBindingsAsync, touchBindingAsync } = manager;
  const unbindRecords = async (
    records: MatrixThreadBindingRecord[],
    reason: string | ((record: MatrixThreadBindingRecord) => string | undefined),
    onRemoved?: (record: MatrixThreadBindingRecord) => void,
  ) => {
    const removed = await removeBindingsAsync(records);
    if (removed.length === 0) {
      return [];
    }
    removed.forEach((record) => onRemoved?.(record));
    await Promise.all(
      removed.map((record) =>
        sendFarewellMessage({
          cfg: params.cfg,
          client: params.client,
          accountId: params.accountId,
          record,
          defaultIdleTimeoutMs: defaults.idleTimeoutMs,
          defaultMaxAgeMs: defaults.maxAgeMs,
          reason: typeof reason === "function" ? reason(record) : reason,
        }),
      ),
    );
    return removed.map((record) => toSessionBindingRecord(record, defaults));
  };

  const getCommittedBinding = (
    ref: Parameters<MatrixThreadBindingManagerV2["getByConversation"]>[0],
  ) => {
    assertManagerCurrent();
    return [...committedBindings.values()].find(
      (record) =>
        record.conversationId === ref.conversationId.trim() &&
        (!ref.parentConversationId ||
          record.parentConversationId === ref.parentConversationId.trim()),
    );
  };
  const projectCommittedBinding = (record: MatrixThreadBindingRecord) => {
    const observed = manager.getByConversation(record);
    // Only activity may precede persistence; binding ownership and policy stay committed.
    return toSessionBindingRecord(
      observed && sameBindingIncarnation(record, observed)
        ? { ...record, lastActivityAt: Math.max(record.lastActivityAt, observed.lastActivityAt) }
        : record,
      defaults,
    );
  };
  const sessionBindingAdapter: SessionBindingAdapterV2 = {
    version: 2,
    assertCurrent: assertManagerCurrent,
    channel: "matrix",
    accountId: params.accountId,
    capabilities: { placements: ["current", "child"], bindSupported: true, unbindSupported: true },
    bind: async (input) => {
      assertAcceptingMutation();
      input.assertCurrent?.();
      const conversationId = input.conversation.conversationId.trim();
      const parentConversationId = normalizeOptionalString(input.conversation.parentConversationId);
      const targetSessionKey = input.targetSessionKey.trim();
      if (!conversationId || !targetSessionKey) {
        return null;
      }

      let boundConversationId = conversationId;
      let boundParentConversationId = parentConversationId;
      const introText = buildMatrixBindingIntroText({
        metadata: input.metadata,
        targetSessionKey,
      });

      if (input.placement === "child") {
        const roomId = parentConversationId || conversationId;
        const rootEventId = await sendBindingMessage({
          cfg: params.cfg,
          client: params.client,
          accountId: params.accountId,
          roomId,
          text: introText,
        });
        assertManagerCurrent();
        if (!rootEventId) {
          return null;
        }
        boundConversationId = rootEventId;
        boundParentConversationId = roomId;
      }

      const now = Date.now();
      const record: MatrixThreadBindingRecord = {
        accountId: params.accountId,
        conversationId: boundConversationId,
        ...(boundParentConversationId ? { parentConversationId: boundParentConversationId } : {}),
        targetKind: input.targetKind === "subagent" ? "subagent" : "acp",
        targetSessionKey,
        agentId:
          normalizeOptionalString(input.metadata?.agentId) ??
          resolveSessionAgentIdStrict({ config: params.cfg, sessionKey: targetSessionKey }),
        label: normalizeOptionalString(input.metadata?.label) || undefined,
        boundBy: normalizeOptionalString(input.metadata?.boundBy) || "system",
        boundAt: now,
        lastActivityAt: now,
        idleTimeoutMs: defaults.idleTimeoutMs,
        maxAgeMs: defaults.maxAgeMs,
      };
      await mutateBindings(
        (current) => [
          ...current.filter((entry) => resolveBindingKey(entry) !== resolveBindingKey(record)),
          record,
        ],
        input.placement !== "child" ? input.assertCurrent : undefined,
      );
      assertManagerCurrent();

      if (input.placement === "current" && introText) {
        const roomId = boundParentConversationId || boundConversationId;
        const threadId =
          boundParentConversationId && boundParentConversationId !== boundConversationId
            ? boundConversationId
            : undefined;
        await sendBindingMessage({
          cfg: params.cfg,
          client: params.client,
          accountId: params.accountId,
          roomId,
          threadId,
          text: introText,
        }).catch(() => {});
      }

      return toSessionBindingRecord(record, defaults);
    },
    // Matrix reads its worker-hydrated owner projection; no SQLite runs here.
    listBySessionAsync: async (targetSessionKey) => {
      assertManagerCurrent();
      return [...committedBindings.values()]
        .filter((record) => record.targetSessionKey === targetSessionKey.trim())
        .map(projectCommittedBinding);
    },
    resolveByConversationAsync: async (ref) => {
      const record = getCommittedBinding(ref);
      return record ? projectCommittedBinding(record) : null;
    },
    inspectByConversationAsync: async (ref) => {
      const record = getCommittedBinding(ref);
      return record ? projectCommittedBinding(record) : null;
    },
    inspectByConversationsAsync: async (refs) => {
      const records = refs.map(getCommittedBinding);
      return {
        bindings: records.map((record) => (record ? projectCommittedBinding(record) : null)),
        assertCurrent: () => {
          assertManagerCurrent();
          if (refs.some((ref, index) => getCommittedBinding(ref) !== records[index])) {
            throw new Error("Matrix thread binding selection changed");
          }
        },
      };
    },
    touchAsync: touchBindingAsync,
    listBySession: (targetSessionKey) =>
      manager
        .listBySessionKey(targetSessionKey)
        .map((record) => toSessionBindingRecord(record, defaults)),
    resolveByConversation: (ref) => {
      const record = manager.getByConversation(ref);
      return record ? toSessionBindingRecord(record, defaults) : null;
    },
    touch: (bindingId, at) => {
      manager.touchBinding(bindingId, at);
    },
    unbind: async (input) => {
      assertManagerCurrent();
      return unbindRecords(
        listBindingsForAccount(params.accountId).filter((record) => {
          if (input.bindingId?.trim()) {
            return resolveBindingKey(record) === input.bindingId.trim();
          }
          if (input.targetSessionKey?.trim()) {
            return record.targetSessionKey === input.targetSessionKey.trim();
          }
          return false;
        }),
        input.reason,
      );
    },
  };

  return { sessionBindingAdapter, unbindRecords };
}
