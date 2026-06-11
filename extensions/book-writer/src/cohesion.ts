import crypto from "node:crypto";
import path from "node:path";
import type { ResolvedBookWriterConfig } from "./config.js";
import { resolveRunPaths, writeJsonFile } from "./files.js";
import { countWords } from "./text.js";
import type { BookPlan, BookPlanChapter, BookPlanParagraph } from "./types.js";

export type BookCanon = {
  schemaVersion: 1;
  runId: string;
  title: string;
  premise: string;
  readerPromise: string;
  genre: string;
  audience: string;
  styleGuide: string;
  structuralSpine: string[];
  chapterContinuity: Array<{
    chapterId: string;
    number: number;
    title: string;
    role: string;
    continuityIn: string[];
    continuityOut: string[];
    themeMove: string;
    characterOrArgumentMove: string;
  }>;
  lockedConstraintIds: string[];
};

export type LockedConstraint = {
  id: string;
  chapterId: string;
  paragraphId: string;
  location: string;
  hash: string;
  excerpt: string;
  fixedFacts: string[];
  requiredSetup: string[];
  requiredConsequences: string[];
  styleSample: string;
  contradictions: string[];
  editableRepairInstructions: string[];
  userDecisionNeeded: boolean;
};

export type LockedConstraintMap = {
  schemaVersion: 1;
  runId: string;
  constraints: LockedConstraint[];
  contradictions: string[];
};

export type SceneGraph = {
  schemaVersion: 1;
  runId: string;
  nodes: Array<{
    id: string;
    chapterId: string;
    paragraphId: string;
    label: string;
    purpose: string;
    transitionIn: string;
    transitionOut: string;
    lockConstraintIds: string[];
  }>;
};

export type CohesionPlan = {
  schemaVersion: 1;
  runId: string;
  status: "planned";
  globalInstructions: string[];
  lockIntegrationInstructions: string[];
  chapterInstructions: Array<{
    chapterId: string;
    instructions: string[];
  }>;
};

export type StoryImpactClass = "local" | "scene" | "chapter" | "book";

export type HierarchicalBookMemory = {
  schemaVersion: 1;
  runId: string;
  updatedAtVersion: number;
  bookBible: {
    premise: string;
    genre: string;
    audience: string;
    tone: string;
    mainStoryline: string;
    storylineGoal: string;
    stakes: string;
    themes: string[];
    endingDirection: string;
  };
  characterBible: Array<{
    name: string;
    role: "protagonist" | "antagonist" | "supporting" | "unknown";
    goals: string[];
    motivations: string[];
    arc: string;
    state: string;
    evidence: string[];
  }>;
  timeline: Array<{
    order: number;
    chapterId: string;
    paragraphId?: string;
    event: string;
    consequence: string;
  }>;
  chapterMap: Array<{
    chapterId: string;
    number: number;
    title: string;
    purpose: string;
    summary: string;
    previousChapter?: string;
    nextChapter?: string;
    plotThreads: string[];
    setupPayoffNeeds: string[];
  }>;
  sceneMap: Array<{
    sceneId: string;
    chapterId: string;
    paragraphIds: string[];
    purpose: string;
    emotionalState: string;
    transitionIn: string;
    transitionOut: string;
  }>;
  styleGuide: {
    tone: string;
    proseRules: string[];
    profanityRule: string;
  };
  lockedTextMap: Array<{
    chapterId: string;
    paragraphId: string;
    exactText: string;
    hash: string;
    fixedFacts: string[];
    rules: string[];
  }>;
};

export type ParagraphContextPacket = {
  kind: "paragraph";
  userInstruction: string;
  selectedParagraph: {
    chapterId: string;
    paragraphId: string;
    order: number;
    plan: string;
    currentText: string;
  };
  previousParagraph?: string;
  nextParagraph?: string;
  scenePurpose: string;
  chapterPurpose: string;
  chapterSummary: string;
  bookPremise: string;
  mainStoryline: string;
  relevantCharacters: string[];
  relevantTimelineFacts: string[];
  styleGuide: string[];
  futureConsequences: string[];
  lockedTextRules: string[];
};

export type ChapterContextPacket = {
  kind: "chapter";
  userInstruction: string;
  chapter: {
    chapterId: string;
    number: number;
    title: string;
    purpose: string;
    text: string;
  };
  previousChapterSummary?: string;
  nextChapterSummary?: string;
  bookPremise: string;
  mainStoryline: string;
  actStructure: string[];
  characterArcs: string[];
  timeline: string[];
  unresolvedPlotThreads: string[];
  setupPayoffNeeds: string[];
  styleGuide: string[];
  lockedTextRules: string[];
};

export type CohesionScoreDimension =
  | "flow"
  | "sceneFit"
  | "chapterFit"
  | "bookFit"
  | "timeline"
  | "characterLogic"
  | "plotLogic"
  | "emotionalContinuity"
  | "style"
  | "clarity"
  | "pacing"
  | "lockedTextCompliance";

export type CohesionRubric = Record<CohesionScoreDimension, string>;

export type CohesionAuditScore = {
  schemaVersion: 1;
  status: "pass" | "revise-once" | "flag";
  scores: Record<CohesionScoreDimension, number>;
  minimumScore: number;
  issues: string[];
  revisionInstructions: string[];
};

export type BookQualityScore = {
  schemaVersion: 1;
  runId: string;
  overall: number;
  cohesion: number;
  lockedContentIntegration: number;
  styleConsistency: number;
  pacing: number;
  blockingIssues: string[];
  repairableIssues: string[];
};

export type RevisionMap = {
  schemaVersion: 1;
  runId: string;
  issues: Array<{
    chapterId: string;
    paragraphId: string;
    severity: "repairable" | "blocked";
    code: string;
    message: string;
    repair: string;
  }>;
};

