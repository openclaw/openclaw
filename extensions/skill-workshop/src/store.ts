import { createHash } from "node:crypto";
import path from "node:path";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { SkillProposal, SkillWorkshopStatus } from "./types.js";

type StoreFile = {
  version: 1;
  proposals: SkillProposal[];
  review?: SkillWorkshopReviewState;
};

type SkillWorkshopProposalEntry = {
  version: 1;
  workspaceKey: string;
  proposal: SkillProposal;
};

type SkillWorkshopReviewEntry = {
  version: 1;
  workspaceKey: string;
  review: SkillWorkshopReviewState;
};

type SkillWorkshopReviewState = {
  turnsSinceReview: number;
  toolCallsSinceReview: number;
  lastReviewAt?: number;
};

export const SKILL_WORKSHOP_PLUGIN_ID = "skill-workshop";
export const SKILL_WORKSHOP_PROPOSALS_NAMESPACE = "proposals";
export const SKILL_WORKSHOP_REVIEWS_NAMESPACE = "reviews";
const locks = new Map<string, Promise<void>>();

const proposalStore = createPluginStateKeyedStore<SkillWorkshopProposalEntry>(
  SKILL_WORKSHOP_PLUGIN_ID,
  {
    namespace: SKILL_WORKSHOP_PROPOSALS_NAMESPACE,
    maxEntries: 50_000,
  },
);

const reviewStore = createPluginStateKeyedStore<SkillWorkshopReviewEntry>(
  SKILL_WORKSHOP_PLUGIN_ID,
  {
    namespace: SKILL_WORKSHOP_REVIEWS_NAMESPACE,
    maxEntries: 10_000,
  },
);

export function resolveSkillWorkshopStoreKey(workspaceDir: string): string {
  return createHash("sha256").update(path.resolve(workspaceDir)).digest("hex").slice(0, 16);
}

export function buildSkillWorkshopProposalEntryKey(storeKey: string, proposalId: string): string {
  return `${storeKey}:${proposalId}`;
}

async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(
    key,
    previous.then(() => next),
  );
  await previous;
  try {
    return await task();
  } finally {
    release?.();
    if (locks.get(key) === next) {
      locks.delete(key);
    }
  }
}

function normalizeReviewState(
  value: Partial<SkillWorkshopReviewState> = {},
): SkillWorkshopReviewState {
  return {
    turnsSinceReview:
      typeof value.turnsSinceReview === "number" && Number.isFinite(value.turnsSinceReview)
        ? Math.max(0, Math.trunc(value.turnsSinceReview))
        : 0,
    toolCallsSinceReview:
      typeof value.toolCallsSinceReview === "number" && Number.isFinite(value.toolCallsSinceReview)
        ? Math.max(0, Math.trunc(value.toolCallsSinceReview))
        : 0,
    ...(typeof value.lastReviewAt === "number" && Number.isFinite(value.lastReviewAt)
      ? { lastReviewAt: value.lastReviewAt }
      : {}),
  };
}

function normalizeProposalEntry(value: unknown, storeKey: string): SkillProposal | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const entry = value as Partial<SkillWorkshopProposalEntry>;
  if (entry.version !== 1 || entry.workspaceKey !== storeKey) {
    return undefined;
  }
  const proposal = entry.proposal;
  if (!proposal || typeof proposal !== "object" || typeof proposal.id !== "string") {
    return undefined;
  }
  return proposal;
}

function normalizeReviewEntry(
  value: unknown,
  storeKey: string,
): SkillWorkshopReviewState | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const entry = value as Partial<SkillWorkshopReviewEntry>;
  if (entry.version !== 1 || entry.workspaceKey !== storeKey) {
    return undefined;
  }
  return normalizeReviewState(entry.review);
}

