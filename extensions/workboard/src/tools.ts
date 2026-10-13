import { WORKBOARD_STATUSES, type WorkboardCard } from "@openclaw/workboard-contract";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { redactClaimToken } from "./card-redaction.js";
import { normalizeCappedStringList } from "./store-string-lists.js";
import type { WorkboardStore } from "./store.js";
import {
  cardIdField,
  claimTokenField,
  createWorkboardCardMutations,
  strictObject,
  workspaceField,
} from "./tools-card-mutations.js";
import { createWorkboardOrchestrationTools } from "./tools-orchestration.js";

function contextOwner(ctx: OpenClawPluginToolContext | undefined): string {
  return ctx?.agentId || ctx?.sessionKey || ctx?.sessionId || "agent";
}

function summarizeCard(card: WorkboardCard) {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    priority: card.priority,
    agentId: card.agentId,
    tenant: card.metadata?.automation?.tenant,
    boardId: card.metadata?.automation?.boardId ?? "default",
    parents: card.metadata?.links
      ?.filter((link) => link.type === "parent" && link.targetCardId)
      .map((link) => link.targetCardId),
    children: card.metadata?.links
      ?.filter((link) => link.type === "child" && link.targetCardId)
      .map((link) => link.targetCardId),
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

function redactedProofResult(card: WorkboardCard) {
  const proofId = card.metadata?.proof?.at(-1)?.id;
  if (!proofId) {
    throw new Error("proof was not retained in card metadata.");
  }
  return jsonResult({
    card: redactClaimToken(card),
    proofId,
  });
}

const ScopedClaimTokenField = claimTokenField("Claim token for claimed cards.");

const CardIdSchema = strictObject({
  id: cardIdField(),
  token: claimTokenField(),
});

export function createWorkboardTools(params: {
  context?: OpenClawPluginToolContext;
  store: WorkboardStore;
}): AnyAgentTool[] {
  const { store } = params;
  const ownerId = contextOwner(params.context);
  const { readScopedCardToolParams, scopedCardMutation, claimedCardMutation } =
    createWorkboardCardMutations(store, ownerId);
  const tools: AnyAgentTool[] = [
    {
      name: "workboard_list",
      label: "Workboard List",
      description:
        "List Workboard cards with compact claim and diagnostic state. Use before choosing or routing board work.",
      parameters: strictObject({
        status: Type.Optional(Type.String({ description: "Optional card status filter." })),
        agentId: Type.Optional(Type.String({ description: "Optional agent id filter." })),
        tenant: Type.Optional(Type.String({ description: "Optional tenant filter." })),
        boardId: Type.Optional(Type.String({ description: "Optional board id filter." })),
        limit: Type.Optional(Type.Number({ description: "Maximum cards to return. Default 50." })),
        refreshDiagnostics: Type.Optional(
          Type.Boolean({ description: "Refresh stored diagnostics before listing." }),
        ),
        includeArchived: Type.Optional(
          Type.Boolean({ description: "Include archived cards. Default false." }),
        ),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        if (record.refreshDiagnostics === true) {
          await store.refreshDiagnostics();
        }
        const status = typeof record.status === "string" ? record.status : undefined;
        const agentId = typeof record.agentId === "string" ? record.agentId : undefined;
        const tenant = typeof record.tenant === "string" ? record.tenant : undefined;
        const boardId = typeof record.boardId === "string" ? record.boardId : undefined;
        const limit = resolveIntegerOption(record.limit, 50, { min: 1, max: 200 });
        const cards = (await store.list({ boardId }))
          .filter((card) => record.includeArchived === true || !card.metadata?.archivedAt)
          .filter((card) => !status || card.status === status)
          .filter((card) => !agentId || card.agentId === agentId)
          .filter((card) => !tenant || card.metadata?.automation?.tenant === tenant)
          .slice(0, limit)
          .map(summarizeCard);
        return jsonResult({ cards });
      },
    },
    {
      name: "workboard_create",
      label: "Workboard Create",
      description:
        "Create a Workboard card, optionally with parent dependencies, tenant, skills, workspace, and key to prevent duplicate requests. Sessions boards do not hold cards; use workboard_sessions_board_read/update/move for them.",
      parameters: strictObject({
        title: Type.String({ description: "Card title." }),
        notes: Type.Optional(Type.String({ description: "Card notes or acceptance criteria." })),
        status: Type.Optional(Type.String({ description: "Initial status." })),
        priority: Type.Optional(Type.String({ description: "low, normal, high, or urgent." })),
        labels: Type.Optional(Type.Array(Type.String(), { description: "Card labels." })),
        agentId: Type.Optional(Type.String({ description: "Assigned agent id." })),
        parents: Type.Optional(Type.Array(Type.String(), { description: "Parent card ids." })),
        token: Type.Optional(Type.String({ description: "Claim token for claimed parent cards." })),
        tenant: Type.Optional(Type.String({ description: "Soft tenant namespace." })),
        boardId: Type.Optional(Type.String({ description: "Soft board namespace." })),
        createdByCardId: Type.Optional(
          Type.String({ description: "Parent card that created this card." }),
        ),
        idempotencyKey: Type.Optional(
          Type.String({
            description: "Reuse this key when retrying to avoid creating a duplicate card.",
          }),
        ),
        skills: Type.Optional(Type.Array(Type.String(), { description: "Suggested skills." })),
        workspace: workspaceField(),
        maxRuntimeSeconds: Type.Optional(Type.Number({ description: "Run timeout seconds." })),
        maxRetries: Type.Optional(Type.Number({ description: "Retry budget." })),
        scheduledAt: Type.Optional(Type.Number({ description: "Unix epoch milliseconds." })),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        normalizeCappedStringList(record.parents, "parents");
        return jsonResult({
          card: redactClaimToken(
            await store.create(record, { ownerId, token: record.token as string | undefined }),
          ),
        });
      },
    },
    {
      name: "workboard_link",
      label: "Workboard Link",
      description:
        "Link a parent card to a child card so the child becomes ready only after parents are done.",
      parameters: strictObject({
        parentId: Type.String({ description: "Parent card id." }),
        childId: Type.String({ description: "Child card id." }),
        token: Type.Optional(
          Type.String({ description: "Claim token for claimed parent or child cards." }),
        ),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const parentId = readStringParam(record, "parentId", { required: true });
        const childId = readStringParam(record, "childId", { required: true });
        const token = record.token as string | undefined;
        return jsonResult({
          card: redactClaimToken(await store.linkCards(parentId, childId, { ownerId, token })),
        });
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
      parameters: strictObject({
        id: cardIdField(),
        ttlSeconds: Type.Optional(Type.Number({ description: "Claim TTL in seconds." })),
      }),
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
      parameters: strictObject({
        id: cardIdField(),
        token: claimTokenField(),
        note: Type.Optional(Type.String({ description: "Optional compact progress note." })),
      }),
      execute: scopedCardMutation((id, record, scope) =>
        store.heartbeat(id, { ...scope, note: record.note }),
      ),
    },
    {
      name: "workboard_release",
      label: "Workboard Release",
      description:
        "Release this agent's Workboard claim after finishing, pausing, or handing off card work.",
      parameters: strictObject({
        id: cardIdField(),
        token: claimTokenField(),
        status: Type.Optional(
          Type.String({ description: "Optional next card status after release." }),
        ),
      }),
      execute: scopedCardMutation((id, record, scope) =>
        store.releaseClaim(id, { ...scope, status: record.status }),
      ),
    },
    {
      name: "workboard_comment",
      label: "Workboard Comment",
      description: "Append a compact comment to a Workboard card.",
      parameters: strictObject({
        id: cardIdField(),
        body: Type.String({ description: "Comment body." }),
        token: ScopedClaimTokenField,
      }),
      execute: scopedCardMutation((id, record, scope) =>
        store.addComment(id, { body: record.body }, scope),
      ),
    },
    {
      name: "workboard_proof",
      label: "Workboard Proof",
      description:
        "Attach proof or artifact metadata to a Workboard card after running tests, checks, or producing screenshots/logs. Returns proofId; pass it to workboard_complete when that call reports the terminal status for this proof.",
      parameters: strictObject({
        id: cardIdField(),
        status: Type.Optional(Type.String({ description: "passed, failed, skipped, or unknown." })),
        label: Type.Optional(Type.String({ description: "Proof label." })),
        command: Type.Optional(Type.String({ description: "Command or exact step run." })),
        url: Type.Optional(Type.String({ description: "Proof or artifact URL." })),
        note: Type.Optional(Type.String({ description: "Short proof note." })),
        artifactPath: Type.Optional(Type.String({ description: "Optional local artifact path." })),
        token: ScopedClaimTokenField,
      }),
      execute: async (_toolCallId, rawParams) => {
        const { record, id, scope } = await readScopedCardToolParams(rawParams);
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
        return redactedProofResult(card);
      },
    },
    {
      name: "workboard_complete",
      label: "Workboard Complete",
      description:
        "Complete a claimed Workboard card with a structured summary, proof, artifacts, and created-card manifest.",
      parameters: strictObject({
        id: cardIdField(),
        token: claimTokenField(),
        summary: Type.Optional(Type.String({ description: "Completion summary." })),
        proofId: Type.Optional(
          Type.String({
            description: "Proof id returned by workboard_proof when resolving that pending proof.",
          }),
        ),
        proof: Type.Optional(
          strictObject({
            status: Type.Optional(
              Type.String({ description: "passed, failed, skipped, or unknown." }),
            ),
            label: Type.Optional(Type.String({ description: "Proof label." })),
            command: Type.Optional(Type.String({ description: "Command or step run." })),
            url: Type.Optional(Type.String({ description: "Proof URL." })),
            note: Type.Optional(Type.String({ description: "Proof note." })),
          }),
        ),
        artifacts: Type.Optional(
          Type.Array(
            strictObject({
              label: Type.Optional(Type.String()),
              url: Type.Optional(Type.String()),
              path: Type.Optional(Type.String()),
              mimeType: Type.Optional(Type.String()),
            }),
          ),
        ),
        createdCardIds: Type.Optional(
          Type.Array(Type.String(), { description: "Cards created during this run." }),
        ),
      }),
      execute: claimedCardMutation((id, record, scope) => store.complete(id, record, scope)),
    },
    {
      name: "workboard_attachment_add",
      label: "Workboard Attachment Add",
      description:
        "Store a small Workboard attachment in plugin SQLite KV and link it to the card.",
      parameters: strictObject({
        id: cardIdField(),
        fileName: Type.String({ description: "Attachment file name." }),
        contentBase64: Type.String({ description: "Base64 attachment content." }),
        mimeType: Type.Optional(Type.String({ description: "Attachment MIME type." })),
        note: Type.Optional(Type.String({ description: "Optional attachment note." })),
        token: ScopedClaimTokenField,
      }),
      execute: scopedCardMutation((id, record, scope) =>
        store.addAttachment(id, record, scope, params.context?.assertInputCommitAllowed),
      ),
    },
    {
      name: "workboard_attachment_read",
      label: "Workboard Attachment Read",
      description: "Read one Workboard attachment from plugin SQLite KV.",
      parameters: strictObject({
        id: Type.String({ description: "Attachment id." }),
      }),
      execute: async (_toolCallId, rawParams) => {
        const id = readStringParam(rawParams as Record<string, unknown>, "id", {
          required: true,
        });
        const attachment = await store.getAttachment(id);
        if (!attachment) {
          throw new Error(`attachment not found: ${id}`);
        }
        return jsonResult(attachment);
      },
    },
    {
      name: "workboard_attachment_delete",
      label: "Workboard Attachment Delete",
      description: "Delete one Workboard attachment from plugin SQLite KV and the card index.",
      parameters: strictObject({
        id: cardIdField(),
        attachmentId: Type.String({ description: "Attachment id." }),
        token: ScopedClaimTokenField,
      }),
      execute: scopedCardMutation((id, record, scope) => {
        const attachmentId = readStringParam(record, "attachmentId", { required: true });
        return store.deleteAttachment(id, attachmentId, scope);
      }),
    },
    {
      name: "workboard_block",
      label: "Workboard Block",
      description: "Block a claimed Workboard card with a durable reason and release the claim.",
      parameters: strictObject({
        id: cardIdField(),
        token: claimTokenField(),
        reason: Type.Optional(Type.String({ description: "Blocker summary." })),
      }),
      execute: claimedCardMutation((id, record, scope) => store.block(id, record, scope)),
    },
    {
      name: "workboard_unblock",
      label: "Workboard Unblock",
      description: "Move a blocked Workboard card back to todo after adding enough context.",
      parameters: CardIdSchema,
      execute: scopedCardMutation((id, _record, scope) => store.unblock(id, scope)),
    },
    {
      name: "workboard_move",
      label: "Workboard Move",
      description:
        "Move a Workboard card to another status. Claimed cards require matching claim scope.",
      parameters: strictObject({
        id: cardIdField(),
        status: Type.Union(
          WORKBOARD_STATUSES.map((status) => Type.Literal(status)),
          { description: "Target Workboard status." },
        ),
        token: claimTokenField("Claim token for claimed cards."),
      }),
      execute: scopedCardMutation((id, record, scope) =>
        store.move(id, record.status, undefined, scope),
      ),
    },
    ...createWorkboardOrchestrationTools({ store, ownerId }),
  ];
  for (const tool of tools) {
    const execute = tool.execute;
    tool.execute = (...args) => store.runOperation(() => execute(...args));
  }
  return tools;
}