export type CohesionArtifacts = {
  canon: BookCanon;
  memory: HierarchicalBookMemory;
  lockedConstraints: LockedConstraintMap;
  sceneGraph: SceneGraph;
  cohesionPlan: CohesionPlan;
  qualityScore: BookQualityScore;
  revisionMap: RevisionMap;
};

function shortHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function trimText(text: string, max = 320): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trim()}…`;
}

function isLockedParagraph(chapter: BookPlanChapter, paragraph: BookPlanParagraph): boolean {
  return chapter.locked || paragraph.locked || Boolean(paragraph.fieldLocks?.text);
}

function keywordFacts(text: string): string[] {
  const names = Array.from(new Set(text.match(/\b[A-Z][A-Za-z'’-]{2,}\b/g) ?? [])).slice(0, 6);
  const quoted = Array.from(new Set(text.match(/"[^"]{3,80}"/g) ?? [])).slice(0, 3);
  const facts = [
    names.length ? `Named entities fixed here: ${names.join(", ")}.` : "",
    quoted.length ? `Quoted language fixed here: ${quoted.join("; ")}.` : "",
    `Locked wording length is ${countWords(text)} words and must remain byte-for-byte unchanged.`,
  ].filter(Boolean);
  return facts.length ? facts : ["Locked text establishes local story truth."];
}

function contradictionHints(text: string): string[] {
  const lower = text.toLowerCase();
  const hints: string[] = [];
  if (/\bdead\b/.test(lower) && /\balive\b/.test(lower)) {
    hints.push(
      "Locked text contains both alive and dead state language; surrounding text must clarify timing.",
    );
  }
  if (/\byesterday\b/.test(lower) && /\btomorrow\b/.test(lower)) {
    hints.push("Locked text mixes relative dates; surrounding text must anchor chronology.");
  }
  return hints;
}

export function buildLockedConstraintMap(plan: BookPlan): LockedConstraintMap {
  const constraints: LockedConstraint[] = [];
  for (const chapter of plan.chapters) {
    for (const paragraph of chapter.paragraphs) {
      if (!isLockedParagraph(chapter, paragraph) || !paragraph.text.trim()) {
        continue;
      }
      const id = `lock-${shortHash(`${chapter.id}:${paragraph.id}:${paragraph.text}`)}`;
      const location = `Chapter ${chapter.number}, paragraph ${paragraph.order}`;
      constraints.push({
        id,
        chapterId: chapter.id,
        paragraphId: paragraph.id,
        location,
        hash: shortHash(paragraph.text),
        excerpt: trimText(paragraph.text),
        fixedFacts: keywordFacts(paragraph.text),
        requiredSetup: [
          `Before ${location}, prepare the reader for: ${trimText(paragraph.summary || paragraph.purpose || paragraph.title, 180)}`,
          "Keep character knowledge and emotional pressure compatible with the locked wording.",
        ],
        requiredConsequences: [
          `After ${location}, acknowledge the consequence of the locked moment instead of resetting the scene.`,
          "Use callbacks, reactions, or argument development that makes the locked block feel intentional.",
        ],
        styleSample: trimText(paragraph.text, 220),
        contradictions: contradictionHints(paragraph.text),
        editableRepairInstructions: [
          "Repair only unlocked neighboring paragraphs.",
          "Add lead-in/lead-out transitions around this locked block when drafting nearby text.",
        ],
        userDecisionNeeded: false,
      });
    }
  }
  return {
    schemaVersion: 1,
    runId: plan.runId,
    constraints,
    contradictions: constraints.flatMap((constraint) => constraint.contradictions),
  };
}

function chapterRole(chapter: BookPlanChapter): string {
  const role = chapter.role;
  if (!role) {
    return "Advance the book's main promise without repeating neighboring chapters.";
  }
  return [
    `thread=${role.storyThread}`,
    `job=${role.plotJob}`,
    `feeling=${role.readerFeeling}`,
    role.notes.trim() ? `notes=${role.notes.trim()}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function buildBookCanon(plan: BookPlan, locked: LockedConstraintMap): BookCanon {
  const styleGuide = plan.styleGuide
    ? `${plan.styleGuide.toneDescription} ${plan.styleGuide.profanityDescription}`
    : plan.brief.tone;
  return {
    schemaVersion: 1,
    runId: plan.runId,
    title: plan.title,
    premise: plan.brief.topicParagraph,
    readerPromise: plan.brief.readerPromise,
    genre: plan.genre,
    audience: plan.brief.audience,
    styleGuide,
    structuralSpine: plan.chapters.map(
      (chapter) =>
        `Chapter ${chapter.number} moves from ${trimText(chapter.description, 120)} toward ${trimText(
          chapter.paragraphs.at(-1)?.purpose || chapter.paragraphs.at(-1)?.summary || chapter.title,
          120,
        )}.`,
    ),
    chapterContinuity: plan.chapters.map((chapter, index) => ({
      chapterId: chapter.id,
      number: chapter.number,
      title: chapter.title,
      role: chapterRole(chapter),
      continuityIn:
        index === 0
          ? ["Open with the book promise and orient the reader immediately."]
          : [`Carry forward the consequence of Chapter ${plan.chapters[index - 1].number}.`],
      continuityOut:
        index === plan.chapters.length - 1
          ? ["Resolve the reader promise and close open loops."]
          : [`Create a clear reason Chapter ${plan.chapters[index + 1].number} must follow.`],
      themeMove: chapter.description,
      characterOrArgumentMove:
        chapter.paragraphs.find((paragraph) => paragraph.purpose.trim())?.purpose ??
        chapter.description,
    })),
    lockedConstraintIds: locked.constraints.map((constraint) => constraint.id),
  };
}

