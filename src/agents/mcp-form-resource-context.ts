import type {
  Question,
  QuestionRecord,
} from "../../packages/gateway-protocol/src/schema/questions.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { AgentHarnessUserInputQuestion } from "./harness/user-input-types.js";

type FormQuestionReservation = {
  fields: ReadonlyMap<string, AgentHarnessUserInputQuestion>;
  record?: QuestionRecord;
  isCurrent?: () => boolean;
};

/** A host-only capability supplied by the originating MCP request, never by RPC parameters. */
export type McpFormResourceOwner = {
  sessionKey: string;
  agentId: string;
  assertCurrent: () => void;
  questions: ReadonlyMap<string, AgentHarnessUserInputQuestion>;
  pending: Map<string, FormQuestionReservation>;
  dispose: () => void;
};
const owners = resolveGlobalMap<string, McpFormResourceOwner>(
  Symbol.for("openclaw.mcpFormResourceOwners"),
  (entries) => {
    // Disposal unregisters owners, so reset retires the set captured at admission.
    const pendingOwners = Array.from(entries.values());
    for (const owner of pendingOwners) {
      owner.dispose();
    }
    entries.clear();
  },
);

export function registerMcpFormResourceOwner(
  viewId: string,
  owner: McpFormResourceOwner,
): () => void {
  if (owners.has(viewId) || owners.size >= 128) {
    throw new Error("MCP form resource capacity exceeded");
  }
  owners.set(viewId, owner);
  return () => {
    if (owners.get(viewId) === owner) {
      owners.delete(viewId);
    }
  };
}

function resourceProjection(question: { resource?: unknown; options?: unknown }) {
  return JSON.stringify({ resource: question.resource, options: question.options });
}

/** Called by the existing question dispatch owner before it sends question.request. */
export function reserveMcpFormQuestion(params: {
  questionId: string;
  sessionKey: string;
  agentId?: string;
  questions: readonly AgentHarnessUserInputQuestion[];
}): () => void {
  const claimed: Array<{
    owner: McpFormResourceOwner;
    reservation: FormQuestionReservation;
  }> = [];
  try {
    const ids = new Set(
      params.questions.flatMap((question) =>
        question.resource?.viewId ? [question.resource.viewId] : [],
      ),
    );
    for (const viewId of ids) {
      const owner = owners.get(viewId);
      if (!owner || owner.sessionKey !== params.sessionKey || owner.agentId !== params.agentId) {
        throw new Error("MCP form origin is unavailable for this question");
      }
      owner.assertCurrent();
      if (owner.pending.has(params.questionId)) {
        throw new Error("MCP form question id is already reserved");
      }
      const fields = new Map<string, AgentHarnessUserInputQuestion>();
      for (const question of params.questions) {
        if (question.resource?.viewId !== viewId) {
          continue;
        }
        const expected = owner.questions.get(question.id);
        if (!expected || resourceProjection(expected) !== resourceProjection(question)) {
          throw new Error("MCP form question does not match its originating schema");
        }
        fields.set(question.id, expected);
      }
      const reservation: FormQuestionReservation = { fields };
      owner.pending.set(params.questionId, reservation);
      claimed.push({ owner, reservation });
    }
  } catch (error) {
    for (const { owner, reservation } of claimed) {
      if (owner.pending.get(params.questionId) === reservation) {
        owner.pending.delete(params.questionId);
      }
    }
    throw error;
  }
  return () => {
    for (const { owner, reservation } of claimed) {
      if (owner.pending.get(params.questionId) === reservation) {
        owner.pending.delete(params.questionId);
      }
    }
  };
}

/** Select only a host-reserved live record and its unchanged, compiler-owned resource field. */
export function requireMcpFormQuestion(params: {
  viewId: string;
  requestId: string;
  sessionKey: string;
  agentId: string;
  question: Question;
  record: QuestionRecord;
}): McpFormResourceOwner {
  const owner = owners.get(params.viewId);
  const reservation = owner?.pending.get(params.requestId);
  const field = reservation?.fields.get(params.question.questionId);
  if (
    !owner ||
    owner.sessionKey !== params.sessionKey ||
    owner.agentId !== params.agentId ||
    !field ||
    reservation?.record !== params.record ||
    reservation.isCurrent?.() !== true ||
    resourceProjection(field) !== resourceProjection(params.question)
  ) {
    throw new Error("MCP resource question is not bound to this origin");
  }
  owner.assertCurrent();
  return owner;
}

/** The pending-question owner attests its private entry once; public ID reuse cannot rebind it. */
export function bindMcpFormQuestionRecord(record: QuestionRecord, isCurrent: () => boolean): void {
  for (const question of record.questions) {
    const viewId = question.resource?.viewId;
    const owner = viewId ? owners.get(viewId) : undefined;
    const reservation = owner?.pending.get(record.id);
    if (
      !owner ||
      !reservation ||
      reservation.record ||
      owner.agentId !== record.agentId ||
      owner.sessionKey !== record.sessionKey
    ) {
      continue;
    }
    const matching = record.questions.filter((field) => field.resource?.viewId === viewId);
    if (
      matching.some((field) => {
        const expected = reservation.fields.get(field.questionId);
        return !expected || resourceProjection(expected) !== resourceProjection(field);
      })
    ) {
      continue;
    }
    reservation.record = record;
    reservation.isCurrent = isCurrent;
  }
}
