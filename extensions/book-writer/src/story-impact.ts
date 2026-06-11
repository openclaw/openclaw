import crypto from "node:crypto";
import path from "node:path";
import { classifyEditImpact, type StoryImpactClass } from "./cohesion.js";
import type { ResolvedBookWriterConfig } from "./config.js";
import { resolveRunPaths, writeJsonFile } from "./files.js";
import type { BookPlan, BookPlanChapter, BookPlanChapterRole, BookPlanParagraph } from "./types.js";

type StoryImpactEvent = NonNullable<BookPlan["storyImpactEvents"]>[number];
type BookSync = NonNullable<BookPlan["bookSync"]>;
type StorylineOverview = NonNullable<BookPlan["storylineOverview"]>;

export type StoryImpactArtifacts = {
  impactReport: {
    schemaVersion: 1;
    runId: string;
    status: BookSync["state"];
    events: StoryImpactEvent[];
  };
  syncReport: {
    schemaVersion: 1;
    runId: string;
    sync: BookSync;
  };
  storylineOverview: StorylineOverview;
};

const TWIST_PATTERNS: Array<{ type: string; pattern: RegExp; system: string }> = [
  {
    type: "identity_reveal",
    pattern: /\b(really|actually|true identity|was not|is not)\b/i,
    system: "canon",
  },
  {
    type: "betrayal",
    pattern: /\b(betray|betrayed|traitor|double-cross|sold .* out)\b/i,
    system: "character_motivation",
  },
  {
    type: "hidden_motive",
    pattern: /\b(hidden motive|secretly|because .* secret|covering for)\b/i,
    system: "character_motivation",
  },
  {
    type: "false_memory",
    pattern: /\b(false memory|remembered wrong|memory was|never happened)\b/i,
    system: "timeline",
  },
  {
    type: "death_fakeout",
    pattern: /\b(faked .* death|not dead|alive all along|survived)\b/i,
    system: "timeline",
  },
  {
    type: "secret_relationship",
    pattern: /\b(sibling|brother|sister|father|mother|daughter|son|married|related)\b/i,
    system: "relationship",
  },
  {
    type: "villain_reveal",
    pattern: /\b(villain|culprit|mastermind|behind it all|responsible all along)\b/i,
    system: "ending",
  },
  {
    type: "unreliable_narrator",
    pattern: /\b(lied to you|unreliable|narrator lied|I lied|not the truth)\b/i,
    system: "chapter_logic",
  },
  {
    type: "world_rule_reversal",
    pattern: /\b(impossible|rule was wrong|world .* changed|law .* false)\b/i,
    system: "canon",
  },
  {
    type: "changed_ending",
    pattern: /\b(finally|in the end|ending|last page|resolution)\b/i,
    system: "ending",
  },
  {
    type: "new_clue",
    pattern: /\b(clue|evidence|signature|invoice|ledger|proof|payoff)\b/i,
    system: "foreshadowing",
  },
];

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function compact(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trim()}…`;
}

function allParagraphs(plan: BookPlan) {
  return plan.chapters.flatMap((chapter) =>
    chapter.paragraphs.map((paragraph) => ({ chapter, paragraph })),
  );
}

function changedParagraphs(previous: BookPlan | null, next: BookPlan) {
  if (!previous) {
    return [];
  }
  const previousText = new Map(
    allParagraphs(previous).map(({ paragraph }) => [
      paragraph.id,
      `${paragraph.title}\n${paragraph.summary}\n${paragraph.purpose}\n${paragraph.text}`,
    ]),
  );
  return allParagraphs(next).filter(({ paragraph }) => {
    const before = previousText.get(paragraph.id);
    return (
      before !== undefined &&
      before !== `${paragraph.title}\n${paragraph.summary}\n${paragraph.purpose}\n${paragraph.text}`
    );
  });
}

function inferImpact(text: string): { twistTypes: string[]; affectedSystems: string[] } {
  const matches = TWIST_PATTERNS.filter((entry) => entry.pattern.test(text));
  return {
    twistTypes: [...new Set(matches.map((entry) => entry.type))],
    affectedSystems: [...new Set(matches.map((entry) => entry.system))],
  };
}

function affectedChapters(
  plan: BookPlan,
  sourceChapter: BookPlanChapter,
  impactLevel: StoryImpactEvent["impactLevel"],
) {
  if (impactLevel === "whole-book") {
    return plan.chapters.map((chapter) => chapter.id);
  }
  if (impactLevel === "multi-chapter") {
    return plan.chapters
      .filter(
        (chapter) =>
          Math.abs(chapter.number - sourceChapter.number) <= 2 ||
          chapter.number === plan.chapters.length,
      )
      .map((chapter) => chapter.id);
  }
  if (impactLevel === "chapter") {
    return [sourceChapter.id];
  }
  return [];
}

function impactLevelFor(params: {
  text: string;
  twistTypes: string[];
  impactClass: StoryImpactClass;
  sourceChapter: BookPlanChapter;
  plan: BookPlan;
}): StoryImpactEvent["impactLevel"] {
  if (params.impactClass === "book") {
    return "whole-book";
  }
  if (params.impactClass === "chapter") {
    return "chapter";
  }
  if (params.impactClass === "scene") {
    return "chapter";
  }
  if (!params.twistTypes.length) {
    return params.text.length > 500 ? "chapter" : "none";
  }
  if (
    params.twistTypes.some((type) =>
      ["villain_reveal", "unreliable_narrator", "world_rule_reversal", "changed_ending"].includes(
        type,
      ),
    )
  ) {
    return "whole-book";
  }
  if (
    params.twistTypes.some((type) =>
      [
        "identity_reveal",
        "betrayal",
        "hidden_motive",
        "death_fakeout",
        "secret_relationship",
      ].includes(type),
    )
  ) {
    return "multi-chapter";
  }
  return params.sourceChapter.number === params.plan.chapters.length ? "chapter" : "multi-chapter";
}

function lockedConflictCount(plan: BookPlan, affectedChapterIds: string[]) {
  return plan.chapters
    .filter((chapter) => affectedChapterIds.includes(chapter.id))
    .flatMap((chapter) => chapter.paragraphs.map((paragraph) => ({ chapter, paragraph })))
    .filter(
      ({ chapter, paragraph }) => chapter.locked || paragraph.locked || paragraph.fieldLocks?.text,
    ).length;
}

export function buildStorylineOverview(
  plan: BookPlan,
  version: number,
  now: Date,
): StorylineOverview {
  const protagonist =
    plan.brief.topicParagraph.match(/\babout\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/)?.[1] ??
    "the protagonist";
  const currentTwist = plan.storyImpactEvents?.findLast((event) => event.status !== "dismissed");
  const conflict =
    plan.chapters.find((chapter) => chapter.role?.plotJob === "conflict")?.description ??
    plan.chapters[1]?.description ??
    plan.brief.readerPromise;
  const next =
    plan.chapters.find((chapter) => chapter.status !== "approved") ?? plan.chapters.at(-1);
  const mainStoryline = `${protagonist} wants ${plan.brief.readerPromise}, but ${conflict.toLowerCase()} creates a problem that threatens ${plan.brief.readerPromise}. The stakes are ${plan.brief.readerPromise}, and the story is moving toward ${
    plan.chapters.at(-1)?.description ?? "the final answer promised by the premise"
  }.`;
  return {
    status: "current",
    shortText: compact(
      `${mainStoryline} ${
        currentTwist
          ? `Current twist: ${currentTwist.editSummary}`
          : `The story direction follows ${compact(plan.brief.topicParagraph, 120)}`
      }.`,
      520,
    ),
    protagonistGoal: `${protagonist} must carry the main story goal established by the premise.`,
    centralConflict: conflict,
    currentTwist: currentTwist?.editSummary,
    stakes: plan.brief.readerPromise,
    relationshipDynamics: currentTwist?.twistTypes.includes("secret_relationship")
      ? ["A newly revealed relationship changes trust, motive, and emotional stakes."]
      : [],
    unresolvedQuestions: currentTwist
      ? [`How should ${currentTwist.editSummary.toLowerCase()} be foreshadowed and paid off?`]
      : ["What must each chapter change in the reader's knowledge or emotion?"],
    nextChapterDirection: next
      ? `Next, keep Chapter ${next.number} (${next.title}) aligned with: ${next.description}`
      : "Resolve the book promise cleanly.",
    sourceVersion: version,
    updatedAt: now.toISOString(),
    confidence: currentTwist ? 0.82 : 0.76,
  };
}

export function buildStoryImpactState(params: {
  previous: BookPlan | null;
  plan: BookPlan;
  version: number;
  now: Date;
  suppressDetection?: boolean;
}): Pick<BookPlan, "storyImpactEvents" | "bookSync" | "storylineOverview"> {
  const priorEvents = params.suppressDetection
    ? (params.plan.storyImpactEvents ?? params.previous?.storyImpactEvents ?? [])
    : (params.previous?.storyImpactEvents ?? params.plan.storyImpactEvents ?? []);
  const changes = params.suppressDetection ? [] : changedParagraphs(params.previous, params.plan);
  const newEvents = changes.flatMap(({ chapter, paragraph }) => {
    const text = `${paragraph.title} ${paragraph.summary} ${paragraph.purpose} ${paragraph.text}`;
    const impact = inferImpact(text);
    const impactClass = classifyEditImpact({
      nextText: text,
      changedField: "text",
    });
    const impactLevel = impactLevelFor({
      text,
      twistTypes: impact.twistTypes,
      impactClass,
      sourceChapter: chapter,
      plan: params.plan,
    });
    if (impactLevel === "none") {
      return [];
    }
    const affectedChapterIds = affectedChapters(params.plan, chapter, impactLevel);
    return [
      {
        id: `impact-${shortHash(`${params.plan.runId}:${params.version}:${paragraph.id}:${text}`)}`,
        createdAt: params.now.toISOString(),
        sourceVersion: params.version,
        sourceChapterId: chapter.id,
        sourceParagraphId: paragraph.id,
        editSummary: compact(
          paragraph.text || paragraph.summary || paragraph.purpose || paragraph.title,
          240,
        ),
        impactClass,
        impactLevel,
        twistTypes: impact.twistTypes.length ? impact.twistTypes : ["chapter_logic"],
        affectedSystems: impact.affectedSystems.length ? impact.affectedSystems : ["chapter_logic"],
        affectedChapterIds,
        status: "detected" as const,
      },
    ];
  });
  const storyImpactEvents = [...priorEvents, ...newEvents].slice(-50);
  const pending = storyImpactEvents.findLast((event) => event.status === "detected");
  const affectedChapterIds = pending?.affectedChapterIds ?? [];
  const affectedParagraphIds = pending
    ? allParagraphs(params.plan)
        .filter(({ chapter }) => affectedChapterIds.includes(chapter.id))
        .map(({ paragraph }) => paragraph.id)
    : [];
  const lockedConflicts = pending ? lockedConflictCount(params.plan, affectedChapterIds) : 0;
  const bookSync: BookSync =
    params.suppressDetection && params.plan.bookSync
      ? {
          ...params.plan.bookSync,
          lastAnalyzedVersion: params.version,
          lastSyncedVersion:
            params.plan.bookSync.state === "fully-updated"
              ? params.version
              : params.plan.bookSync.lastSyncedVersion,
        }
      : pending
        ? {
            state: lockedConflicts > 0 ? "locked-conflict-found" : "needs-propagation",
            pendingImpactId: pending.id,
            lastAnalyzedVersion: params.version,
            lastSyncedVersion: params.previous?.bookSync?.lastSyncedVersion,
            affectedChapterIds,
            affectedParagraphIds,
            lockedConflictCount: lockedConflicts,
            summary: `${pending.impactLevel} story impact detected: ${pending.twistTypes.join(", ")} across ${affectedChapterIds.length} chapter(s).`,
          }
        : {
            state: "synced",
            lastAnalyzedVersion: params.version,
            lastSyncedVersion: params.version,
            affectedChapterIds: [],
            affectedParagraphIds: [],
            lockedConflictCount: 0,
            cohesionScore: params.plan.qualityScore,
            summary: "Book plan, storyline overview, and cohesion artifacts are in sync.",
          };
  const storylineOverview = buildStorylineOverview(
    { ...params.plan, storyImpactEvents },
    params.version,
    params.now,
  );
  return { storyImpactEvents, bookSync, storylineOverview };
}

export type StoryPropagationPlan = {
  impactId: string;
  affectedChapterIds: string[];
  rewrittenParagraphIds: string[];
  preservedLockedParagraphIds: string[];
  summary: string;
};

function propagationInstruction(
  event: StoryImpactEvent,
  chapter: BookPlanChapter,
  paragraph: BookPlanParagraph,
): string {
  const beforeTwist = chapter.number < 3;
  const afterTwist = !event.sourceChapterId || chapter.id !== event.sourceChapterId;
  if (beforeTwist) {
    return `Foreshadow without revealing the twist: ${event.editSummary}`;
  }
  if (afterTwist) {
    return `Pay off the twist consequence: ${event.editSummary}`;
  }
  return `Bridge into and out of the twist cleanly: ${event.editSummary}`;
}

export function propagatePendingStoryImpact(plan: BookPlan): {
  plan: BookPlan;
  propagation: StoryPropagationPlan;
} {
  const pending = plan.storyImpactEvents?.findLast((event) => event.status === "detected");
  if (!pending) {
    throw new Error("no pending story impact to propagate.");
  }
  const affected = new Set(pending.affectedChapterIds);
  const rewrittenParagraphIds: string[] = [];
  const preservedLockedParagraphIds: string[] = [];
  const chapters = plan.chapters.map((chapter) => {
    if (!affected.has(chapter.id)) {
      return chapter;
    }
    if (chapter.locked) {
      preservedLockedParagraphIds.push(...chapter.paragraphs.map((paragraph) => paragraph.id));
      return chapter;
    }
    const plotJob: BookPlanChapterRole["plotJob"] =
      chapter.id === pending.sourceChapterId
        ? "twist"
        : chapter.number < 3
          ? "clue"
          : chapter.role?.plotJob === "payoff"
            ? "payoff"
            : (chapter.role?.plotJob ?? "conflict");
    return {
      ...chapter,
      description: chapter.fieldLocks?.description
        ? chapter.description
        : `${chapter.description} This chapter now supports the twist: ${pending.editSummary}`,
      role: chapter.role
        ? {
            ...chapter.role,
            plotJob,
            notes: [chapter.role.notes, `Story sync: ${pending.twistTypes.join(", ")}.`]
              .filter(Boolean)
              .join(" "),
          }
        : chapter.role,
      paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) => {
        if (paragraph.locked || paragraph.fieldLocks?.text) {
          preservedLockedParagraphIds.push(paragraph.id);
          return paragraph;
        }
        if (
          paragraphIndex > 1 &&
          chapter.id !== pending.sourceChapterId &&
          chapter.number !== plan.chapters.length
        ) {
          return paragraph;
        }
        rewrittenParagraphIds.push(paragraph.id);
        const instruction = propagationInstruction(pending, chapter, paragraph);
        return {
          ...paragraph,
          summary: paragraph.fieldLocks?.summary
            ? paragraph.summary
            : `${paragraph.summary} ${instruction}`,
          purpose: paragraph.fieldLocks?.purpose
            ? paragraph.purpose
            : `${paragraph.purpose} ${instruction}`,
          styleDirection: paragraph.fieldLocks?.styleDirection
            ? paragraph.styleDirection
            : [
                paragraph.styleDirection,
                "Keep the inserted twist coherent with prior setup and later payoff.",
              ]
                .filter(Boolean)
                .join(" "),
          text: paragraph.text.trim()
            ? `${paragraph.text.trim()}\n\n${storyImpactProseBridge(pending, chapter)}`
            : storyImpactProseBridge(pending, chapter),
          status: "drafted" as const,
          revisionStatus: "clean" as const,
          continuityObligations: [
            ...(paragraph.continuityObligations ?? []),
            `Story propagation for ${pending.twistTypes.join(", ")}: ${pending.editSummary}`,
          ],
        };
      }),
    };
  });
  const storyImpactEvents = (plan.storyImpactEvents ?? []).map((event) =>
    event.id === pending.id ? Object.assign({}, event, { status: "applied" as const }) : event,
  );
  const next: BookPlan = {
    ...plan,
    chapters,
    storyImpactEvents,
    bookSync: {
      state: preservedLockedParagraphIds.length ? "cohesion-review-needed" : "fully-updated",
      pendingImpactId: undefined,
      lastAnalyzedVersion: plan.version,
      lastSyncedVersion: plan.version,
      affectedChapterIds: pending.affectedChapterIds,
      affectedParagraphIds: rewrittenParagraphIds,
      lockedConflictCount: preservedLockedParagraphIds.length,
      cohesionScore: Math.max(0.85, plan.qualityScore ?? 0.85),
      summary: `Propagated ${pending.twistTypes.join(", ")} across ${pending.affectedChapterIds.length} chapter(s); rewrote ${rewrittenParagraphIds.length} editable paragraph(s).`,
    },
  };
  return {
    plan: next,
    propagation: {
      impactId: pending.id,
      affectedChapterIds: pending.affectedChapterIds,
      rewrittenParagraphIds,
      preservedLockedParagraphIds,
      summary: next.bookSync?.summary ?? "Story impact propagated.",
    },
  };
}

function storyImpactProseBridge(
  pending: StoryImpactEvent,
  chapter: BookPlan["chapters"][number],
): string {
  if (chapter.number < 3) {
    return "On the edge of awareness, one detail refused to settle, small enough to miss and sharp enough to matter later.";
  }
  if (chapter.id === pending.sourceChapterId) {
    return "Only then did the earlier signs rearrange themselves, turning what had seemed incidental into the hinge of the whole crisis.";
  }
  return "After that, every choice carried the weight of the reveal, and the story could not return to the world it had left behind.";
}

export function buildStoryImpactArtifacts(plan: BookPlan): StoryImpactArtifacts {
  const fallbackOverview =
    plan.storylineOverview ?? buildStorylineOverview(plan, plan.version, new Date(plan.updatedAt));
  const sync: BookSync = plan.bookSync ?? {
    state: "synced",
    lastAnalyzedVersion: plan.version,
    lastSyncedVersion: plan.version,
    affectedChapterIds: [],
    affectedParagraphIds: [],
    lockedConflictCount: 0,
    cohesionScore: plan.qualityScore,
    summary: "Book plan, storyline overview, and cohesion artifacts are in sync.",
  };
  return {
    impactReport: {
      schemaVersion: 1,
      runId: plan.runId,
      status: sync.state,
      events: plan.storyImpactEvents ?? [],
    },
    syncReport: {
      schemaVersion: 1,
      runId: plan.runId,
      sync,
    },
    storylineOverview: fallbackOverview,
  };
}

export async function writeStoryImpactArtifacts(
  config: ResolvedBookWriterConfig,
  plan: BookPlan,
): Promise<void> {
  const paths = resolveRunPaths(config.outputDir, plan.runId);
  const artifacts = buildStoryImpactArtifacts(plan);
  await writeJsonFile(path.join(paths.runDir, "story-impact-report.json"), artifacts.impactReport);
  await writeJsonFile(path.join(paths.runDir, "story-sync-report.json"), artifacts.syncReport);
  await writeJsonFile(
    path.join(paths.runDir, "storyline-overview.json"),
    artifacts.storylineOverview,
  );
}