export function buildSceneGraph(plan: BookPlan, locked: LockedConstraintMap): SceneGraph {
  return {
    schemaVersion: 1,
    runId: plan.runId,
    nodes: plan.chapters.flatMap((chapter) =>
      chapter.paragraphs.map((paragraph) => {
        const lockConstraintIds = locked.constraints
          .filter((constraint) => constraint.paragraphId === paragraph.id)
          .map((constraint) => constraint.id);
        return {
          id: paragraph.sceneBeatId ?? `scene-${chapter.number}-${paragraph.order}`,
          chapterId: chapter.id,
          paragraphId: paragraph.id,
          label: paragraph.title,
          purpose: paragraph.summary || paragraph.purpose || paragraph.title,
          transitionIn:
            paragraph.transitionIn ??
            `Connect from the previous beat into ${trimText(paragraph.summary || paragraph.title, 120)}.`,
          transitionOut:
            paragraph.transitionOut ??
            `Leave a clear handoff from this beat toward the next beat or chapter.`,
          lockConstraintIds,
        };
      }),
    ),
  };
}

export function buildCohesionPlan(
  plan: BookPlan,
  canon: BookCanon,
  locked: LockedConstraintMap,
): CohesionPlan {
  return {
    schemaVersion: 1,
    runId: plan.runId,
    status: "planned",
    globalInstructions: [
      `Maintain one unified book promise: ${canon.readerPromise}.`,
      "Draft in scene/chapter context, then map prose back to paragraph cards.",
      "Avoid repeating chapter purposes; every chapter must change the reader's knowledge, emotion, or argument state.",
    ],
    lockIntegrationInstructions: locked.constraints.flatMap((constraint) => [
      `${constraint.location}: lead into locked text using its required setup.`,
      `${constraint.location}: continue afterward using its required consequences.`,
    ]),
    chapterInstructions: canon.chapterContinuity.map((chapter) => ({
      chapterId: chapter.chapterId,
      instructions: [
        ...chapter.continuityIn,
        `Chapter role: ${chapter.role}.`,
        `Theme/argument move: ${chapter.themeMove}.`,
        ...chapter.continuityOut,
      ],
    })),
  };
}

