import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { WorkboardStore, type PersistedWorkboardCard } from "./store.js";
import type { WorkboardCard } from "./types.js";

function contextOwner(ctx: OpenClawPluginToolContext | undefined): string {
  const record = (ctx ?? {}) as Record<string, unknown>;
  return (
    (typeof record.agentId === "string" && record.agentId) ||
    (typeof record.sessionKey === "string" && record.sessionKey) ||
    (typeof record.sessionId === "string" && record.sessionId) ||
    "agent"
  );
}

function canMutateCard(card: WorkboardCard, ownerId: string, token?: string): boolean {
  const claim = card.metadata?.claim;
  if (!claim) {
    return true;
  }
  return claim.ownerId === ownerId || (Boolean(token) && claim.token === token);
}

async function requireScopedCard(
  store: WorkboardStore,
  cardId: string,
  ownerId: string,
  token?: string,
): Promise<WorkboardCard> {
  const card = await store.get(cardId);
  if (!card) {
    throw new Error(`card not found: ${cardId}`);
  }
  if (!canMutateCard(card, ownerId, token)) {
    throw new Error(`card is claimed by ${card.metadata?.claim?.ownerId ?? "another agent"}.`);
  }
  return card;
}

function summarizeCard(card: WorkboardCard) {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    priority: card.priority,
    agentId: card.agentId,
    claim: card.metadata?.claim
      ? {
          ownerId: card.metadata.claim.ownerId,
          claimedAt: card.metadata.claim.claimedAt,
          lastHeartbeatAt: card.metadata.claim.lastHeartbeatAt,
          expiresAt: card.metadata.claim.expiresAt,
        }
      : undefined,
    diagnostics: card.metadata?.diagnostics,
    archivedAt: card.metadata?.archivedAt,
    updatedAt: card.updatedAt,
  };
}

function redactClaimToken(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  if (!claim) {
    return card;
  }
  return {
    ...card,
    metadata: {
      ...card.metadata,
      claim: {
        ...claim,
        token: "[redacted]",
      },
    },
  };
}

const CardIdSchema = Type.Object(
  {
    id: Type.String({ description: "Workboard card id." }),
    token: Type.Optional(Type.String({ description: "Claim token returned by workboard_claim." })),
  },
  { additionalProperties: false },
);