async function readStore(storeKey: string): Promise<StoreFile> {
  const proposals = (await proposalStore.entries())
    .map((entry) => normalizeProposalEntry(entry.value, storeKey))
    .filter((proposal): proposal is SkillProposal => Boolean(proposal))
    .toSorted((left, right) => right.createdAt - left.createdAt);
  const review = normalizeReviewEntry(await reviewStore.lookup(storeKey), storeKey);
  return {
    version: 1,
    proposals,
    ...(review ? { review } : {}),
  };
}

async function writeProposal(storeKey: string, proposal: SkillProposal): Promise<void> {
  await proposalStore.register(buildSkillWorkshopProposalEntryKey(storeKey, proposal.id), {
    version: 1,
    workspaceKey: storeKey,
    proposal,
  });
}

async function deleteProposal(storeKey: string, proposalId: string): Promise<void> {
  await proposalStore.delete(buildSkillWorkshopProposalEntryKey(storeKey, proposalId));
}

async function writeReview(storeKey: string, review: SkillWorkshopReviewState): Promise<void> {
  await reviewStore.register(storeKey, {
    version: 1,
    workspaceKey: storeKey,
    review,
  });
}

export class SkillWorkshopStore {
  private readonly storeKey: string;

  constructor(params: { workspaceDir: string }) {
    this.storeKey = resolveSkillWorkshopStoreKey(params.workspaceDir);
  }

  async list(status?: SkillWorkshopStatus): Promise<SkillProposal[]> {
    const file = await readStore(this.storeKey);
    const proposals = status
      ? file.proposals.filter((proposal) => proposal.status === status)
      : file.proposals;
    return proposals.toSorted((left, right) => right.createdAt - left.createdAt);
  }

  async get(id: string): Promise<SkillProposal | undefined> {
    return (await this.list()).find((proposal) => proposal.id === id);
  }

  async add(proposal: SkillProposal, maxPending: number): Promise<SkillProposal> {
    return await withLock(this.storeKey, async () => {
      const file = await readStore(this.storeKey);
      const duplicate = file.proposals.find(
        (item) =>
          (item.status === "pending" || item.status === "quarantined") &&
          item.skillName === proposal.skillName &&
          JSON.stringify(item.change) === JSON.stringify(proposal.change),
      );
      if (duplicate) {
        return duplicate;
      }
      await writeProposal(this.storeKey, proposal);
      const pending = [proposal, ...file.proposals]
        .filter((item) => item.status === "pending" || item.status === "quarantined")
        .toSorted((left, right) => right.createdAt - left.createdAt);
      for (const stale of pending.slice(Math.max(1, Math.trunc(maxPending)))) {
        await deleteProposal(this.storeKey, stale.id);
      }
      return proposal;
    });
  }

  async updateStatus(id: string, status: SkillWorkshopStatus): Promise<SkillProposal> {
    return await withLock(this.storeKey, async () => {
      const file = await readStore(this.storeKey);
      const index = file.proposals.findIndex((proposal) => proposal.id === id);
      if (index < 0) {
        throw new Error(`proposal not found: ${id}`);
      }
      const updated = { ...file.proposals[index], status, updatedAt: Date.now() };
      await writeProposal(this.storeKey, updated);
      return updated;
    });
  }

  async recordReviewTurn(toolCalls: number): Promise<SkillWorkshopReviewState> {
    return await withLock(this.storeKey, async () => {
      const file = await readStore(this.storeKey);
      const current = normalizeReviewState(file.review);
      const next = {
        ...current,
        turnsSinceReview: current.turnsSinceReview + 1,
        toolCallsSinceReview: current.toolCallsSinceReview + Math.max(0, Math.trunc(toolCalls)),
      };
      await writeReview(this.storeKey, next);
      return next;
    });
  }

  async markReviewed(): Promise<SkillWorkshopReviewState> {
    return await withLock(this.storeKey, async () => {
      const next = {
        turnsSinceReview: 0,
        toolCallsSinceReview: 0,
        lastReviewAt: Date.now(),
      };
      await writeReview(this.storeKey, next);
      return next;
    });
  }
}