function sentenceParts(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function uniqueValues(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function inferProtagonist(plan: BookPlan): string {
  const topic = plan.brief.topicParagraph;
  return (
    topic.match(
      /\b(?:about|follows|with|named|name is)\s+([A-Z][A-Za-z'’-]{2,}(?:\s+[A-Z][A-Za-z'’-]{2,}){0,2})/,
    )?.[1] ??
    topic.match(/\b([A-Z][A-Za-z'’-]{2,})\s+(?:wants|must|needs|has to|tries)\b/)?.[1] ??
    "the protagonist"
  );
}

function inferConflict(plan: BookPlan): string {
  return (
    plan.brief.topicParagraph.match(/\bbut\s+([^.!?]{8,140})/i)?.[1] ??
    plan.chapters.find((chapter) => chapter.role?.plotJob === "conflict")?.description ??
    plan.chapters[1]?.description ??
    "the central opposition complicates the promise"
  );
}

function inferEndingDirection(plan: BookPlan): string {
  return (
    plan.brief.topicParagraph.match(
      /\b(?:ending|final|toward|moving toward)\s+(?:is|called|asks|where)?\s*([^.!?]{6,140})/i,
    )?.[1] ??
    plan.chapters.at(-1)?.description ??
    "a resolved answer to the book promise"
  );
}

export function mainStorylineText(plan: BookPlan): string {
  const protagonist = inferProtagonist(plan);
  const goal =
    plan.brief.topicParagraph.match(/\bwants?\s+([^,.!?;]{5,120})/i)?.[1] ??
    plan.brief.readerPromise;
  const conflict = inferConflict(plan);
  const stakes =
    plan.brief.topicParagraph.match(/\bstakes?\s+(?:are|is)\s+([^.!?]{5,140})/i)?.[1] ??
    plan.brief.readerPromise;
  const ending = inferEndingDirection(plan);
  return `${protagonist} wants ${goal}, but ${conflict} creates a problem that threatens ${stakes}. The stakes are ${stakes}, and the story is moving toward ${ending}.`;
}

function inferCharacters(plan: BookPlan): HierarchicalBookMemory["characterBible"] {
  const allText = [
    plan.brief.topicParagraph,
    ...plan.chapters.flatMap((chapter) => [
      chapter.title,
      chapter.description,
      ...chapter.paragraphs.flatMap((paragraph) => [
        paragraph.title,
        paragraph.summary,
        paragraph.purpose,
        paragraph.text,
      ]),
    ]),
  ].join(" ");
  const names = uniqueValues(
    allText.match(/\b[A-Z][A-Za-z'’-]{2,}(?:\s+[A-Z][A-Za-z'’-]{2,}){0,2}\b/g) ?? [],
    12,
  ).filter(
    (name) =>
      !["Chapter", "Book", "OpenClaw", "KDP", "Amazon", "Kindle", "Plan", "AI"].includes(name),
  );
  const protagonist = inferProtagonist(plan);
  return names.map((name, index) => ({
    name,
    role:
      name === protagonist || protagonist.includes(name)
        ? ("protagonist" as const)
        : index === 1 && /\b(villain|antagonist|culprit|monster|enemy|opposition)\b/i.test(allText)
          ? ("antagonist" as const)
          : ("unknown" as const),
    goals: [
      name === protagonist
        ? plan.brief.readerPromise
        : "Stay consistent with established story facts.",
    ],
    motivations: sentenceParts(plan.brief.topicParagraph).slice(0, 2),
    arc: `Track how ${name} changes knowledge, emotion, or leverage across chapters.`,
    state:
      "Use current chapter and paragraph context before changing this character's knowledge or emotion.",
    evidence: sentenceParts(allText)
      .filter((sentence) => sentence.includes(name))
      .slice(0, 3),
  }));
}

function styleRules(plan: BookPlan): string[] {
  return [
    "Every paragraph must serve its scene or argument beat.",
    "Every chapter must alter the reader's knowledge, emotion, stakes, or practical ability.",
    "Avoid reset language, repetitive openings, and detached summary.",
    "Preserve locked text exactly and repair contradictions in editable text first.",
    "Use concrete cause and effect so later chapters feel earned.",
    ...(plan.styleGuide?.toneDescription ? [`Voice: ${plan.styleGuide.toneDescription}`] : []),
    ...(plan.brief.constraints ?? []),
  ];
}

export function buildHierarchicalMemory(
  plan: BookPlan,
  locked: LockedConstraintMap = buildLockedConstraintMap(plan),
): HierarchicalBookMemory {
  const timeline = plan.chapters.flatMap((chapter) =>
    chapter.paragraphs.map((paragraph) => ({
      order: chapter.number * 100 + paragraph.order,
      chapterId: chapter.id,
      paragraphId: paragraph.id,
      event: trimText(paragraph.text || paragraph.summary || paragraph.purpose || paragraph.title),
      consequence:
        paragraph.transitionOut ??
        `Must lead into the next beat without contradicting Chapter ${chapter.number}.`,
    })),
  );
  const chapterMap = plan.chapters.map((chapter, index) => ({
    chapterId: chapter.id,
    number: chapter.number,
    title: chapter.title,
    purpose: chapter.description,
    summary: chapter.paragraphs
      .map((paragraph) => paragraph.text || paragraph.summary || paragraph.purpose)
      .filter(Boolean)
      .map((value) => trimText(value, 140))
      .join(" "),
    ...(index > 0
      ? {
          previousChapter: `Chapter ${plan.chapters[index - 1].number}: ${
            plan.chapters[index - 1].title
          }`,
        }
      : {}),
    ...(index + 1 < plan.chapters.length
      ? {
          nextChapter: `Chapter ${plan.chapters[index + 1].number}: ${
            plan.chapters[index + 1].title
          }`,
        }
      : {}),
    plotThreads: uniqueValues(
      [
        chapter.role?.storyThread ?? "main-story",
        chapter.role?.plotJob ?? "setup",
        ...(chapter.setupPayoffLinks ?? []),
      ],
      6,
    ),
    setupPayoffNeeds: uniqueValues(
      [
        ...(chapter.setupPayoffLinks ?? []),
        chapter.number === plan.chapters.length
          ? "Pay off the reader promise and close open loops."
          : "Set up a consequence the next chapter can use.",
      ],
      8,
    ),
  }));
  const sceneMap = plan.chapters.flatMap((chapter) =>
    chapter.paragraphs.map((paragraph) => ({
      sceneId: paragraph.sceneBeatId ?? `scene-${chapter.number}-${paragraph.order}`,
      chapterId: chapter.id,
      paragraphIds: [paragraph.id],
      purpose: paragraph.summary || paragraph.purpose || paragraph.title,
      emotionalState: chapter.role?.readerFeeling ?? "aligned",
      transitionIn:
        paragraph.transitionIn ??
        `Enter from the previous beat while preserving Chapter ${chapter.number}'s purpose.`,
      transitionOut:
        paragraph.transitionOut ??
        "Leave a concrete consequence for the following beat or chapter.",
    })),
  );
  return {
    schemaVersion: 1,
    runId: plan.runId,
    updatedAtVersion: plan.version,
    bookBible: {
      premise: plan.brief.topicParagraph,
      genre: plan.genre,
      audience: plan.brief.audience,
      tone: plan.styleGuide?.toneDescription ?? plan.brief.tone,
      mainStoryline: mainStorylineText(plan),
      storylineGoal: plan.brief.readerPromise,
      stakes: plan.brief.readerPromise,
      themes: uniqueValues(
        [
          ...plan.brief.constraints,
          ...plan.chapters.map((chapter) => chapter.themeMove ?? chapter.description),
        ],
        10,
      ),
      endingDirection: inferEndingDirection(plan),
    },
    characterBible: inferCharacters(plan),
    timeline,
    chapterMap,
    sceneMap,
    styleGuide: {
      tone: plan.styleGuide?.toneDescription ?? plan.brief.tone,
      proseRules: styleRules(plan),
      profanityRule:
        plan.styleGuide?.profanityDescription ?? "Follow the book's configured language rule.",
    },
    lockedTextMap: locked.constraints.map((constraint) => ({
      chapterId: constraint.chapterId,
      paragraphId: constraint.paragraphId,
      exactText:
        plan.chapters
          .find((chapter) => chapter.id === constraint.chapterId)
          ?.paragraphs.find((paragraph) => paragraph.id === constraint.paragraphId)?.text ?? "",
      hash: constraint.hash,
      fixedFacts: constraint.fixedFacts,
      rules: [
        "Never edit, paraphrase, reorder, shorten, or expand locked text unless the operator unlocks it.",
        "Resolve contradictions by changing editable text first.",
        ...constraint.editableRepairInstructions,
      ],
    })),
  };
}

function chapterText(chapter: BookPlanChapter): string {
  return chapter.paragraphs
    .map((paragraph) => paragraph.text)
    .filter(Boolean)
    .join("\n\n");
}

function relevantCharacterLines(memory: HierarchicalBookMemory, text: string): string[] {
  const lower = text.toLowerCase();
  const matches = memory.characterBible.filter(
    (character) => lower.includes(character.name.toLowerCase()) || character.role === "protagonist",
  );
  return (matches.length ? matches : memory.characterBible.slice(0, 3)).map(
    (character) =>
      `${character.name}: role=${character.role}; goals=${character.goals.join(" ")}; arc=${character.arc}; state=${character.state}`,
  );
}

function relevantTimelineLines(
  memory: HierarchicalBookMemory,
  chapterId: string,
  paragraphId?: string,
): string[] {
  const index = memory.timeline.findIndex((event) =>
    paragraphId ? event.paragraphId === paragraphId : event.chapterId === chapterId,
  );
  const window =
    index >= 0
      ? memory.timeline.slice(Math.max(0, index - 3), index + 5)
      : memory.timeline.slice(0, 8);
  return window.map(
    (event) => `Order ${event.order}: ${event.event} Consequence: ${event.consequence}`,
  );
}

function lockedRulesForPacket(
  memory: HierarchicalBookMemory,
  chapterId: string,
  paragraphId?: string,
): string[] {
  const exact = memory.lockedTextMap.filter((entry) =>
    paragraphId ? entry.paragraphId === paragraphId : entry.chapterId === chapterId,
  );
  const relevant = exact.length ? exact : memory.lockedTextMap.slice(0, 8);
  return relevant.length
    ? relevant.flatMap((entry) =>
        [
          `Locked ${entry.chapterId}/${entry.paragraphId} hash=${entry.hash}: ${trimText(entry.exactText, 180)}`,
        ].concat(entry.rules),
      )
    : [
        "No locked text is in the selected packet, but future locked text elsewhere remains immutable.",
      ];
}

export function buildParagraphContextPacket(params: {
  plan: BookPlan;
  chapter: BookPlanChapter;
  paragraph: BookPlanParagraph;
  previous?: BookPlanParagraph;
  next?: BookPlanParagraph;
  userInstruction?: string;
}): ParagraphContextPacket {
  const memory = buildHierarchicalMemory(params.plan);
  const scene =
    memory.sceneMap.find((node) => node.paragraphIds.includes(params.paragraph.id)) ??
    memory.sceneMap.find((node) => node.chapterId === params.chapter.id);
  const chapterMemory = memory.chapterMap.find(
    (chapter) => chapter.chapterId === params.chapter.id,
  );
  return {
    kind: "paragraph",
    userInstruction:
      params.userInstruction ??
      "Write or rewrite the selected paragraph so it improves cohesion without changing locked text.",
    selectedParagraph: {
      chapterId: params.chapter.id,
      paragraphId: params.paragraph.id,
      order: params.paragraph.order,
      plan: params.paragraph.summary || params.paragraph.purpose || params.paragraph.title,
      currentText: params.paragraph.text,
    },
    ...(params.previous
      ? {
          previousParagraph:
            params.previous.text || params.previous.summary || params.previous.purpose,
        }
      : {}),
    ...(params.next
      ? { nextParagraph: params.next.text || params.next.summary || params.next.purpose }
      : {}),
    scenePurpose: scene?.purpose ?? params.paragraph.purpose,
    chapterPurpose: chapterMemory?.purpose ?? params.chapter.description,
    chapterSummary: chapterMemory?.summary ?? params.chapter.description,
    bookPremise: memory.bookBible.premise,
    mainStoryline: memory.bookBible.mainStoryline,
    relevantCharacters: relevantCharacterLines(
      memory,
      `${params.paragraph.text} ${params.paragraph.summary} ${params.chapter.description}`,
    ),
    relevantTimelineFacts: relevantTimelineLines(memory, params.chapter.id, params.paragraph.id),
    styleGuide: memory.styleGuide.proseRules,
    futureConsequences: [
      scene?.transitionOut ?? "Maintain a consequence that the next paragraph can inherit.",
      chapterMemory?.nextChapter
        ? `Protect the handoff to ${chapterMemory.nextChapter}.`
        : "If this is the ending, resolve the reader promise.",
    ],
    lockedTextRules: lockedRulesForPacket(memory, params.chapter.id, params.paragraph.id),
  };
}

export function buildChapterContextPacket(params: {
  plan: BookPlan;
  chapter: BookPlanChapter;
  chapterIndex: number;
  userInstruction?: string;
}): ChapterContextPacket {
  const memory = buildHierarchicalMemory(params.plan);
  const chapterMemory = memory.chapterMap.find(
    (chapter) => chapter.chapterId === params.chapter.id,
  );
  return {
    kind: "chapter",
    userInstruction:
      params.userInstruction ??
      "Write or rewrite this chapter as one coherent movement that serves the whole book.",
    chapter: {
      chapterId: params.chapter.id,
      number: params.chapter.number,
      title: params.chapter.title,
      purpose: params.chapter.description,
      text: chapterText(params.chapter),
    },
    ...(params.chapterIndex > 0
      ? { previousChapterSummary: memory.chapterMap[params.chapterIndex - 1]?.summary }
      : {}),
    ...(params.chapterIndex + 1 < memory.chapterMap.length
      ? { nextChapterSummary: memory.chapterMap[params.chapterIndex + 1]?.summary }
      : {}),
    bookPremise: memory.bookBible.premise,
    mainStoryline: memory.bookBible.mainStoryline,
    actStructure: memory.chapterMap.map(
      (chapter) => `Chapter ${chapter.number}: ${chapter.title} — ${chapter.purpose}`,
    ),
    characterArcs: memory.characterBible.map(
      (character) => `${character.name}: ${character.arc}; state=${character.state}`,
    ),
    timeline: relevantTimelineLines(memory, params.chapter.id),
    unresolvedPlotThreads: uniqueValues(
      [
        ...(chapterMemory?.plotThreads ?? []),
        ...(params.plan.storylineOverview?.unresolvedQuestions ?? []),
      ],
      10,
    ),
    setupPayoffNeeds: chapterMemory?.setupPayoffNeeds ?? [
      "Create setup/payoff logic that serves the final chapter.",
    ],
    styleGuide: memory.styleGuide.proseRules,
    lockedTextRules: lockedRulesForPacket(memory, params.chapter.id),
  };
}

function formatList(label: string, values: string[]): string {
  return `${label}:\n${values.length ? values.map((value) => `- ${value}`).join("\n") : "- None."}`;
}

export const COHESION_RUBRIC: CohesionRubric = {
  flow: "Sentences and paragraphs move naturally from prior text to next text.",
  sceneFit: "The paragraph serves the scene purpose instead of becoming an isolated fragment.",
  chapterFit: "The text advances the chapter purpose, pacing, and transition duties.",
  bookFit: "The text supports the book premise, main storyline, themes, and ending direction.",
  timeline: "Events preserve chronology and cause/effect.",
  characterLogic: "Character goals, motivations, knowledge, emotion, and arcs stay consistent.",
  plotLogic: "Plot threads, reveals, setups, payoffs, and consequences remain coherent.",
  emotionalContinuity: "Emotional pressure changes for a clear reason and does not reset.",
  style: "Voice, tone, genre expectations, and prose rules stay consistent.",
  clarity: "The reader-facing output is clear, specific, and free of planning/meta language.",
  pacing: "The beat has the right weight and does not repeat or stall.",
  lockedTextCompliance:
    "Locked text is preserved exactly and contradictions are repaired in editable text.",
};

function packetContextLines(packet: ParagraphContextPacket | ChapterContextPacket): string[] {
  if (packet.kind === "paragraph") {
    return [
      `User instruction: ${packet.userInstruction}`,
      `Selected paragraph: ${packet.selectedParagraph.paragraphId}, order ${packet.selectedParagraph.order}`,
      `Paragraph plan: ${packet.selectedParagraph.plan}`,
      packet.selectedParagraph.currentText
        ? `Current text: ${packet.selectedParagraph.currentText}`
        : "Current text: blank.",
      packet.previousParagraph ? `Previous paragraph: ${packet.previousParagraph}` : "",
      packet.nextParagraph ? `Next paragraph: ${packet.nextParagraph}` : "",
      `Scene purpose: ${packet.scenePurpose}`,
      `Chapter purpose: ${packet.chapterPurpose}`,
      `Chapter summary: ${packet.chapterSummary}`,
      `Book premise: ${packet.bookPremise}`,
      `Main storyline tracker: ${packet.mainStoryline}`,
      formatList("Relevant characters", packet.relevantCharacters),
      formatList("Relevant timeline facts", packet.relevantTimelineFacts),
      formatList("Style guide", packet.styleGuide),
      formatList("Future consequences", packet.futureConsequences),
      formatList("Locked text rules", packet.lockedTextRules),
    ];
  }
  return [
    `User instruction: ${packet.userInstruction}`,
    `Chapter ${packet.chapter.number}: ${packet.chapter.title}`,
    `Chapter purpose: ${packet.chapter.purpose}`,
    packet.chapter.text
      ? `Current chapter text:\n${packet.chapter.text}`
      : "Current chapter text: blank.",
    packet.previousChapterSummary
      ? `Previous chapter summary: ${packet.previousChapterSummary}`
      : "",
    packet.nextChapterSummary ? `Next chapter summary: ${packet.nextChapterSummary}` : "",
    `Book premise: ${packet.bookPremise}`,
    `Main storyline tracker: ${packet.mainStoryline}`,
    formatList("Act structure", packet.actStructure),
    formatList("Character arcs", packet.characterArcs),
    formatList("Timeline", packet.timeline),
    formatList("Unresolved plot threads", packet.unresolvedPlotThreads),
    formatList("Setup/payoff needs", packet.setupPayoffNeeds),
    formatList("Style guide", packet.styleGuide),
    formatList("Locked text rules", packet.lockedTextRules),
  ];
}

function structuredPrompt(params: {
  title: string;
  task: string;
  context: string[];
  output: string;
}): string {
  return [
    "Expert role: You are a novelist, developmental editor, continuity editor, and line editor working inside OpenClaw Book Studio.",
    `Task: ${params.task}`,
    "",
    "Context packet:",
    ...params.context.filter(Boolean),
    "",
    "Constraints:",
    "- Never rewrite from selected text alone; use the full context packet.",
    "- Every paragraph must serve its scene and chapter.",
    "- Every chapter must serve the whole book.",
    "- Preserve or improve main storyline, character logic, timeline, tone, plot threads, and ending direction.",
    "- Never edit, paraphrase, reorder, shorten, or expand locked text unless the operator unlocks it.",
    "- Resolve contradictions by changing editable text first. If impossible, warn instead of altering locked text.",
    "- Do not output planning labels, markdown headings, explanations, or meta-writing.",
    "",
    "Brief plan before drafting:",
    "1. Identify the local beat, chapter job, book-level consequence, and locked-text boundary.",
    "2. Draft the clean reader-facing text.",
    "3. Run the cohesion review internally against the rubric.",
    "4. Revise once if any score is below 8.",
    "",
    "Cohesion rubric:",
    ...Object.entries(COHESION_RUBRIC).map(([key, value]) => `- ${key}: ${value}`),
    "",
    `Generation: ${params.title}`,
    "Cohesion review: score internally from 1-10. If any score is below 8, revise once before final output. If any score remains below 6, include a short [COHESION FLAG: ...] after the clean output only when no compliant revision is possible.",
    `Clean output: ${params.output}`,
  ].join("\n");
}

export function buildParagraphRewritePrompt(packet: ParagraphContextPacket): string {
  return structuredPrompt({
    title: "Rewrite exactly one paragraph.",
    task: "Generate one publishable paragraph that fits the surrounding paragraph, scene, chapter, whole-book storyline, future consequences, and locked-text rules.",
    context: packetContextLines(packet),
    output: "Return only the final paragraph readers will see.",
  });
}

export function buildChapterRewritePrompt(packet: ChapterContextPacket): string {
  return structuredPrompt({
    title: "Rewrite one coherent chapter movement.",
    task: "Generate or revise the chapter so previous/future chapters, character arcs, timeline, unresolved threads, setup/payoff needs, pacing, and ending direction stay coherent.",
    context: packetContextLines(packet),
    output:
      "Return only the requested chapter prose or the explicit JSON shape requested by the caller.",
  });
}

export function buildCohesionAuditPrompt(params: {
  packet: ParagraphContextPacket | ChapterContextPacket;
  candidateText: string;
}): string {
  return [
    "Expert role: You are a ruthless continuity editor for OpenClaw Book Studio.",
    "Task: Score the candidate text from 1-10 for every rubric dimension, identify repair instructions, and enforce locked text.",
    "",
    "Context packet:",
    ...packetContextLines(params.packet).filter(Boolean),
    "",
    `Candidate text:\n${params.candidateText}`,
    "",
    "Rubric:",
    ...Object.entries(COHESION_RUBRIC).map(([key, value]) => `- ${key}: ${value}`),
    "",
    'Return JSON only: {"scores":{"flow":8,"sceneFit":8,"chapterFit":8,"bookFit":8,"timeline":8,"characterLogic":8,"plotLogic":8,"emotionalContinuity":8,"style":8,"clarity":8,"pacing":8,"lockedTextCompliance":8},"issues":["..."],"revisionInstructions":["..."]}',
  ].join("\n");
}

function scoreContains(text: string, needle: string): boolean {
  const words = needle
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4)
    .slice(0, 10);
  if (!words.length) {
    return true;
  }
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
}

export function scoreCohesion(params: {
  packet: ParagraphContextPacket | ChapterContextPacket;
  candidateText: string;
}): CohesionAuditScore {
  const text = params.candidateText.replace(/\s+/g, " ").trim();
  const scores: Record<CohesionScoreDimension, number> = {
    flow: 9,
    sceneFit: 9,
    chapterFit: 9,
    bookFit: 9,
    timeline: 9,
    characterLogic: 9,
    plotLogic: 9,
    emotionalContinuity: 9,
    style: 9,
    clarity: 9,
    pacing: 9,
    lockedTextCompliance: 10,
  };
  const issues: string[] = [];
  if (!text) {
    for (const key of Object.keys(scores) as CohesionScoreDimension[]) {
      scores[key] = 1;
    }
    issues.push("No candidate text was generated.");
  }
  if (/\b(this paragraph|this chapter|the reader should|AI will|plan for AI)\b/i.test(text)) {
    scores.clarity = Math.min(scores.clarity, 4);
    scores.style = Math.min(scores.style, 6);
    issues.push("Output still contains planning or meta-writing language.");
  }
  if (params.packet.kind === "paragraph") {
    if (!scoreContains(text, params.packet.scenePurpose)) {
      scores.sceneFit = Math.min(scores.sceneFit, 8);
    }
    if (!scoreContains(text, params.packet.chapterPurpose)) {
      scores.chapterFit = Math.min(scores.chapterFit, 8);
    }
    if (params.packet.previousParagraph && !scoreContains(text, params.packet.previousParagraph)) {
      scores.flow = Math.min(scores.flow, 8);
    }
    if (params.packet.nextParagraph && !scoreContains(text, params.packet.nextParagraph)) {
      scores.pacing = Math.min(scores.pacing, 8);
    }
  } else if (!scoreContains(text, params.packet.chapter.purpose)) {
    scores.chapterFit = Math.min(scores.chapterFit, 8);
  }
  const mainStoryline =
    params.packet.kind === "paragraph" ? params.packet.mainStoryline : params.packet.mainStoryline;
  if (!scoreContains(text, mainStoryline)) {
    scores.bookFit = Math.min(scores.bookFit, 8);
    scores.plotLogic = Math.min(scores.plotLogic, 8);
  }
  const lockedLines =
    params.packet.kind === "paragraph"
      ? params.packet.lockedTextRules
      : params.packet.lockedTextRules;
  const lockedExcerpts = lockedLines
    .filter((line) => line.startsWith("Locked "))
    .map((line) => line.replace(/^Locked [^:]+:\s*/, "").trim())
    .filter((line) => line && !line.includes("No locked text"));
  if (
    lockedExcerpts.some((excerpt) => text.includes(excerpt) && excerpt.length > text.length / 2)
  ) {
    scores.lockedTextCompliance = Math.min(scores.lockedTextCompliance, 5);
    issues.push("Generated text appears to copy a locked block instead of bridging around it.");
  }
  if (countWords(text) < 35) {
    scores.pacing = Math.min(scores.pacing, 6);
    scores.flow = Math.min(scores.flow, 6);
    issues.push("Candidate is too short to prove cohesion.");
  }
  const minimumScore = Math.min(...Object.values(scores));
  const revisionInstructions = issues.map(
    (issue) => `${issue} Revise editable text only while preserving locked text.`,
  );
  return {
    schemaVersion: 1,
    status: minimumScore < 6 ? "flag" : minimumScore < 8 ? "revise-once" : "pass",
    scores,
    minimumScore,
    issues,
    revisionInstructions,
  };
}

export function classifyEditImpact(params: {
  previousText?: string;
  nextText: string;
  changedField?: "title" | "summary" | "purpose" | "styleDirection" | "text" | "chapter";
}): StoryImpactClass {
  const text = `${params.previousText ?? ""}\n${params.nextText}`.toLowerCase();
  if (
    /\b(ending|final page|twist|villain|culprit|betray|traitor|secretly|true identity|not dead|alive all along|timeline|theme|world rule|protagonist wants|stakes are)\b/.test(
      text,
    )
  ) {
    return "book";
  }
  if (
    params.changedField === "chapter" ||
    /\b(chapter purpose|pacing|transition|setup|payoff|reveal|clue|red herring|chapter)\b/.test(
      text,
    )
  ) {
    return "chapter";
  }
  if (/\b(scene|emotion|feels|motivation|choice|decision|argument|consequence)\b/.test(text)) {
    return "scene";
  }
  return "local";
}

export function scoreBookCohesion(plan: BookPlan, locked: LockedConstraintMap): BookQualityScore {
  const paragraphs = plan.chapters.flatMap((chapter) => chapter.paragraphs);
  const drafted = paragraphs.filter((paragraph) => paragraph.text.trim());
  const lockIssues = locked.contradictions;
  const shortDrafts = drafted.filter((paragraph) => countWords(paragraph.text) < 35);
  const missingTransitions = drafted.filter(
    (paragraph) => !paragraph.summary.trim() && !paragraph.purpose.trim(),
  );
  const blockingIssues = lockIssues.map((issue) => `Locked content contradiction: ${issue}`);
  const repairableIssues = [
    ...shortDrafts.map((paragraph) => `Paragraph ${paragraph.id} is too short for cohesion.`),
    ...missingTransitions.map((paragraph) => `Paragraph ${paragraph.id} lacks a planning purpose.`),
  ];
  const lockScore = locked.constraints.length && lockIssues.length ? 0.74 : 0.95;
  const cohesion = Math.max(
    0.6,
    0.94 - repairableIssues.length * 0.02 - blockingIssues.length * 0.08,
  );
  const styleConsistency = Math.max(0.65, 0.92 - shortDrafts.length * 0.015);
  const pacing = Math.max(0.65, 0.9 - missingTransitions.length * 0.015);
  const overall = Number(
    (
      (cohesion + lockScore + styleConsistency + pacing + (blockingIssues.length ? 0.7 : 0.93)) /
      5
    ).toFixed(2),
  );
  return {
    schemaVersion: 1,
    runId: plan.runId,
    overall,
    cohesion: Number(cohesion.toFixed(2)),
    lockedContentIntegration: Number(lockScore.toFixed(2)),
    styleConsistency: Number(styleConsistency.toFixed(2)),
    pacing: Number(pacing.toFixed(2)),
    blockingIssues,
    repairableIssues,
  };
}

export function buildRevisionMap(plan: BookPlan): RevisionMap {
  const issues: RevisionMap["issues"] = [];
  for (const chapter of plan.chapters) {
    for (const paragraph of chapter.paragraphs) {
      if (!paragraph.text.trim() || paragraph.locked || paragraph.fieldLocks?.text) {
        continue;
      }
      if (paragraph.revisionStatus && paragraph.revisionStatus !== "clean") {
        issues.push({
          chapterId: chapter.id,
          paragraphId: paragraph.id,
          severity:
            paragraph.revisionStatus === "blocked-by-lock-conflict" ||
            paragraph.revisionStatus === "blocked-by-cohesion-failure"
              ? "blocked"
              : "repairable",
          code: paragraph.revisionStatus,
          message: `Paragraph ${paragraph.order} in chapter ${chapter.number} needs ${paragraph.revisionStatus.replace(
            /-/g,
            " ",
          )}.`,
          repair:
            "Revise only this editable paragraph or its transition metadata; never change locked text.",
        });
      }
      if (
        paragraph.continuityObligations?.length &&
        !paragraph.transitionIn &&
        !paragraph.transitionOut
      ) {
        issues.push({
          chapterId: chapter.id,
          paragraphId: paragraph.id,
          severity: "repairable",
          code: "missing-transition-metadata",
          message: `Paragraph ${paragraph.order} has continuity obligations but no transition metadata.`,
          repair: "Add transition-in or transition-out guidance before the next revision.",
        });
      }
    }
  }
  return { schemaVersion: 1, runId: plan.runId, issues };
}

export function buildCohesionArtifacts(plan: BookPlan): CohesionArtifacts {
  const lockedConstraints = buildLockedConstraintMap(plan);
  const canon = buildBookCanon(plan, lockedConstraints);
  const memory = buildHierarchicalMemory(plan, lockedConstraints);
  const sceneGraph = buildSceneGraph(plan, lockedConstraints);
  const cohesionPlan = buildCohesionPlan(plan, canon, lockedConstraints);
  const qualityScore = scoreBookCohesion(plan, lockedConstraints);
  const revisionMap = buildRevisionMap(plan);
  return { canon, memory, lockedConstraints, sceneGraph, cohesionPlan, qualityScore, revisionMap };
}

export async function writeCohesionArtifacts(
  config: ResolvedBookWriterConfig,
  plan: BookPlan,
): Promise<CohesionArtifacts> {
  const artifacts = buildCohesionArtifacts(plan);
  const paths = resolveRunPaths(config.outputDir, plan.runId);
  await writeJsonFile(path.join(paths.runDir, "book-canon.json"), artifacts.canon);
  await writeJsonFile(path.join(paths.runDir, "hierarchical-memory.json"), artifacts.memory);
  await writeJsonFile(
    path.join(paths.runDir, "locked-constraints.json"),
    artifacts.lockedConstraints,
  );
  await writeJsonFile(path.join(paths.runDir, "scene-graph.json"), artifacts.sceneGraph);
  await writeJsonFile(path.join(paths.runDir, "cohesion-plan.json"), artifacts.cohesionPlan);
  await writeJsonFile(path.join(paths.runDir, "book-quality-score.json"), artifacts.qualityScore);
  await writeJsonFile(path.join(paths.runDir, "revision-map.json"), artifacts.revisionMap);
  return artifacts;
}

export function lockedContextForPrompt(artifacts: CohesionArtifacts, paragraphId: string): string {
  const direct = artifacts.lockedConstraints.constraints.filter(
    (constraint) => constraint.paragraphId === paragraphId,
  );
  const nearby = direct.length ? direct : artifacts.lockedConstraints.constraints.slice(0, 8);
  if (!nearby.length) {
    return "No locked text constraints yet.";
  }
  return nearby
    .map(
      (constraint) =>
        `${constraint.location} (${constraint.id}): fixed facts=${constraint.fixedFacts.join(
          " ",
        )} setup=${constraint.requiredSetup.join(" ")} consequence=${constraint.requiredConsequences.join(
          " ",
        )} style sample=${constraint.styleSample}`,
    )
    .join("\n");
}