export function createWorkboardTools(params: {
  api: OpenClawPluginApi;
  context?: OpenClawPluginToolContext;
  store?: WorkboardStore;
}): AnyAgentTool[] {
  const store =
    params.store ??
    WorkboardStore.open((options) =>
      params.api.runtime.state.openKeyedStore<PersistedWorkboardCard>(options),
    );
  const ownerId = contextOwner(params.context);
  return [
    {
      name: "workboard_list",
      label: "Workboard List",
      description:
        "List Workboard cards with compact claim and diagnostic state. Use before choosing or routing board work.",
      parameters: Type.Object(
        {
          status: Type.Optional(Type.String({ description: "Optional card status filter." })),
          agentId: Type.Optional(Type.String({ description: "Optional agent id filter." })),
          limit: Type.Optional(
            Type.Number({ description: "Maximum cards to return. Default 50." }),
          ),
          refreshDiagnostics: Type.Optional(
            Type.Boolean({ description: "Refresh stored diagnostics before listing." }),
          ),
          includeArchived: Type.Optional(
            Type.Boolean({ description: "Include archived cards. Default false." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        if (record.refreshDiagnostics === true) {
          await store.refreshDiagnostics();
        }
        const status = typeof record.status === "string" ? record.status : undefined;
        const agentId = typeof record.agentId === "string" ? record.agentId : undefined;
        const limit =
          typeof record.limit === "number" && Number.isFinite(record.limit)
            ? Math.max(1, Math.min(200, Math.trunc(record.limit)))
            : 50;
        const cards = (await store.list())
          .filter((card) => record.includeArchived === true || !card.metadata?.archivedAt)
          .filter((card) => !status || card.status === status)
          .filter((card) => !agentId || card.agentId === agentId)
          .slice(0, limit)
          .map(summarizeCard);
        return jsonResult({ cards });
      },
    },
    {
      name: "workboard_read",
      label: "Workboard Read",
      description:
        "Read one Workboard card and return bounded worker context with notes, attempts, comments, proof, links, and diagnostics.",
      parameters: CardIdSchema,
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        const card = await store.get(id);
        if (!card) {
          throw new Error(`card not found: ${id}`);
        }
        return jsonResult({
          card: redactClaimToken(card),
          workerContext: await store.buildWorkerContext(id),
        });
      },
    },
    {
      name: "workboard_claim",
      label: "Workboard Claim",
      description:
        "Claim a Workboard card for this agent and move backlog/todo cards into running. Returns a claim token for heartbeats and release.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          ttlSeconds: Type.Optional(Type.Number({ description: "Claim TTL in seconds." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        const claimed = await store.claim(id, {
          ownerId,
          ttlSeconds: record.ttlSeconds,
        });
        return jsonResult({ ...claimed, card: redactClaimToken(claimed.card) });
      },
    },
    {
      name: "workboard_heartbeat",
      label: "Workboard Heartbeat",
      description:
        "Refresh this agent's Workboard claim heartbeat. Use during long-running card work so diagnostics do not mark it stale.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          token: Type.Optional(
            Type.String({ description: "Claim token returned by workboard_claim." }),
          ),
          note: Type.Optional(Type.String({ description: "Optional compact progress note." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult(
          redactClaimToken(
            await store.heartbeat(id, {
              ownerId,
              token: record.token,
              note: record.note,
            }),
          ),
        );
      },
    },
    {
      name: "workboard_release",
      label: "Workboard Release",
      description:
        "Release this agent's Workboard claim after finishing, pausing, or handing off card work.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          token: Type.Optional(
            Type.String({ description: "Claim token returned by workboard_claim." }),
          ),
          status: Type.Optional(
            Type.String({ description: "Optional next card status after release." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult(
          redactClaimToken(
            await store.releaseClaim(id, {
              ownerId,
              token: record.token,
              status: record.status,
            }),
          ),
        );
      },
    },
    {
      name: "workboard_comment",
      label: "Workboard Comment",
      description: "Append a compact comment to a Workboard card.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          body: Type.String({ description: "Comment body." }),
          token: Type.Optional(Type.String({ description: "Claim token for claimed cards." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult(
          redactClaimToken(
            await store.addComment(id, { body: record.body }, { ownerId, token: record.token }),
          ),
        );
      },
    },
    {
      name: "workboard_proof",
      label: "Workboard Proof",
      description:
        "Attach proof or artifact metadata to a Workboard card after running tests, checks, or producing screenshots/logs.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          status: Type.Optional(
            Type.String({ description: "passed, failed, skipped, or unknown." }),
          ),
          label: Type.Optional(Type.String({ description: "Proof label." })),
          command: Type.Optional(Type.String({ description: "Command or exact step run." })),
          url: Type.Optional(Type.String({ description: "Proof or artifact URL." })),
          note: Type.Optional(Type.String({ description: "Short proof note." })),
          artifactPath: Type.Optional(
            Type.String({ description: "Optional local artifact path." }),
          ),
          token: Type.Optional(Type.String({ description: "Claim token for claimed cards." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        const scope = { ownerId, token: record.token };
        const hasArtifact =
          (typeof record.artifactPath === "string" && record.artifactPath.trim() !== "") ||
          (typeof record.url === "string" && record.url.trim() !== "");
        const card = hasArtifact
          ? await store.addProofWithArtifact(
              id,
              record,
              {
                label: record.label,
                path: record.artifactPath,
                url: record.url,
              },
              scope,
            )
          : await store.addProof(id, record, scope);
        return jsonResult({ card: redactClaimToken(card) });
      },
    },
    {
      name: "workboard_unblock",
      label: "Workboard Unblock",
      description: "Move a blocked Workboard card back to todo after adding enough context.",
      parameters: CardIdSchema,
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult(
          redactClaimToken(await store.unblock(id, { ownerId, token: record.token })),
        );
      },
    },
  ];
}
