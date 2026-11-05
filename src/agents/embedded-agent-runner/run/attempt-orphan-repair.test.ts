// Orphan repair plans decide whether a persisted-but-unanswered user row must be
// rewound. A rewind publishes a leaf control, which marks the transcript index for
// a full rebuild, so the plan only removes the leaf when the text would otherwise
// be lost or duplicated in provider input.
import { describe, expect, it, vi } from "vitest";
import { resolveOrphanRepairPlan } from "./attempt-orphan-repair.js";

type OrphanRepairSessionManager = Parameters<typeof resolveOrphanRepairPlan>[0]["sessionManager"];

function createOrphanLeafManager(
  options: {
    orphanProvenance?: Record<string, unknown>;
    content?: string;
    excludeFromContext?: boolean;
  } = {},
): OrphanRepairSessionManager {
  const messageEntry = {
    id: "orphan-user",
    parentId: "previous-assistant",
    timestamp: "2026-11-05T00:00:00.000Z",
    type: "message",
    message: {
      role: "user",
      content: options.content ?? "orphan wake",
      timestamp: 1,
      ...(options.excludeFromContext ? { excludeFromContext: true } : {}),
      ...(options.orphanProvenance ? { provenance: options.orphanProvenance } : {}),
    },
  };
  return {
    getLeafEntry: () => messageEntry,
    getEntry: () => undefined,
    hasLoadedTranscriptTail: () => true,
    appendThinkingLevelChange: vi.fn(async () => "thinking-entry"),
    appendModelChange: vi.fn(async () => "model-entry"),
    appendCustomEntryAsync: vi.fn(async () => "custom-entry"),
    appendSessionInfoAsync: vi.fn(async () => "info-entry"),
    appendLabelChangeAsync: vi.fn(async () => "label-entry"),
  } as unknown as OrphanRepairSessionManager;
}

function planFor(
  sessionManager: OrphanRepairSessionManager,
  overrides?: Partial<{
    prompt: string;
    preserveLeaf: boolean;
    currentTurnPersisted: boolean;
  }>,
) {
  return resolveOrphanRepairPlan({
    sessionManager,
    prompt: "new request",
    preserveLeaf: false,
    currentTurnPersisted: false,
    ...overrides,
  });
}

describe("resolveOrphanRepairPlan", () => {
  it("keeps a merged external orphan leaf when this turn persists its own row", () => {
    const plan = planFor(createOrphanLeafManager());

    expect(plan?.removeLeaf).toBe(false);
    expect(plan?.durableLeafCarriesMergedText).toBe(true);
    expect(plan?.contextEnginePrompt).toContain("orphan wake");
    expect(plan?.contextEnginePrompt).toContain("new request");
  });

  it("keeps an explicitly external orphan leaf when its text is merged", () => {
    const plan = planFor(createOrphanLeafManager({ orphanProvenance: { kind: "external_user" } }));

    expect(plan?.removeLeaf).toBe(false);
    expect(plan?.durableLeafCarriesMergedText).toBe(true);
  });

  it.each([
    { kind: "inter_session", sourceTool: "subagent_announce" },
    { kind: "internal_system", sourceTool: "exec" },
    { kind: "realtime_voice", sourceChannel: "talk" },
  ])("still removes a non-chat orphan leaf for $kind", (orphanProvenance) => {
    const plan = planFor(createOrphanLeafManager({ orphanProvenance }));

    expect(plan?.removeLeaf).toBe(true);
    expect(plan?.durableLeafCarriesMergedText).toBe(false);
  });

  it("still removes an orphan leaf whose text cannot be merged", () => {
    const plan = planFor(createOrphanLeafManager({ content: "" }));

    expect(plan?.removeLeaf).toBe(true);
    expect(plan?.durableLeafCarriesMergedText).toBe(false);
  });

  it("still removes an orphan leaf that is excluded from the model context", () => {
    const plan = planFor(createOrphanLeafManager({ excludeFromContext: true }));

    expect(plan?.removeLeaf).toBe(true);
    expect(plan?.durableLeafCarriesMergedText).toBe(false);
  });

  it("still repairs a stale leaf when this turn already persisted its own row", () => {
    const plan = planFor(createOrphanLeafManager(), { currentTurnPersisted: true });

    expect(plan?.removeLeaf).toBe(true);
    expect(plan?.durableLeafCarriesMergedText).toBe(false);
  });

  it("leaves the internal-prompt preserve path untouched", () => {
    const plan = planFor(createOrphanLeafManager(), {
      prompt: "continue the current turn",
      preserveLeaf: true,
    });

    expect(plan?.removeLeaf).toBe(false);
    expect(plan?.durableLeafCarriesMergedText).toBe(false);
  });
});
