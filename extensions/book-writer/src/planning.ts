import fs from "node:fs/promises";
import path from "node:path";
import {
  buildCohesionArtifacts,
  buildChapterContextPacket,
  buildChapterRewritePrompt,
  lockedContextForPrompt,
  buildParagraphContextPacket,
  buildParagraphRewritePrompt,
  scoreCohesion,
  writeCohesionArtifacts,
} from "./cohesion.js";
import type { ResolvedBookWriterConfig } from "./config.js";
import {
  createRunId,
  ensureRunDir,
  fileExists,
  readJsonFile,
  resolveRunPaths,
  writeJsonFile,
  writeTextFile,
} from "./files.js";
import { DEFAULT_BOOK_WRITER_GENERATION_MODEL, generateText } from "./model-adapter.js";
import { buildCoverSvg, buildPublishPreview } from "./packaging.js";
import {
  buildStoryImpactState,
  propagatePendingStoryImpact,
  writeStoryImpactArtifacts,
} from "./story-impact.js";
import { countWords, slugify } from "./text.js";
import type {
  BookBible,
  ArchivedBookPlanSummary,
  BookOutline,
  BookPlan,
  BookPlanChapter,
  BookPlanChapterRole,
  BookPlanFinalCohesionReport,
  BookPlanGenreExcellenceReport,
  BookWriterChapterSetupTarget,
  BookPlanParagraph,
  BookWriterIdeaSetupTarget,
  BookPlanProjectSummary,
  BookPlanProfanityLevel,
  BookPlanQualityReport,
  BookPlanStyleGuide,
  BookPlanTonePreset,
  BookWriterAiHelpIntent,
  BookWriterAiHelpSuggestion,
  BookWriterAiHelpTarget,
  BookWriterNextBookRecommendation,
  BookWriterPenNameProfile,
  BookWriterRequest,
  DeletedBookPlanSummary,
  FinishedBookPlanSummary,
  GateFinding,
  KdpDryRunReport,
  PublishedBookMetrics,
  PublishedBookProof,
  PublishedBookSalesSnapshot,
  ReviewPack,
} from "./types.js";

export const BOOK_PLAN_FILE = "book-plan.json";
export const BOOK_PLAN_SCHEMA_VERSION = 1;
export const ARCHIVED_BOOKS_DIR = "_archived-books";
export const DELETED_BOOKS_DIR = "_deleted-books";
export const FINISHED_BOOKS_DIR = "_finished-books";
const PEN_NAME_PROFILES_FILE = "pen-name-profiles.json";

const TONE_PRESETS: Record<Exclude<BookPlanTonePreset, "custom">, string> = {
  professional: "Professional, polished, practical, and clear.",
  technical: "Technical, precise, structured, and evidence-minded.",
  conversational: "Conversational, warm, plainspoken, and easy to follow.",
  humorous: "Humorous, quick, human, and lightly witty without undercutting clarity.",
  dramatic: "Dramatic, tense, cinematic, and emotionally direct.",
  literary: "Literary, textured, observant, and image-rich.",
  inspirational: "Inspirational, encouraging, grounded, and hopeful.",
  direct: "Direct, lean, no-nonsense, and momentum-focused.",
};
const CUSTOM_TONE_FALLBACK =
  "Custom tone: follow the operator's voice direction, keep the voice consistent, and stay aligned with the book category.";

const PROFANITY_DESCRIPTIONS: Record<BookPlanProfanityLevel, string> = {
  none: "No profanity; keep the language clean for the category.",
  mild: "Mild profanity only when it fits the category and scene pressure.",
  moderate: "Moderate category-appropriate profanity; do not make it gratuitous.",
  high: "High profanity relative to the category; use blunt language where it serves character and tone.",
  extreme:
    "Extreme profanity relative to the category; allow frequent explicit language when it fits the book and audience.",
};

const PROFANITY_PATTERN =
  /\b(?:fuck(?:ing|ed|er|ers)?|shit(?:ty)?|bullshit|asshole|bitch(?:es)?|bastard|damn|goddamn|hell)\b/gi;

const DEFAULT_CHAPTER_ROLE: BookPlanChapterRole = {
  storyThread: "main-story",
  plotJob: "setup",
  readerFeeling: "warm",
  notes: "",
};

type CreateBookPlanOptions = {
  config: ResolvedBookWriterConfig;
  request: BookWriterRequest;
  now?: Date;
};

type SaveBookPlanOptions = {
  config: ResolvedBookWriterConfig;
  plan: BookPlan;
  baseVersion?: number;
  action: string;
  summary: string;
  suppressStoryImpactDetection?: boolean;
};

type PlanMutationOptions = {
  config: ResolvedBookWriterConfig;
  runId: string;
  baseVersion?: number;
  now?: Date;
  fetchImpl?: typeof fetch;
};

type DeleteBookPlanResult = {
  runId: string;
  title: string;
  deletedAt: string;
  deletedId: string;
  deletedDir: string;
};

type ArchiveBookPlanResult = {
  runId: string;
  title: string;
  archivedAt: string;
  archivedId: string;
  archivedDir: string;
};

export function bookWriterGenerationModel(config: ResolvedBookWriterConfig) {
  return {
    provider: config.localProvider,
    model: config.localModel,
  };
}

type FinishBookPlanResult = {
  runId: string;
  title: string;
  finishedAt: string;
  finishedId: string;
  finishedDir: string;
  coverPath?: string;
  coverSource?: string;
};

type ReorderDirection = "up" | "down";

const CHAPTER_ARCS = [
  {
    title: "The Promise",
    description: "Open the book with the central problem and the reader promise.",
  },
  { title: "The Stakes", description: "Show why the topic matters now and what is at risk." },
  {
    title: "The Pattern",
    description: "Break down the evidence, system, or conflict driving the book.",
  },
  { title: "The Pressure", description: "Increase obstacles and force a sharper decision." },
  {
    title: "The Turn",
    description: "Reveal the missing angle that changes how the reader sees the issue.",
  },
  { title: "The Test", description: "Apply the book's core idea under realistic constraints." },
  {
    title: "The Resolution",
    description: "Deliver the payoff, conclusion, and practical closure.",
  },
  {
    title: "The Next Step",
    description: "Leave the reader with a clear final takeaway and durable value.",
  },
];

function chapterArcForIndex(index: number, chapterCount: number): (typeof CHAPTER_ARCS)[number] {
  if (chapterCount <= 1) {
    return {
      title: "The Complete Arc",
      description:
        "Tell a complete setup, conflict, turn, and resolution that pays off the reader promise.",
    };
  }
  if (index === 0) {
    return CHAPTER_ARCS[0];
  }
  if (index === chapterCount - 1) {
    return CHAPTER_ARCS[6];
  }
  if (chapterCount === 3) {
    return {
      title: "The Turn",
      description:
        "Escalate the central evidence, reveal the missing angle, and force the final decision.",
    };
  }
  const interiorArcs = CHAPTER_ARCS.slice(1, 6);
  return interiorArcs[(index - 1) % interiorArcs.length];
}

const PARAGRAPH_BEATS = [
  {
    title: "Scene Hook",
    purpose: "Open with a concrete image, tension, or question that pulls the reader forward.",
  },
  {
    title: "Context",
    purpose: "Explain the situation enough for the reader to understand the stakes.",
  },
  {
    title: "Development",
    purpose: "Advance one argument, clue, scene beat, or practical insight.",
  },
  {
    title: "Complication",
    purpose: "Add pressure, contrast, uncertainty, or a useful objection.",
  },
  {
    title: "Turn",
    purpose: "End with a decision, insight, or transition that makes the next paragraph necessary.",
  },
];

const FINAL_CHAPTER_PARAGRAPH_BEATS = [
  {
    title: "Resolution Reveal",
    purpose: "Bring the central evidence, argument, or story thread into the decisive final scene.",
  },
  {
    title: "Proof",
    purpose:
      "Show how the important facts connect so the payoff feels earned instead of summarized.",
  },
  {
    title: "Consequence",
    purpose: "Make the result of the decision, reveal, or lesson visible in concrete terms.",
  },
  {
    title: "Closure",
    purpose:
      "Close the loop on the reader promise with a resolved final image, takeaway, or next step.",
  },
  {
    title: "Aftermath",
    purpose: "Leave the reader with durable meaning after the main problem has been resolved.",
  },
];

const CHAPTER_HOOK_TITLE_PATTERNS = [
  "The {object} That Would Not Open",
  "What the {object} Refused to Show",
  "The {object} with Teeth",
  "The Clue Beneath the {object}",
  "When the {object} Moves",
  "The {object} Nobody Named",
  "A Turn Inside the {object}",
  "The Last Hidden {object}",
];

const GENERIC_CHAPTER_TITLE_PATTERNS = [
  /^chapter\s+\d+$/i,
  /^introduction$/i,
  /^conclusion$/i,
  /^the\s+(?:beginning|problem|solution|journey|challenge|resolution|promise|stakes|pattern|pressure|turn|test|next step)$/i,
  /^understanding\s+.+$/i,
  /^getting started$/i,
  /^final thoughts$/i,
];

const TITLE_KEYWORD_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "clean",
  "chapter",
  "create",
  "every",
  "guide",
  "original",
  "practical",
  "reader",
  "story",
  "their",
  "there",
  "these",
  "through",
  "title",
  "using",
  "where",
  "which",
  "while",
  "with",
  "without",
]);

function toneSentence(styleGuide: BookPlanStyleGuide, practical: boolean): string {
  switch (styleGuide.tonePreset) {
    case "technical":
      return practical
        ? "The voice stays precise, using clear terms and cause-and-effect so the advice feels testable instead of vague."
        : "The narration treats each clue with exactness, letting procedure and evidence carry the tension.";
    case "conversational":
      return practical
        ? "The voice sounds like a capable person at the kitchen table, direct enough to help and warm enough to trust."
        : "The scene keeps a human rhythm, as if the reader is close enough to hear the pauses between decisions.";
    case "humorous":
      return practical
        ? "A dry, practical wit keeps the lesson approachable without turning the problem into a joke."
        : "A quick edge of humor slips through the pressure, making the danger feel more human rather than less serious.";
    case "dramatic":
      return practical
        ? "The stakes stay vivid, with each choice carrying enough pressure to make the lesson matter now."
        : "The scene leans into tension, shadow, and consequence so every small discovery feels charged.";
    case "literary":
      return practical
        ? "The prose uses concrete images and careful observation while keeping the guidance usable."
        : "The prose lingers on texture, silence, and implication, giving the mystery a more layered atmosphere.";
    case "inspirational":
      return practical
        ? "The paragraph keeps hope practical, showing the reader that a small repeatable action can restore control."
        : "The moment keeps faith with courage, showing how ordinary steadiness can push back against fear.";
    case "direct":
      return practical
        ? "The language is lean and no-nonsense, stripping the advice down to the next useful action."
        : "The narration moves cleanly from fact to consequence without ornamental delay.";
    case "custom":
      return practical
        ? `The voice follows this custom tone: ${styleGuide.toneDescription.replace(/[.?!]+$/g, "")}.`
        : `The scene follows this custom tone: ${styleGuide.toneDescription.replace(/[.?!]+$/g, "")}.`;
    case "professional":
    default:
      return practical
        ? "The tone stays polished and practical, giving the reader confidence without sounding cold."
        : "The prose stays polished and controlled, letting the mystery feel commercial, clear, and deliberate.";
  }
}

function profanitySentence(styleGuide: BookPlanStyleGuide, practical: boolean): string {
  switch (styleGuide.profanityLevel) {
    case "mild":
      return practical
        ? "When frustration appears, the language can sharpen briefly, but it never distracts from the lesson."
        : "Frustration can surface in a brief hard-edged line, then the scene returns to clue work.";
    case "moderate":
      return practical
        ? "The language may get rough when the pressure is real, but it stays proportional to the category and audience."
        : "The dialogue can carry a rougher edge when fear or anger breaks through, while the evidence stays central.";
    case "high":
      return practical
        ? "The voice allows blunt, hard-edged language when the category and reader expectation support it."
        : "The scene can sound raw under pressure, with blunt language serving character rather than shock value.";
    case "extreme":
      return practical
        ? "The voice permits explicit, high-intensity language when the category supports that kind of candor."
        : "The scene permits a raw, explicit edge when the characters are under maximum pressure.";
    case "none":
    default:
      return practical
        ? "The language stays clean, calm, and publishable for readers who want no profanity."
        : "Even under pressure, the language stays clean so the tension comes from evidence and choice.";
  }
}

function localStyleSentence(params: {
  chapter: BookPlanChapter;
  paragraph: BookPlanParagraph;
  practical: boolean;
}): string | undefined {
  const direction = [params.chapter.styleDirection, params.paragraph.styleDirection]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(" ");
  if (!direction) {
    return undefined;
  }
  const cleaned = direction.replace(/\s+/g, " ").replace(/[.?!]+$/g, "");
  return params.practical
    ? `The local style accent is ${cleaned.toLowerCase()}, but the advice still stays consistent with the book's main voice.`
    : `The local style accent is ${cleaned.toLowerCase()}, but the scene still belongs to the same book and voice.`;
}

function humanRoleLabel(value: string): string {
  return value.replace(/-/g, " ");
}

function chapterRoleSentence(chapter: BookPlanChapter, practical: boolean): string {
  const role = hydrateChapterRole(chapter.role);
  const pieces = [
    humanRoleLabel(role.storyThread),
    humanRoleLabel(role.plotJob),
    humanRoleLabel(role.readerFeeling),
    role.notes.trim(),
  ].filter(Boolean);
  const label = pieces.join(", ");
  return practical
    ? `This chapter's job is ${label}, so the guidance should feel intentional rather than random.`
    : `This chapter's story job is ${label}, so the scene pressure, reveal rhythm, and emotional feel stay deliberate.`;
}

function choosePenName(config: ResolvedBookWriterConfig, requested?: string) {
  const requestedName = requested?.replace(/\s+/g, " ").trim();
  const defaultPenName = config.penNames[0] ?? {
    name: "Northstar House",
    lane: "clean commercial mystery",
    readerPromise: "fast, satisfying suspense with practical courage",
  };
  return (
    config.penNames.find((penName) => penName.name === requestedName) ??
    (requestedName ? { ...defaultPenName, name: requestedName } : defaultPenName)
  );
}

function defaultTopic(request: BookWriterRequest): string {
  return (
    request.topic ??
    "An original clean mystery about a small-town repair expert who uncovers a financial fraud without compromising his conscience"
  );
}

function titleFromTopic(topic: string): string {
  const eventTitle = topic.match(
    /\bcalled\s+([A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*){0,3})\b/,
  );
  if (eventTitle?.[1]) {
    return eventTitle[1].replace(/\s+\)$/g, "").trim();
  }
  const namedAntagonist = topic.match(
    /\b(?:calls itself|called itself|named|is named)\s+([A-Z][A-Za-z0-9'’-]*(?:-[A-Z][A-Za-z0-9'’-]*)?(?:\s+[A-Z][A-Za-z0-9'’-]*){0,2})\b/,
  );
  if (namedAntagonist?.[1]) {
    return namedAntagonist[1].replace(/[.?!]+$/g, "").trim();
  }
  const cleaned = topic
    .replace(/^an?\s+original\s+/i, "")
    .replace(/\babout\b.+$/i, "")
    .replace(/[.?!].*$/g, "")
    .trim();
  if (cleaned.length >= 8 && cleaned.length <= 64) {
    return cleaned.replace(/\b\w/g, (char) => char.toUpperCase());
  }
  return "The Ledger at Briar Hill";
}

function idFor(prefix: string, parts: Array<string | number>): string {
  const slug = slugify(parts.join("-")).slice(0, 72);
  return `${prefix}-${slug || "item"}`;
}

const MIN_PLANNING_TARGET_WORDS = 250;

function normalizeTargetWords(value: number | undefined, fallback = 12000): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(MIN_PLANNING_TARGET_WORDS, Math.floor(value));
}

function normalizeTonePreset(value: unknown): BookPlanTonePreset {
  if (
    value === "professional" ||
    value === "technical" ||
    value === "conversational" ||
    value === "humorous" ||
    value === "dramatic" ||
    value === "literary" ||
    value === "inspirational" ||
    value === "direct" ||
    value === "custom"
  ) {
    return value;
  }
  return "professional";
}

function normalizeProfanityLevel(value: unknown): BookPlanProfanityLevel {
  if (
    value === "none" ||
    value === "mild" ||
    value === "moderate" ||
    value === "high" ||
    value === "extreme"
  ) {
    return value;
  }
  return "none";
}

function buildStyleGuide(params: {
  tone?: string;
  tonePreset?: BookPlanTonePreset;
  profanityLevel?: BookPlanProfanityLevel;
}): BookPlanStyleGuide {
  const requestedTone = params.tone?.replace(/\s+/g, " ").trim();
  const tonePreset = requestedTone
    ? (params.tonePreset ?? "custom")
    : normalizeTonePreset(params.tonePreset);
  const toneDescription =
    requestedTone || (tonePreset === "custom" ? CUSTOM_TONE_FALLBACK : TONE_PRESETS[tonePreset]);
  const profanityLevel = normalizeProfanityLevel(params.profanityLevel);
  return {
    tonePreset,
    toneDescription,
    profanityLevel,
    profanityDescription: PROFANITY_DESCRIPTIONS[profanityLevel],
  };
}

function styleGuideForPlan(plan: BookPlan): BookPlanStyleGuide {
  return buildStyleGuide({
    tone: plan.styleGuide?.toneDescription ?? plan.brief.tone,
    tonePreset: plan.styleGuide?.tonePreset,
    profanityLevel: plan.styleGuide?.profanityLevel,
  });
}

function countProfanityTerms(text: string): number {
  return text.match(PROFANITY_PATTERN)?.length ?? 0;
}

function hydrateChapterRole(role: Partial<BookPlanChapterRole> | undefined): BookPlanChapterRole {
  return {
    storyThread: role?.storyThread ?? DEFAULT_CHAPTER_ROLE.storyThread,
    plotJob: role?.plotJob ?? DEFAULT_CHAPTER_ROLE.plotJob,
    readerFeeling: role?.readerFeeling ?? DEFAULT_CHAPTER_ROLE.readerFeeling,
    notes: role?.notes ?? "",
  };
}

function hydrateBookPlan(plan: BookPlan): BookPlan {
  const styleGuide = styleGuideForPlan(plan);
  return {
    ...plan,
    styleGuide,
    brief: {
      ...plan.brief,
      tone: styleGuide.toneDescription,
      constraints: plan.brief.constraints?.length
        ? plan.brief.constraints
        : [
            "Original-only manuscript.",
            "No third-party summaries, fanfic, living-author style imitation, or misleading metadata.",
            "Use paragraph titles for editing only; do not print them in the manuscript.",
          ],
    },
    chapters: plan.chapters.map((chapter, chapterIndex) => ({
      ...chapter,
      number: chapterIndex + 1,
      styleDirection: chapter.styleDirection ?? "",
      role: hydrateChapterRole(chapter.role),
      fieldLocks: {
        title: Boolean(chapter.fieldLocks?.title),
        description: Boolean(chapter.fieldLocks?.description),
        styleDirection: Boolean(chapter.fieldLocks?.styleDirection),
        roleNotes: Boolean(chapter.fieldLocks?.roleNotes),
      },
      paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) => ({
        ...paragraph,
        order: paragraphIndex + 1,
        summary:
          paragraph.summary?.trim() ||
          readerFacingParagraphSummary({
            chapterTitle: chapter.title,
            chapterDescription: chapter.description,
            paragraphTitle: paragraph.title,
            purpose: paragraph.purpose || paragraph.title,
          }),
        purpose:
          paragraph.purpose?.trim() ||
          readerFacingParagraphSummary({
            chapterTitle: chapter.title,
            chapterDescription: chapter.description,
            paragraphTitle: paragraph.title,
            purpose: paragraph.title,
          }),
        styleDirection: paragraph.styleDirection ?? "",
        fieldLocks: {
          title: Boolean(paragraph.fieldLocks?.title),
          summary: Boolean(paragraph.fieldLocks?.summary),
          purpose: Boolean(paragraph.fieldLocks?.purpose),
          styleDirection: Boolean(paragraph.fieldLocks?.styleDirection),
          text: Boolean(paragraph.fieldLocks?.text),
        },
      })),
    })),
  };
}

function chapterCountForTargetWords(targetWords: number): number {
  if (targetWords <= 1200) {
    return 1;
  }
  if (targetWords <= 3000) {
    return 3;
  }
  if (targetWords <= 9000) {
    return 6;
  }
  if (targetWords <= 18000) {
    return 8;
  }
  if (targetWords <= 40000) {
    return 10;
  }
  return 12;
}

function paragraphCountForChapterTarget(targetWords: number): number {
  if (targetWords <= 300) {
    return 1;
  }
  if (targetWords <= 900) {
    return 4;
  }
  if (targetWords <= 1800) {
    return 5;
  }
  return 6;
}

export function isGenericChapterTitle(title: string, planTitle?: string): boolean {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return true;
  }
  const planLower = planTitle?.replace(/\s+/g, " ").trim().toLowerCase();
  return (
    GENERIC_CHAPTER_TITLE_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    (Boolean(planLower) && normalized.toLowerCase() === planLower)
  );
}

function titleKeywords(text: string): string[] {
  return [
    ...new Set(
      text
        .replace(/['’]/g, "")
        .match(/\b[A-Za-z][A-Za-z-]{4,}\b/g)
        ?.map((word) => word.toLowerCase())
        .filter((word) => !TITLE_KEYWORD_STOPWORDS.has(word))
        .slice(0, 10) ?? [],
    ),
  ];
}

function titleCase(value: string): string {
  const small = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "the", "to"]);
  return value
    .split(/\s+/)
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index > 0 && small.has(lower)
        ? lower
        : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function titleHaystack(params: {
  topic: string;
  genre?: string;
  readerPromise?: string;
  chapterDescription?: string;
  role?: BookPlanChapterRole;
}): string {
  return [
    params.topic,
    params.genre,
    params.readerPromise,
    params.chapterDescription,
    params.role?.notes,
  ].join(" ");
}

function chapterTitleCandidates(params: {
  baseTitle: string;
  index: number;
  topic: string;
  genre?: string;
  readerPromise?: string;
  chapterDescription?: string;
  role?: BookPlanChapterRole;
  existingTitles?: string[];
}): string[] {
  const haystack = titleHaystack(params);
  const keywords = titleKeywords(haystack);
  const object = titleCase(keywords[params.index % Math.max(1, keywords.length)] ?? "Signal");
  const second = titleCase(keywords[(params.index + 2) % Math.max(1, keywords.length)] ?? "Truth");
  const lower = haystack.toLowerCase();
  if (
    params.index === 0 &&
    params.baseTitle.split(/\s+/).length >= 3 &&
    !isGenericChapterTitle(params.baseTitle)
  ) {
    return [params.baseTitle, `The First ${object}`, `${object} at the Door`];
  }
  if (/\bmystery|detective|clue|fraud|invoice|murder|case|ledger|secret\b/.test(lower)) {
    return [`The ${object} That Lied`, `A Clue in the ${second}`, `What the ${object} Hid`];
  }
  if (/\bbusiness|startup|profit|sales|marketing|management|operator|system\b/.test(lower)) {
    return [`The ${object} Bottleneck`, `Where the ${second} Breaks`, "The System Under Pressure"];
  }
  if (/\beducat|curriculum|teach|student|learn|lesson|workbook\b/.test(lower)) {
    return ["The Lesson That Sticks", `Where ${object} Becomes Real`, "The Practice Door"];
  }
  if (/\bmemoir|autobiograph|life story|personal story\b/.test(lower)) {
    return [`The Day ${object} Changed`, "What I Could Not Name", "The Room That Remembered"];
  }
  if (/\bguide|nonfiction|field guide|manual|how to|practical\b/.test(lower)) {
    return [`The ${object} You Can Use`, `When ${second} Gets Real`, "The Practical Turn"];
  }
  const hook = CHAPTER_HOOK_TITLE_PATTERNS[params.index % CHAPTER_HOOK_TITLE_PATTERNS.length];
  return [
    hook.replaceAll("{object}", object),
    `When the ${second} Changed`,
    `The Thing Beneath the ${object}`,
  ];
}

function scoreChapterTitle(
  title: string,
  params: { baseTitle: string; existingTitles?: string[] },
): number {
  const normalized = title.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  let score = 0;
  if (!isGenericChapterTitle(normalized, params.baseTitle)) {
    score += 8;
  }
  if (
    /\b(clue|hidden|lied|broke|door|edge|pressure|changed|secret|signal|truth|turn|room|bridge|ledger|breath|storm|shadow)\b/i.test(
      normalized,
    )
  ) {
    score += 4;
  }
  const words = normalized.split(/\s+/).length;
  if (words >= 3 && words <= 7) {
    score += 3;
  }
  if (params.existingTitles?.some((existing) => existing.toLowerCase() === lower)) {
    score -= 20;
  }
  return score;
}

function bestChapterTitle(params: Parameters<typeof chapterTitleCandidates>[0]): string {
  return (
    chapterTitleCandidates(params)
      .map((title) => title.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .toSorted(
        (left, right) =>
          scoreChapterTitle(right, params) - scoreChapterTitle(left, params) ||
          left.localeCompare(right),
      )[0] ?? "The Hidden Turn"
  );
}

function chapterTitle(baseTitle: string, index: number, topic: string): string {
  return bestChapterTitle({ baseTitle, index, topic });
}

function readerFacingParagraphSummary(params: {
  chapterTitle: string;
  chapterDescription: string;
  paragraphTitle: string;
  purpose: string;
}): string {
  const chapterFocus = readerFacingTopic(params.chapterDescription);
  const paragraphMove = readerFacingMove(params.purpose || params.paragraphTitle);
  return `This paragraph says, in reader-facing form, how ${paragraphMove.toLowerCase()} connects to ${chapterFocus.toLowerCase()} inside "${params.chapterTitle}".`;
}

function buildParagraph(params: {
  runId: string;
  chapterIndex: number;
  chapterCount: number;
  paragraphIndex: number;
  paragraphCount: number;
  chapterTitle: string;
  chapterDescription: string;
  targetWords: number;
  sourceParagraphIds?: string[];
}): BookPlanParagraph {
  const isFinalChapter = params.chapterIndex === params.chapterCount - 1;
  const isFinalParagraph = params.paragraphIndex === params.paragraphCount - 1;
  const beat = isFinalChapter
    ? FINAL_CHAPTER_PARAGRAPH_BEATS[
        Math.min(params.paragraphIndex, FINAL_CHAPTER_PARAGRAPH_BEATS.length - 1)
      ]
    : PARAGRAPH_BEATS[params.paragraphIndex % PARAGRAPH_BEATS.length];
  const purpose =
    isFinalChapter && isFinalParagraph
      ? `${beat.purpose} Do not introduce a new unresolved threat, warning, or cliffhanger.`
      : beat.purpose;
  const summary = readerFacingParagraphSummary({
    chapterTitle: params.chapterTitle,
    chapterDescription: params.chapterDescription,
    paragraphTitle: beat.title,
    purpose,
  });
  return {
    id: idFor("para", [params.runId, params.chapterIndex + 1, params.paragraphIndex + 1]),
    order: params.paragraphIndex + 1,
    title: beat.title,
    summary,
    purpose: summary,
    beats: [
      purpose,
      `Keep this paragraph aligned to "${params.chapterTitle}".`,
      "Use original phrasing and avoid source imitation.",
    ],
    styleDirection: "",
    fieldLocks: {
      title: false,
      summary: false,
      purpose: false,
      styleDirection: false,
      text: false,
    },
    targetWords: params.targetWords,
    text: "",
    locked: false,
    status: "planned",
    ...(params.sourceParagraphIds ? { sourceParagraphIds: params.sourceParagraphIds } : {}),
  };
}

function buildPlanChapters(params: {
  runId: string;
  topic: string;
  baseTitle: string;
  targetWords: number;
  source?: BookPlan;
}): BookPlanChapter[] {
  const chapterCount = params.source
    ? Math.max(3, Math.min(8, params.source.chapters.length))
    : chapterCountForTargetWords(params.targetWords);
  const chapterTarget = Math.max(1, Math.floor(params.targetWords / chapterCount));
  const usedTitles: string[] = [];
  return Array.from({ length: chapterCount }, (_value, index) => {
    const sourceChapter = params.source?.chapters[index];
    const arc = chapterArcForIndex(index, chapterCount);
    const description = sourceChapter
      ? `Condense the essential point from "${sourceChapter.title}" without copying paragraph text.`
      : arc.description;
    const role: BookPlanChapterRole = sourceChapter
      ? hydrateChapterRole(sourceChapter.role)
      : {
          storyThread: index === chapterCount - 1 ? "resolution" : "main-story",
          plotJob:
            index === 0
              ? "setup"
              : index === chapterCount - 1
                ? "payoff"
                : index === Math.floor(chapterCount / 2)
                  ? "twist"
                  : "conflict",
          readerFeeling:
            index === chapterCount - 1
              ? "hopeful"
              : index === Math.floor(chapterCount / 2)
                ? "suspenseful"
                : "warm",
          notes: "",
        };
    const title = sourceChapter
      ? `Quick Read: ${sourceChapter.title.replace(/^Quick Read:\s*/i, "")}`
      : bestChapterTitle({
          baseTitle: params.baseTitle,
          index,
          topic: params.topic,
          chapterDescription: description,
          role,
          existingTitles: usedTitles,
        });
    usedTitles.push(title);
    const paragraphCount = params.source ? 3 : paragraphCountForChapterTarget(chapterTarget);
    const paragraphTarget = Math.max(40, Math.floor(chapterTarget / paragraphCount));
    return {
      id: idFor("chapter", [params.runId, index + 1, title]),
      number: index + 1,
      title,
      description,
      styleDirection: "",
      role,
      fieldLocks: {
        title: false,
        description: false,
        styleDirection: false,
        roleNotes: false,
      },
      targetWords: chapterTarget,
      locked: false,
      status: "planned",
      paragraphs: Array.from({ length: paragraphCount }, (_paragraphValue, paragraphIndex) =>
        buildParagraph({
          runId: params.runId,
          chapterIndex: index,
          paragraphIndex,
          chapterCount,
          paragraphCount,
          chapterTitle: title,
          chapterDescription: description,
          targetWords: paragraphTarget,
          sourceParagraphIds: sourceChapter?.paragraphs.map((paragraph) => paragraph.id),
        }),
      ),
    };
  });
}

function coverConceptPath(config: ResolvedBookWriterConfig, runId: string): string {
  return path.join(resolveRunPaths(config.outputDir, runId).runDir, "cover-concept.svg");
}

function coverForPlan(params: {
  config: ResolvedBookWriterConfig;
  runId: string;
  title: string;
  genre: string;
}): BookPlan["cover"] {
  const conceptPath = coverConceptPath(params.config, params.runId);
  return {
    brief: `Commercial ${params.genre} cover for "${params.title}" with strong thumbnail readability, original imagery, and restrained typography.`,
    prompt: `Create an original ${params.genre} book cover for "${params.title}". Use clean composition, clear title space, no trademarked imagery, and a professional retail look.`,
    status: "generated",
    variants: [
      {
        id: "auto-concept",
        label: "Editable SVG concept",
        path: conceptPath,
        source: "svg-concept",
        approved: false,
      },
    ],
  };
}

function bibleForCoverConcept(plan: BookPlan): BookBible {
  return {
    runId: plan.runId,
    title: plan.title,
    subtitle: plan.subtitle,
    slug: plan.slug,
    penName: plan.penName,
    genre: plan.genre,
    readerPromise: plan.brief.readerPromise,
    premise: plan.brief.topicParagraph,
    cast: [],
    originalityStrategy: [],
    bannedDependencies: [],
    targetWords: plan.targetWords,
    tone: plan.styleGuide?.toneDescription ?? plan.brief.tone,
    profanityLevel: plan.styleGuide?.profanityLevel,
    createdAt: plan.createdAt,
  };
}

function castForBookBible(plan: BookPlan): BookBible["cast"] {
  const text = `${plan.topic} ${plan.genre}`.toLowerCase();
  if (/\b(mystery|fiction|novel|thriller|suspense|detective|case|clue|scene)\b/.test(text)) {
    const protagonist = inferPrimaryCharacterName(plan) ?? "Audrey";
    return [
      {
        name: protagonist,
        role: "protagonist",
        notes: "Lead point-of-view character inferred from the book topic for continuity gates.",
      },
    ];
  }
  return [];
}

function inferPrimaryCharacterName(plan: Pick<BookPlan, "topic" | "title">): string | undefined {
  const source = `${plan.topic} ${plan.title}`.replace(/\s+/g, " ").trim();
  const aboutMatch =
    /\babout\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?=,|\s+(?:a|an|the|who|whose|with)\b)/.exec(
      source,
    );
  const candidate = aboutMatch?.[1]?.trim();
  if (!candidate || /^(Original|Clean|Book|Story|Novel|Mystery)$/i.test(candidate)) {
    return undefined;
  }
  return candidate;
}

async function writeCoverConceptArtifacts(plan: BookPlan): Promise<void> {
  const conceptPath = plan.cover.variants.find((variant) => variant.id === "auto-concept")?.path;
  if (!conceptPath) {
    return;
  }
  await writeTextFile(conceptPath, buildCoverSvg(bibleForCoverConcept(plan)));
  await writeJsonFile(path.join(path.dirname(conceptPath), "cover-concept.json"), {
    title: plan.title,
    brief: plan.cover.brief,
    prompt: plan.cover.prompt,
    source: "OpenClaw AI concept",
    status: plan.cover.status,
  });
}

export function createBookPlan(options: CreateBookPlanOptions): BookPlan {
  const now = options.now ?? new Date();
  const topic = defaultTopic(options.request);
  const title = titleFromTopic(topic);
  const runId = options.request.runId ?? createRunId(topic, now);
  const penName = choosePenName(options.config, options.request.penName);
  const genre = options.request.genre ?? penName.lane;
  const targetWords = normalizeTargetWords(options.request.targetWords);
  const styleGuide = buildStyleGuide({
    tone: options.request.tone,
    tonePreset: options.request.tonePreset,
    profanityLevel: options.request.profanityLevel,
  });
  const chapters = buildPlanChapters({ runId, topic, baseTitle: title, targetWords });
  return {
    schemaVersion: BOOK_PLAN_SCHEMA_VERSION,
    kind: "full",
    runId,
    title,
    subtitle: "An Original OpenClaw Book",
    slug: slugify(title),
    topic,
    genre,
    penName: penName.name,
    targetWords,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: 1,
    status: "paragraph-plan",
    mode: "simple",
    brief: {
      topicParagraph: topic,
      readerPromise: penName.readerPromise,
      audience: "Commercial readers who want a clear, original, useful book.",
      tone: styleGuide.toneDescription,
      constraints: [
        "Original-only manuscript.",
        "No third-party summaries, fanfic, living-author style imitation, or misleading metadata.",
        "Use paragraph titles for editing only; do not print them in the manuscript.",
        styleGuide.profanityDescription,
      ],
    },
    styleGuide,
    chapters,
    cover: coverForPlan({ config: options.config, runId, title, genre }),
    publishing: {
      channel: "kdp",
      finalSubmitRequiresApproval: true,
      status: "not-ready",
      checklist: [
        "Run gates.",
        "Review stitched manuscript.",
        "Approve cover asset.",
        "Prepare KDP dry-run.",
        "Pause before final submit.",
      ],
    },
    artifactLinks: {},
    revisionHistory: [
      {
        version: 1,
        at: now.toISOString(),
        action: "create",
        summary: "Created editable book plan from topic paragraph.",
      },
    ],
  };
}

export function createQuickReadPlan(options: {
  config: ResolvedBookWriterConfig;
  source: BookPlan;
  now?: Date;
  runId?: string;
}): BookPlan {
  const now = options.now ?? new Date();
  const topic = `A concise Quick Read Edition of ${options.source.title}, preserving the original book's core promise without copying paragraph text verbatim.`;
  const runId = options.runId ?? createRunId(`${options.source.runId}-quick-read`, now);
  const targetWords = Math.max(2500, Math.floor(options.source.targetWords * 0.28));
  const sourceStyleGuide = styleGuideForPlan(options.source);
  return {
    ...createBookPlan({
      config: options.config,
      request: {
        topic,
        genre: options.source.genre,
        penName: options.source.penName,
        targetWords,
        tone: sourceStyleGuide.toneDescription,
        tonePreset: sourceStyleGuide.tonePreset,
        profanityLevel: sourceStyleGuide.profanityLevel,
        runId,
        liveModel: false,
      },
      now,
    }),
    kind: "quick-read",
    sourceRunId: options.source.runId,
    title: `${options.source.title}: Quick Read Edition`,
    subtitle: "A Condensed Original Edition",
    slug: slugify(`${options.source.title} Quick Read Edition`),
    chapters: buildPlanChapters({
      runId,
      topic,
      baseTitle: options.source.title,
      targetWords,
      source: options.source,
    }),
    revisionHistory: [
      {
        version: 1,
        at: now.toISOString(),
        action: "create-quick-read",
        summary: `Created Quick Read Edition plan from ${options.source.runId}.`,
      },
    ],
  };
}

export function planPath(outputDir: string, runId: string): string {
  return path.join(resolveRunPaths(outputDir, runId).runDir, BOOK_PLAN_FILE);
}

export async function readBookPlan(
  config: ResolvedBookWriterConfig,
  runId: string,
): Promise<BookPlan | undefined> {
  const plan = await readJsonFile<BookPlan>(planPath(config.outputDir, runId));
  return plan ? hydrateBookPlan(plan) : undefined;
}

function assertPlanVersion(existing: BookPlan | undefined, baseVersion?: number): void {
  if (baseVersion === undefined || !existing) {
    return;
  }
  if (existing.version !== baseVersion) {
    throw new Error(
      `book plan version conflict: expected ${baseVersion}, found ${existing.version}`,
    );
  }
}

function lockedTextById(plan: BookPlan): Map<string, string> {
  const locked = new Map<string, string>();
  for (const chapter of plan.chapters) {
    for (const paragraph of chapter.paragraphs) {
      if (chapter.locked || paragraph.locked || paragraph.fieldLocks?.text) {
        locked.set(paragraph.id, paragraph.text);
      }
    }
  }
  return locked;
}

function assertLockedTextUnchanged(existing: BookPlan | undefined, next: BookPlan): void {
  if (!existing) {
    return;
  }
  const existingLocked = lockedTextById(existing);
  if (!existingLocked.size) {
    return;
  }
  const nextParagraphs = new Map(
    next.chapters.flatMap((chapter) =>
      chapter.paragraphs.map((paragraph) => [paragraph.id, paragraph] as const),
    ),
  );
  for (const [paragraphId, text] of existingLocked) {
    const paragraph = nextParagraphs.get(paragraphId);
    if (paragraph && paragraph.text !== text) {
      throw new Error(
        `locked Book Text changed for paragraph ${paragraphId}; unlock it before editing.`,
      );
    }
  }
}

function normalizePlanForSave(plan: BookPlan, now: Date): BookPlan {
  const hydrated = hydrateBookPlan(plan);
  return {
    ...hydrated,
    schemaVersion: BOOK_PLAN_SCHEMA_VERSION,
    slug: hydrated.slug || slugify(hydrated.title),
    updatedAt: now.toISOString(),
    chapters: hydrated.chapters.map((chapter, chapterIndex) => ({
      ...chapter,
      number: chapterIndex + 1,
      paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) => ({
        ...paragraph,
        order: paragraphIndex + 1,
      })),
    })),
    publishing: {
      ...hydrated.publishing,
      channel: "kdp",
      finalSubmitRequiresApproval: true,
    },
  };
}

async function writeCompatibilityArtifacts(config: ResolvedBookWriterConfig, plan: BookPlan) {
  const paths = resolveRunPaths(config.outputDir, plan.runId);
  await ensureRunDir(paths);
  const styleGuide = styleGuideForPlan(plan);
  const bible: BookBible = {
    runId: plan.runId,
    title: plan.title,
    subtitle: plan.subtitle,
    slug: plan.slug,
    penName: plan.penName,
    genre: plan.genre,
    readerPromise: plan.brief.readerPromise,
    premise: plan.brief.topicParagraph,
    cast: castForBookBible(plan),
    originalityStrategy: [
      "Use only the editable book plan and original generated text.",
      "Do not summarize or adapt copyrighted third-party works.",
      "Do not imitate a living author's style.",
    ],
    bannedDependencies: [
      "third-party summaries",
      "fanfic",
      "living-author style imitation",
      "unauthorized biographies",
      "PLR",
    ],
    targetWords: plan.targetWords,
    tone: styleGuide.toneDescription,
    profanityLevel: styleGuide.profanityLevel,
    createdAt: plan.createdAt,
  };
  const outline: BookOutline = {
    runId: plan.runId,
    chapters: plan.chapters.map((chapter) => ({
      number: chapter.number,
      title: chapter.title,
      promise: chapter.description,
      beats: chapter.paragraphs.map((paragraph) => paragraph.purpose),
    })),
  };
  await writeJsonFile(path.join(paths.runDir, "book-bible.json"), bible);
  await writeJsonFile(path.join(paths.runDir, "outline.json"), outline);
  await writeCohesionArtifacts(config, plan);
  await writeStoryImpactArtifacts(config, plan);
  await writeJsonFile(
    path.join(paths.runDir, "final-cohesion-report.json"),
    buildFinalCohesionReport(plan),
  );
  await writeJsonFile(
    path.join(paths.runDir, "genre-excellence-report.json"),
    buildGenreExcellenceReport(plan),
  );
}

export async function saveBookPlan(options: SaveBookPlanOptions): Promise<BookPlan> {
  const now = new Date();
  const paths = resolveRunPaths(options.config.outputDir, options.plan.runId);
  await ensureRunDir(paths);
  const existing = await readBookPlan(options.config, options.plan.runId);
  assertPlanVersion(existing, options.baseVersion);
  assertLockedTextUnchanged(existing, options.plan);
  const nextVersion = existing ? existing.version + 1 : Math.max(1, options.plan.version);
  const cohesionArtifacts = buildCohesionArtifacts(options.plan);
  const storyImpact = buildStoryImpactState({
    previous: existing ?? null,
    plan: options.plan,
    version: nextVersion,
    now,
    suppressDetection: options.suppressStoryImpactDetection,
  });
  const normalized = normalizePlanForSave(
    {
      ...options.plan,
      version: nextVersion,
      canonVersion: nextVersion,
      cohesionStatus: options.plan.cohesionStatus ?? "planned",
      qualityScore: cohesionArtifacts.qualityScore.overall,
      ...storyImpact,
      artifactLinks: {
        ...options.plan.artifactLinks,
        bookPlan: path.join(paths.runDir, BOOK_PLAN_FILE),
        bookCanon: path.join(paths.runDir, "book-canon.json"),
        hierarchicalMemory: path.join(paths.runDir, "hierarchical-memory.json"),
        lockedConstraints: path.join(paths.runDir, "locked-constraints.json"),
        sceneGraph: path.join(paths.runDir, "scene-graph.json"),
        cohesionPlan: path.join(paths.runDir, "cohesion-plan.json"),
        bookQualityScore: path.join(paths.runDir, "book-quality-score.json"),
        revisionMap: path.join(paths.runDir, "revision-map.json"),
        finalCohesionReport: path.join(paths.runDir, "final-cohesion-report.json"),
        genreExcellenceReport: path.join(paths.runDir, "genre-excellence-report.json"),
        storyImpactReport: path.join(paths.runDir, "story-impact-report.json"),
        storySyncReport: path.join(paths.runDir, "story-sync-report.json"),
        storylineOverview: path.join(paths.runDir, "storyline-overview.json"),
      },
      revisionHistory: [
        ...(existing?.revisionHistory ?? options.plan.revisionHistory ?? []).slice(-49),
        {
          version: nextVersion,
          at: now.toISOString(),
          action: options.action,
          summary: options.summary,
        },
      ],
    },
    now,
  );
  await writeJsonFile(path.join(paths.runDir, BOOK_PLAN_FILE), normalized);
  await writeCompatibilityArtifacts(options.config, normalized);
  return normalized;
}

export async function createAndSaveBookPlan(options: CreateBookPlanOptions): Promise<BookPlan> {
  const now = options.now ?? new Date();
  let plan = createBookPlan({ ...options, now });
  if (options.request.runId) {
    if (await fileExists(resolveRunPaths(options.config.outputDir, plan.runId).runDir)) {
      throw new Error(`book plan already exists: ${plan.runId}`);
    }
  } else {
    const baseRunId = plan.runId;
    for (
      let index = 2;
      await fileExists(resolveRunPaths(options.config.outputDir, plan.runId).runDir);
      index += 1
    ) {
      plan = createBookPlan({
        ...options,
        request: { ...options.request, runId: `${baseRunId}-${index}` },
        now,
      });
    }
  }
  const saved = await saveBookPlan({
    config: options.config,
    plan,
    action: "create",
    summary: "Created editable planning studio book plan.",
  });
  await writeCoverConceptArtifacts(saved);
  return saved;
}

function copyBookPlanWithRunId(params: {
  config: ResolvedBookWriterConfig;
  source: BookPlan;
  runId: string;
  now: Date;
}): BookPlan {
  const title = `Copy of ${params.source.title}`.replace(/^Copy of Copy of /, "Copy of ");
  return {
    ...params.source,
    runId: params.runId,
    title,
    slug: slugify(title),
    createdAt: params.now.toISOString(),
    updatedAt: params.now.toISOString(),
    version: 1,
    status: ["stitched", "packaged", "publish-ready"].includes(params.source.status)
      ? "drafting"
      : params.source.status,
    artifactLinks: {},
    chapters: params.source.chapters.map((chapter, chapterIndex) => ({
      ...chapter,
      id: idFor("chapter", [params.runId, chapterIndex + 1, chapter.title]),
      number: chapterIndex + 1,
      role: hydrateChapterRole(chapter.role),
      paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) => ({
        ...paragraph,
        id: idFor("para", [params.runId, chapterIndex + 1, paragraphIndex + 1]),
        order: paragraphIndex + 1,
      })),
    })),
    cover: coverForPlan({
      config: params.config,
      runId: params.runId,
      title,
      genre: params.source.genre,
    }),
    publishing: {
      ...params.source.publishing,
      status: "not-ready",
      finalSubmitRequiresApproval: true,
    },
    revisionHistory: [
      {
        version: 1,
        at: params.now.toISOString(),
        action: "copy",
        summary: `Copied editable draft from ${params.source.runId}. Publishing proof and trophy metrics were cleared.`,
      },
    ],
  };
}

export async function copyBookPlan(options: {
  config: ResolvedBookWriterConfig;
  runId: string;
  now?: Date;
}): Promise<BookPlan> {
  const source = await readBookPlan(options.config, options.runId);
  if (!source) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  const now = options.now ?? new Date();
  const baseRunId = createRunId(`${source.runId}-copy`, now);
  let runId = baseRunId;
  for (
    let index = 2;
    await fileExists(resolveRunPaths(options.config.outputDir, runId).runDir);
    index += 1
  ) {
    runId = `${baseRunId}-${index}`;
  }
  const plan = copyBookPlanWithRunId({ config: options.config, source, runId, now });
  const saved = await saveBookPlan({
    config: options.config,
    plan,
    action: "copy",
    summary: `Copied editable draft from ${source.runId}.`,
  });
  await writeCoverConceptArtifacts(saved);
  return saved;
}

export async function deleteBookPlan(options: {
  config: ResolvedBookWriterConfig;
  runId: string;
  now?: Date;
}): Promise<DeleteBookPlanResult> {
  const plan = await readBookPlan(options.config, options.runId);
  if (!plan) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  const paths = resolveRunPaths(options.config.outputDir, options.runId);
  const deletedAt = (options.now ?? new Date()).toISOString();
  const deletedRoot = path.join(paths.rootDir, DELETED_BOOKS_DIR);
  await fs.mkdir(deletedRoot, { recursive: true });
  const deletedSlug = `${deletedAt.replace(/[:.]/g, "-")}-${paths.runId}`;
  let deletedId = deletedSlug;
  let deletedDir = path.join(deletedRoot, deletedSlug);
  for (let index = 2; await fileExists(deletedDir); index += 1) {
    deletedId = `${deletedSlug}-${index}`;
    deletedDir = path.join(deletedRoot, deletedId);
  }
  await fs.rename(paths.runDir, deletedDir);
  await writeJsonFile(path.join(deletedDir, "deleted-book.json"), {
    runId: plan.runId,
    title: plan.title,
    deletedAt,
    originalDir: paths.runDir,
  });
  return { runId: plan.runId, title: plan.title, deletedAt, deletedId, deletedDir };
}

export async function deleteBookPlans(options: {
  config: ResolvedBookWriterConfig;
  runIds: string[];
  now?: Date;
}): Promise<DeleteBookPlanResult[]> {
  const uniqueRunIds = [...new Set(options.runIds.map((runId) => runId.trim()).filter(Boolean))];
  if (!uniqueRunIds.length) {
    throw new Error("runIds is required.");
  }
  const deleted: DeleteBookPlanResult[] = [];
  const now = options.now ?? new Date();
  for (const runId of uniqueRunIds) {
    deleted.push(await deleteBookPlan({ config: options.config, runId, now }));
  }
  return deleted;
}

export async function archiveBookPlan(options: {
  config: ResolvedBookWriterConfig;
  runId: string;
  now?: Date;
}): Promise<ArchiveBookPlanResult> {
  const plan = await readBookPlan(options.config, options.runId);
  if (!plan) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  const paths = resolveRunPaths(options.config.outputDir, options.runId);
  const archivedAt = (options.now ?? new Date()).toISOString();
  const archivedRoot = path.join(paths.rootDir, ARCHIVED_BOOKS_DIR);
  await fs.mkdir(archivedRoot, { recursive: true });
  const archivedSlug = `${archivedAt.replace(/[:.]/g, "-")}-${paths.runId}`;
  let archivedId = archivedSlug;
  let archivedDir = path.join(archivedRoot, archivedSlug);
  for (let index = 2; await fileExists(archivedDir); index += 1) {
    archivedId = `${archivedSlug}-${index}`;
    archivedDir = path.join(archivedRoot, archivedId);
  }
  await fs.rename(paths.runDir, archivedDir);
  await writeJsonFile(path.join(archivedDir, "archived-book.json"), {
    runId: plan.runId,
    title: plan.title,
    archivedAt,
    originalDir: paths.runDir,
  });
  return { runId: plan.runId, title: plan.title, archivedAt, archivedId, archivedDir };
}

function assertArchiveId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized !== path.basename(normalized) || normalized.startsWith(".")) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function assertDeletedId(deletedId: string): string {
  return assertArchiveId(deletedId, "deletedId");
}

function assertArchivedId(archivedId: string): string {
  return assertArchiveId(archivedId, "archivedId");
}

async function readArchivedBookTombstone(archivedDir: string): Promise<{
  archivedAt?: string;
  originalDir?: string;
} | null> {
  return (
    (await readJsonFile<{ archivedAt?: string; originalDir?: string }>(
      path.join(archivedDir, "archived-book.json"),
    )) ?? null
  );
}

export async function restoreArchivedBookPlan(options: {
  config: ResolvedBookWriterConfig;
  archivedId: string;
}): Promise<BookPlan> {
  const archivedId = assertArchivedId(options.archivedId);
  const archivedDir = path.join(options.config.outputDir, ARCHIVED_BOOKS_DIR, archivedId);
  const rawPlan = await readJsonFile<BookPlan>(path.join(archivedDir, BOOK_PLAN_FILE));
  if (!rawPlan) {
    throw new Error(`archived book plan not found: ${archivedId}`);
  }
  const plan = hydrateBookPlan(rawPlan);
  const restoredDir = resolveRunPaths(options.config.outputDir, plan.runId).runDir;
  if (await fileExists(restoredDir)) {
    throw new Error(`active book already exists: ${plan.runId}`);
  }
  await fs.rename(archivedDir, restoredDir);
  await fs.rm(path.join(restoredDir, "archived-book.json"), { force: true });
  return plan;
}

export async function deleteArchivedBookPlan(options: {
  config: ResolvedBookWriterConfig;
  archivedId: string;
  now?: Date;
}): Promise<DeleteBookPlanResult> {
  const archivedId = assertArchivedId(options.archivedId);
  const archivedDir = path.join(options.config.outputDir, ARCHIVED_BOOKS_DIR, archivedId);
  const rawPlan = await readJsonFile<BookPlan>(path.join(archivedDir, BOOK_PLAN_FILE));
  if (!rawPlan) {
    throw new Error(`archived book plan not found: ${archivedId}`);
  }
  const plan = hydrateBookPlan(rawPlan);
  const tombstone = await readArchivedBookTombstone(archivedDir);
  const deletedAt = (options.now ?? new Date()).toISOString();
  const deletedRoot = path.join(options.config.outputDir, DELETED_BOOKS_DIR);
  await fs.mkdir(deletedRoot, { recursive: true });
  const deletedSlug = `${deletedAt.replace(/[:.]/g, "-")}-${plan.runId}`;
  let deletedId = deletedSlug;
  let deletedDir = path.join(deletedRoot, deletedSlug);
  for (let index = 2; await fileExists(deletedDir); index += 1) {
    deletedId = `${deletedSlug}-${index}`;
    deletedDir = path.join(deletedRoot, deletedId);
  }
  await fs.rename(archivedDir, deletedDir);
  await fs.rm(path.join(deletedDir, "archived-book.json"), { force: true });
  await writeJsonFile(path.join(deletedDir, "deleted-book.json"), {
    runId: plan.runId,
    title: plan.title,
    deletedAt,
    originalDir:
      tombstone?.originalDir ?? resolveRunPaths(options.config.outputDir, plan.runId).runDir,
  });
  return { runId: plan.runId, title: plan.title, deletedAt, deletedId, deletedDir };
}

async function readDeletedBookTombstone(deletedDir: string): Promise<{
  deletedAt?: string;
  originalDir?: string;
} | null> {
  return (
    (await readJsonFile<{ deletedAt?: string; originalDir?: string }>(
      path.join(deletedDir, "deleted-book.json"),
    )) ?? null
  );
}

export async function restoreDeletedBookPlan(options: {
  config: ResolvedBookWriterConfig;
  deletedId: string;
}): Promise<BookPlan> {
  const deletedId = assertDeletedId(options.deletedId);
  const deletedDir = path.join(options.config.outputDir, DELETED_BOOKS_DIR, deletedId);
  const rawPlan = await readJsonFile<BookPlan>(path.join(deletedDir, BOOK_PLAN_FILE));
  if (!rawPlan) {
    throw new Error(`deleted book plan not found: ${deletedId}`);
  }
  const plan = hydrateBookPlan(rawPlan);
  const restoredDir = resolveRunPaths(options.config.outputDir, plan.runId).runDir;
  if (await fileExists(restoredDir)) {
    throw new Error(`active book already exists: ${plan.runId}`);
  }
  await fs.rename(deletedDir, restoredDir);
  await fs.rm(path.join(restoredDir, "deleted-book.json"), { force: true });
  return plan;
}

export async function deleteDeletedBookPlan(options: {
  config: ResolvedBookWriterConfig;
  deletedId: string;
}): Promise<{ deletedId: string; runId: string; title: string }> {
  const deletedId = assertDeletedId(options.deletedId);
  const deletedDir = path.join(options.config.outputDir, DELETED_BOOKS_DIR, deletedId);
  const rawPlan = await readJsonFile<BookPlan>(path.join(deletedDir, BOOK_PLAN_FILE));
  if (!rawPlan) {
    throw new Error(`deleted book plan not found: ${deletedId}`);
  }
  const plan = hydrateBookPlan(rawPlan);
  await fs.rm(deletedDir, { recursive: true, force: false });
  return { deletedId, runId: plan.runId, title: plan.title };
}

export async function emptyDeletedBookPlans(options: {
  config: ResolvedBookWriterConfig;
}): Promise<{ deletedCount: number }> {
  const deletedBooks = await listDeletedBookPlanProjects(options.config);
  for (const book of deletedBooks) {
    await deleteDeletedBookPlan({ config: options.config, deletedId: book.deletedId });
  }
  return { deletedCount: deletedBooks.length };
}

function assertFinishedId(finishedId: string): string {
  return assertArchiveId(finishedId, "finishedId");
}

async function readKdpDryRunReport(
  config: ResolvedBookWriterConfig,
  runId: string,
): Promise<KdpDryRunReport | null> {
  const paths = resolveRunPaths(config.outputDir, runId);
  return (
    (await readJsonFile<KdpDryRunReport>(path.join(paths.runDir, "kdp-dry-run-report.json"))) ??
    null
  );
}

function approvedCoverVariantPath(plan: BookPlan): string | undefined {
  return plan.cover.variants.find((variant) => variant.approved && variant.path)?.path;
}

function resolveFinishedCover(params: {
  plan: BookPlan;
  reviewPack: ReviewPack | null;
  dryRun: KdpDryRunReport | null;
}): { coverPath?: string; coverSource?: string } {
  const uploadCover = params.dryRun?.uploadManifest.files.coverUpload;
  if (uploadCover) {
    return { coverPath: uploadCover, coverSource: "KDP upload cover" };
  }
  const creatorBrief = params.dryRun?.uploadManifest.files.coverBrief;
  if (creatorBrief) {
    return { coverPath: creatorBrief, coverSource: "KDP Cover Creator brief" };
  }
  if (params.reviewPack?.artifacts.cover) {
    return { coverPath: params.reviewPack.artifacts.cover, coverSource: "review-pack cover" };
  }
  if (params.reviewPack?.artifacts.coverSvg) {
    return {
      coverPath: params.reviewPack.artifacts.coverSvg,
      coverSource: "review-pack cover preview",
    };
  }
  if (params.plan.artifactLinks.cover) {
    return { coverPath: params.plan.artifactLinks.cover, coverSource: "plan cover" };
  }
  const approvedVariant = approvedCoverVariantPath(params.plan);
  if (approvedVariant) {
    return { coverPath: approvedVariant, coverSource: "approved cover variant" };
  }
  return {};
}

function relocateArchivedPath(filePath: string | undefined, fromDir: string, toDir: string) {
  if (!filePath) {
    return undefined;
  }
  const relative = path.relative(fromDir, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.join(toDir, relative);
  }
  return filePath;
}

async function readCoverPreviewDataUrl(finishedDir: string): Promise<string | undefined> {
  const svgPath = path.join(finishedDir, "cover.svg");
  if (!(await fileExists(svgPath))) {
    return undefined;
  }
  const svg = await fs.readFile(svgPath, "utf8");
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function readFinishedBookTombstone(finishedDir: string): Promise<{
  finishedAt?: string;
  publishedAt?: string;
  originalDir?: string;
  coverPath?: string;
  coverSource?: string;
  publishProof?: PublishedBookProof;
  metrics?: PublishedBookMetrics;
} | null> {
  return (
    (await readJsonFile<{
      finishedAt?: string;
      publishedAt?: string;
      originalDir?: string;
      coverPath?: string;
      coverSource?: string;
      publishProof?: PublishedBookProof;
      metrics?: PublishedBookMetrics;
    }>(path.join(finishedDir, "finished-book.json"))) ?? null
  );
}

function normalizePublishedProof(params: {
  proof?: Partial<PublishedBookProof>;
  publishedAt: string;
}): PublishedBookProof {
  if (!params.proof?.operatorConfirmed) {
    throw new Error("manual publish confirmation is required before moving a book to Trophy Room.");
  }
  if (!params.proof.destination) {
    throw new Error("publish destination is required before moving a book to Trophy Room.");
  }
  if (!params.proof.publishedAt) {
    throw new Error("published date is required before moving a book to Trophy Room.");
  }
  const destination = params.proof.destination;
  return {
    destination,
    publishedAt: params.proof.publishedAt,
    operatorConfirmed: true,
    confirmedAt: params.proof.confirmedAt || params.publishedAt,
    ...(params.proof?.asin ? { asin: params.proof.asin } : {}),
    ...(params.proof?.marketplaceUrl ? { marketplaceUrl: params.proof.marketplaceUrl } : {}),
    ...(typeof params.proof?.priceUsd === "number" ? { priceUsd: params.proof.priceUsd } : {}),
    ...(params.proof?.category ? { category: params.proof.category } : {}),
    ...(params.proof?.keywords?.length
      ? { keywords: params.proof.keywords.map((keyword) => keyword.trim()).filter(Boolean) }
      : {}),
  };
}

function normalizePublishedMetrics(
  metrics: Partial<PublishedBookMetrics> | undefined,
  now: string,
): PublishedBookMetrics {
  const snapshots = (metrics?.snapshots ?? []).map((snapshot, index) => {
    const normalized: PublishedBookSalesSnapshot = {
      id: snapshot.id || `snapshot-${index + 1}`,
      label: snapshot.label || `Snapshot ${index + 1}`,
      unitsSold: snapshot.unitsSold || 0,
      revenueUsd: snapshot.revenueUsd || 0,
      adSpendUsd: snapshot.adSpendUsd || 0,
      profitUsd: snapshot.profitUsd || 0,
    };
    if (snapshot.rangeStart) {
      normalized.rangeStart = snapshot.rangeStart;
    }
    if (snapshot.rangeEnd) {
      normalized.rangeEnd = snapshot.rangeEnd;
    }
    if (typeof snapshot.kuPagesRead === "number") {
      normalized.kuPagesRead = snapshot.kuPagesRead;
    }
    if (typeof snapshot.royaltyUsd === "number") {
      normalized.royaltyUsd = snapshot.royaltyUsd;
    }
    if (snapshot.notes) {
      normalized.notes = snapshot.notes;
    }
    return normalized;
  });
  const snapshotTotals = snapshots.reduce(
    (acc, snapshot) => ({
      sales: acc.sales + snapshot.unitsSold,
      revenue: acc.revenue + snapshot.revenueUsd,
      adSpend: acc.adSpend + snapshot.adSpendUsd,
      profit: acc.profit + snapshot.profitUsd,
    }),
    { sales: 0, revenue: 0, adSpend: 0, profit: 0 },
  );
  return {
    totalSales: Number(metrics?.totalSales) || snapshotTotals.sales,
    totalRevenueUsd: Number(metrics?.totalRevenueUsd) || snapshotTotals.revenue,
    totalProfitUsd: Number(metrics?.totalProfitUsd) || snapshotTotals.profit,
    adSpendUsd: Number(metrics?.adSpendUsd) || snapshotTotals.adSpend,
    ...(typeof metrics?.ratingAverage === "number" ? { ratingAverage: metrics.ratingAverage } : {}),
    ...(typeof metrics?.reviewCount === "number" ? { reviewCount: metrics.reviewCount } : {}),
    snapshots,
    updatedAt: now,
  };
}

export async function finishBookPlan(options: {
  config: ResolvedBookWriterConfig;
  runId: string;
  now?: Date;
  proof?: Partial<PublishedBookProof>;
  metrics?: Partial<PublishedBookMetrics>;
}): Promise<FinishBookPlanResult> {
  const plan = await readBookPlan(options.config, options.runId);
  if (!plan) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  const paths = resolveRunPaths(options.config.outputDir, options.runId);
  const finishedAt = (options.now ?? new Date()).toISOString();
  const publishProof = normalizePublishedProof({ proof: options.proof, publishedAt: finishedAt });
  const metrics = normalizePublishedMetrics(options.metrics, finishedAt);
  const finishedRoot = path.join(paths.rootDir, FINISHED_BOOKS_DIR);
  await fs.mkdir(finishedRoot, { recursive: true });
  const finishedSlug = `${finishedAt.replace(/[:.]/g, "-")}-${paths.runId}`;
  let finishedId = finishedSlug;
  let finishedDir = path.join(finishedRoot, finishedSlug);
  for (let index = 2; await fileExists(finishedDir); index += 1) {
    finishedId = `${finishedSlug}-${index}`;
    finishedDir = path.join(finishedRoot, finishedId);
  }

  const reviewPack = await readReviewPack(options.config, options.runId);
  const dryRun = await readKdpDryRunReport(options.config, options.runId);
  const cover = resolveFinishedCover({ plan, reviewPack, dryRun });
  await fs.rename(paths.runDir, finishedDir);
  const coverPath = relocateArchivedPath(cover.coverPath, paths.runDir, finishedDir);
  await writeJsonFile(path.join(finishedDir, "finished-book.json"), {
    runId: plan.runId,
    title: plan.title,
    finishedAt,
    publishedAt: publishProof.publishedAt,
    publishProof,
    metrics,
    originalDir: paths.runDir,
    ...(coverPath ? { coverPath } : {}),
    ...(cover.coverSource ? { coverSource: cover.coverSource } : {}),
  });
  return {
    runId: plan.runId,
    title: plan.title,
    finishedAt,
    finishedId,
    finishedDir,
    ...(coverPath ? { coverPath } : {}),
    ...(cover.coverSource ? { coverSource: cover.coverSource } : {}),
  };
}

export async function restoreFinishedBookPlan(options: {
  config: ResolvedBookWriterConfig;
  finishedId: string;
}): Promise<BookPlan> {
  const finishedId = assertFinishedId(options.finishedId);
  const finishedDir = path.join(options.config.outputDir, FINISHED_BOOKS_DIR, finishedId);
  const rawPlan = await readJsonFile<BookPlan>(path.join(finishedDir, BOOK_PLAN_FILE));
  if (!rawPlan) {
    throw new Error(`finished book plan not found: ${finishedId}`);
  }
  const plan = hydrateBookPlan(rawPlan);
  const restoredDir = resolveRunPaths(options.config.outputDir, plan.runId).runDir;
  if (await fileExists(restoredDir)) {
    throw new Error(`active book already exists: ${plan.runId}`);
  }
  await fs.rename(finishedDir, restoredDir);
  await fs.rm(path.join(restoredDir, "finished-book.json"), { force: true });
  return plan;
}

export async function generateAndSaveBookPlanCoverConcept(
  options: PlanMutationOptions,
): Promise<BookPlan> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  const conceptPath = coverConceptPath(options.config, existing.runId);
  const plan = await saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan: {
      ...existing,
      cover: {
        ...existing.cover,
        status: "generated",
        brief: `Commercial ${existing.genre} cover for "${existing.title}" with strong thumbnail readability, original imagery, and restrained typography.`,
        prompt: `Create an original ${existing.genre} book cover for "${existing.title}" that reflects ${readerFacingTopic(
          existing.brief.topicParagraph,
        ).toLowerCase()}, leaves clean title space, and looks professional in a retail thumbnail.`,
        variants: [
          {
            id: "auto-concept",
            label: "Editable SVG concept",
            path: conceptPath,
            source: "svg-concept",
            prompt: `Create an original ${existing.genre} book cover for "${existing.title}" that reflects ${readerFacingTopic(
              existing.brief.topicParagraph,
            ).toLowerCase()}, leaves clean title space, and looks professional in a retail thumbnail.`,
            createdAt: (options.now ?? new Date()).toISOString(),
            mimeType: "image/svg+xml",
            approved: false,
          },
          ...existing.cover.variants.filter((variant) => variant.id !== "auto-concept"),
        ],
      },
    },
    action: "cover-generate",
    summary: "Generated an AI cover concept for publishing review.",
  });
  await writeCoverConceptArtifacts(plan);
  return plan;
}

function sanitizeCoverUploadFileName(fileName: string): string {
  const baseName = path.basename(fileName).replace(/[^A-Za-z0-9._-]+/g, "-");
  const extension = path.extname(baseName).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".tif", ".tiff", ".svg"].includes(extension)) {
    throw new Error("cover upload must be a JPEG, PNG, TIFF, or SVG file.");
  }
  return `uploaded-cover${extension}`;
}

export async function uploadBookPlanCover(
  options: PlanMutationOptions & {
    fileName: string;
    mimeType?: string;
    dataBase64: string;
  },
): Promise<BookPlan> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  const safeFileName = sanitizeCoverUploadFileName(options.fileName);
  const uploadPath = path.join(
    resolveRunPaths(options.config.outputDir, existing.runId).runDir,
    safeFileName,
  );
  await writeJsonFile(
    path.join(
      resolveRunPaths(options.config.outputDir, existing.runId).runDir,
      "cover-upload.json",
    ),
    {
      title: existing.title,
      originalFileName: options.fileName,
      mimeType: options.mimeType,
      savedAs: safeFileName,
      uploadedAt: (options.now ?? new Date()).toISOString(),
    },
  );
  await fs.writeFile(uploadPath, Buffer.from(options.dataBase64, "base64"));
  return saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan: {
      ...existing,
      cover: {
        ...existing.cover,
        status: "generated",
        variants: [
          ...existing.cover.variants.filter((variant) => variant.id !== "uploaded-cover"),
          {
            id: "uploaded-cover",
            label: "Uploaded cover",
            path: uploadPath,
            source: "upload",
            createdAt: (options.now ?? new Date()).toISOString(),
            mimeType: options.mimeType,
            approved: false,
          },
        ],
      },
    },
    action: "cover-upload",
    summary: "Uploaded a cover image for publishing review.",
  });
}

export async function approveBookPlanCover(
  options: PlanMutationOptions & {
    variantId?: string;
  },
): Promise<BookPlan> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  const selectedId = options.variantId ?? existing.cover.variants[0]?.id;
  if (!selectedId) {
    throw new Error("generate or upload a cover before approving it.");
  }
  const variants = existing.cover.variants.map((variant) => ({
    ...variant,
    approved: variant.id === selectedId,
  }));
  if (!variants.some((variant) => variant.approved)) {
    throw new Error(`cover variant not found: ${selectedId}`);
  }
  const approvedPath = variants.find((variant) => variant.approved)?.path;
  return saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan: {
      ...existing,
      cover: {
        ...existing.cover,
        status: "approved",
        variants,
      },
      artifactLinks: {
        ...existing.artifactLinks,
        ...(approvedPath ? { approvedCover: approvedPath } : {}),
      },
    },
    action: "cover-approve",
    summary: "Approved the cover route for publishing prep.",
  });
}

function paragraphDraft(params: {
  plan: BookPlan;
  chapter: BookPlanChapter;
  paragraph: BookPlanParagraph;
  previous?: BookPlanParagraph;
  next?: BookPlanParagraph;
}): string {
  const topic = readerFacingTopic(params.plan.topic);
  const chapterFocus = readerFacingTopic(params.chapter.description);
  const paragraphMove = readerFacingTopic(
    params.paragraph.summary ||
      params.paragraph.purpose ||
      params.paragraph.beats[0] ||
      params.paragraph.title,
  );
  const practical = isPracticalTopic(params.plan, params.chapter);
  const styleGuide = styleGuideForPlan(params.plan);
  const previousContext = params.previous?.text.trim()
    ? `It follows a moment where ${readerFacingTopic(params.previous.text.slice(0, 220)).toLowerCase()}.`
    : params.previous?.summary
      ? `It follows the prior idea about ${readerFacingTopic(params.previous.summary).toLowerCase()}.`
      : undefined;
  const nextContext = params.next?.summary
    ? `It leaves room for the next paragraph to move toward ${readerFacingTopic(params.next.summary).toLowerCase()}.`
    : undefined;
  const seed = practical
    ? practicalParagraphSentences({
        topic,
        chapterTitle: params.chapter.title,
        chapterFocus,
        paragraphMove,
        paragraphOrder: params.paragraph.order,
      })
    : narrativeParagraphSentences({
        topic,
        chapterTitle: params.chapter.title,
        chapterFocus,
        paragraphMove,
        paragraphOrder: params.paragraph.order,
        protagonist: inferPrimaryCharacterName(params.plan) ?? "Audrey",
      });
  seed.push(
    ...(previousContext ? [previousContext] : []),
    chapterRoleSentence(params.chapter, practical),
    toneSentence(styleGuide, practical),
    ...(localStyleSentence({
      chapter: params.chapter,
      paragraph: params.paragraph,
      practical,
    })
      ? [
          localStyleSentence({
            chapter: params.chapter,
            paragraph: params.paragraph,
            practical,
          })!,
        ]
      : []),
    profanitySentence(styleGuide, practical),
    ...(nextContext ? [nextContext] : []),
  );
  const target = Math.max(80, params.paragraph.targetWords);
  const drafted: string[] = [];
  for (
    let index = 0;
    countWords(drafted.join(" ")) < target && index < seed.length * 3;
    index += 1
  ) {
    drafted.push(seed[index % seed.length]);
  }
  return repairInstructionalBookText(drafted.join(" "));
}

type BookTextParagraphLocation = {
  chapter: BookPlanChapter;
  paragraph: BookPlanParagraph;
  chapterIndex: number;
  paragraphIndex: number;
};

type ChapterWindowDraftContext = {
  chapterDraftSoFar: string;
  chapterBeatMap: string;
  previousChapterSummary?: string;
  nextChapterSummary?: string;
};

function paragraphLocations(plan: BookPlan): BookTextParagraphLocation[] {
  return plan.chapters.flatMap((chapter, chapterIndex) =>
    chapter.paragraphs.map((paragraph, paragraphIndex) => ({
      chapter,
      paragraph,
      chapterIndex,
      paragraphIndex,
    })),
  );
}

function storyElementLine(plan: BookPlan): string {
  const topic = plan.topic;
  const protagonist =
    topic.match(/\b(?:name is|named)\s+([A-Z][A-Za-z0-9'’-]{2,})\b/)?.[1] ??
    topic.match(/\b([A-Z][A-Za-z0-9'’-]{2,})\s+(?:must|has to|needs to)\b/)?.[1] ??
    "Use the protagonist named or implied by the book idea.";
  const antagonist =
    topic.match(
      /\b(?:calls itself|called itself|named|is named)\s+([A-Z][A-Za-z0-9'’-]*(?:-[A-Z][A-Za-z0-9'’-]*)?(?:\s+[A-Z][A-Za-z0-9'’-]*){0,2})\b/,
    )?.[1] ?? "Use the antagonist, pressure, or opposing force named by the book idea.";
  const payoff =
    topic.match(
      /\b(?:called\s+)?([A-Z][A-Za-z0-9'’-]{4,}(?:\s+[A-Z][A-Za-z0-9'’-]{3,}){0,3})\s*\)/,
    )?.[1] ??
    topic.match(/\b(final\s+[A-Za-z0-9'’\-\s]{8,60})[.?!]/i)?.[1] ??
    "Preserve the ending or payoff promised by the book idea.";
  return [
    `Protagonist/lead: ${protagonist}.`,
    `Antagonist/opposition: ${antagonist}.`,
    `Major payoff: ${payoff}.`,
  ].join(" ");
}

function lockedBookTextContext(plan: BookPlan, targetParagraphId?: string): string {
  const before: string[] = [];
  const after: string[] = [];
  let passedTarget = false;
  for (const { chapter, paragraph } of paragraphLocations(plan)) {
    if (paragraph.id === targetParagraphId) {
      passedTarget = true;
      continue;
    }
    if (!(paragraph.locked || paragraph.fieldLocks?.text) || !paragraph.text.trim()) {
      continue;
    }
    const line = `Chapter ${chapter.number}, paragraph ${paragraph.order}: ${trimForSuggestion(
      paragraph.text,
      70,
    )}`;
    if (passedTarget) {
      after.push(line);
    } else {
      before.push(line);
    }
  }
  const pieces = [
    before.length ? `Locked text before this point:\n${before.slice(-5).join("\n")}` : "",
    after.length ? `Locked text after this point:\n${after.slice(0, 5).join("\n")}` : "",
  ].filter(Boolean);
  return pieces.join("\n\n") || "No locked Book Text yet.";
}

function surroundingBookTextContext(params: {
  previous?: BookPlanParagraph;
  next?: BookPlanParagraph;
}): string {
  const before =
    params.previous?.text.trim() || params.previous?.summary || params.previous?.purpose;
  const after = params.next?.text.trim() || params.next?.summary || params.next?.purpose;
  return [
    before ? `Previous paragraph context: ${trimForSuggestion(before, 90)}` : "",
    after ? `Next paragraph context: ${trimForSuggestion(after, 90)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function chapterWindowDraftContext(params: {
  plan: BookPlan;
  chapter: BookPlanChapter;
  chapterIndex: number;
  generatedById?: Map<string, string>;
}): ChapterWindowDraftContext {
  const chapterDraftSoFar = params.chapter.paragraphs
    .map((paragraph) => params.generatedById?.get(paragraph.id) ?? paragraph.text.trim())
    .filter(Boolean)
    .slice(-4)
    .map((text, index) => `Recent chapter paragraph ${index + 1}: ${trimForSuggestion(text, 90)}`)
    .join("\n");
  const chapterBeatMap = params.chapter.paragraphs
    .map(
      (paragraph) =>
        `Paragraph ${paragraph.order}${paragraph.locked || paragraph.fieldLocks?.text ? " LOCKED" : ""}: ${
          paragraph.summary || paragraph.purpose || paragraph.title
        }`,
    )
    .join("\n");
  const previousChapter = params.plan.chapters[params.chapterIndex - 1];
  const nextChapter = params.plan.chapters[params.chapterIndex + 1];
  return {
    chapterDraftSoFar: chapterDraftSoFar || "No earlier drafted prose in this chapter yet.",
    chapterBeatMap,
    previousChapterSummary: previousChapter
      ? `Previous chapter ${previousChapter.number} "${previousChapter.title}": ${trimForSuggestion(
          previousChapter.description,
          140,
        )}`
      : undefined,
    nextChapterSummary: nextChapter
      ? `Next chapter ${nextChapter.number} "${nextChapter.title}": ${trimForSuggestion(
          nextChapter.description,
          140,
        )}`
      : undefined,
  };
}

function bookTextPrompt(params: {
  plan: BookPlan;
  chapter: BookPlanChapter;
  paragraph: BookPlanParagraph;
  previous?: BookPlanParagraph;
  next?: BookPlanParagraph;
  chapterWindow?: ChapterWindowDraftContext;
}): string {
  const packet = buildParagraphContextPacket({
    plan: params.plan,
    chapter: params.chapter,
    paragraph: params.paragraph,
    previous: params.previous,
    next: params.next,
    userInstruction:
      "Write exactly one paragraph of final manuscript prose for OpenClaw Book Studio.",
  });
  const styleGuide = styleGuideForPlan(params.plan);
  const cohesion = buildCohesionArtifacts(params.plan);
  const chapterContinuity = cohesion.canon.chapterContinuity.find(
    (chapter) => chapter.chapterId === params.chapter.id,
  );
  const sceneNode = cohesion.sceneGraph.nodes.find(
    (node) => node.paragraphId === params.paragraph.id,
  );
  return [
    buildParagraphRewritePrompt(packet),
    "",
    "OpenClaw output rules:",
    "- Return only the paragraph readers will see. No markdown. No heading. No title. No label.",
    "- Do not explain what the paragraph should do.",
    "- Do not mention AI, plans, summaries, prompts, chapters as writing units, or the reader as a target.",
    "- Do not write phrases like: this paragraph, this chapter, this book, a useful book on, the reader should, has to begin, becomes practical when, the voice stayed.",
    "- Use concrete scene action, sensory detail, character choice, dialogue, and consequence when the topic is fiction.",
    "- For nonfiction, write direct publishable prose, not planning notes.",
    `Book title: ${params.plan.title}`,
    `Audience: ${params.plan.brief.audience}`,
    `Reader promise: ${params.plan.brief.readerPromise}`,
    `Tone: ${styleGuide.toneDescription}`,
    `Profanity rule: ${styleGuide.profanityDescription}`,
    `Story elements: ${storyElementLine(params.plan)}`,
    `Whole-book canon: premise=${cohesion.canon.premise}; reader promise=${cohesion.canon.readerPromise}; genre=${cohesion.canon.genre}; audience=${cohesion.canon.audience}.`,
    chapterContinuity
      ? `Chapter continuity: enter=${chapterContinuity.continuityIn.join(
          " ",
        )} exit=${chapterContinuity.continuityOut.join(" ")} theme=${chapterContinuity.themeMove}`
      : "",
    sceneNode
      ? `Scene beat: ${sceneNode.purpose}. Transition in: ${sceneNode.transitionIn} Transition out: ${sceneNode.transitionOut}`
      : "",
    finalResolutionGuidanceForPrompt({
      plan: params.plan,
      chapter: params.chapter,
      paragraph: params.paragraph,
    }),
    params.chapterWindow
      ? `Chapter drafting window:\n${[
          params.chapterWindow.previousChapterSummary,
          `Chapter beat map:\n${params.chapterWindow.chapterBeatMap}`,
          `Chapter draft so far:\n${params.chapterWindow.chapterDraftSoFar}`,
          params.chapterWindow.nextChapterSummary,
        ]
          .filter(Boolean)
          .join("\n")}`
      : "",
    `Locked nearby text:\n${lockedBookTextContext(params.plan, params.paragraph.id)}`,
    `Locked constraints:\n${lockedContextForPrompt(cohesion, params.paragraph.id)}`,
    `Target length: about ${Math.max(90, params.paragraph.targetWords)} words.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function bookTextRepairPrompt(params: {
  plan: BookPlan;
  chapter: BookPlanChapter;
  paragraph: BookPlanParagraph;
  previous?: BookPlanParagraph;
  next?: BookPlanParagraph;
  chapterWindow?: ChapterWindowDraftContext;
  rejectedText: string;
}): string {
  return [
    "Repair the rejected Book Text into actual final manuscript prose.",
    "Return only one publishable paragraph. No markdown, no labels, no planning language.",
    "Remove all meta-writing such as 'this paragraph', 'this chapter', 'this book', 'a useful book on', 'the reader should', or 'becomes practical when'.",
    "If this is fiction, turn the idea into a concrete scene with character action and sensory detail.",
    "",
    bookTextPrompt(params),
    "",
    `Rejected text to convert, not copy:\n${params.rejectedText}`,
  ].join("\n");
}

function normalizeGeneratedBookText(text: string): string {
  return text
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^#{1,6}\s+.+$/gm, "")
    .replace(/^\s*(?:book text|final prose|paragraph|chapter \d+)\s*:\s*/gim, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readerPromiseCallbackWords(plan: BookPlan): string[] {
  return plan.brief.readerPromise
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((word) => word.length >= 5)
    .slice(0, 8);
}

function finalResolutionGuidanceForPrompt(params: {
  plan: BookPlan;
  chapter: BookPlanChapter;
  paragraph?: BookPlanParagraph;
}): string {
  const isFinalChapter = params.plan.chapters.at(-1)?.id === params.chapter.id;
  if (!isFinalChapter) {
    return "";
  }
  const isFinalParagraph =
    params.paragraph === undefined || params.chapter.paragraphs.at(-1)?.id === params.paragraph.id;
  const callbackWords = readerPromiseCallbackWords(params.plan);
  return [
    "Final-chapter resolution contract:",
    "- Resolve the central problem promised by the book instead of deferring it to a later scene.",
    "- Do not introduce a new unresolved threat, warning, clue, witness problem, or cliffhanger.",
    "- Show the payoff in concrete story or argument terms: reveal, consequence, decision, and closure.",
    callbackWords.length
      ? `- Echo the reader promise naturally by using at least one callback word if it fits: ${callbackWords.join(
          ", ",
        )}.`
      : "",
    isFinalParagraph
      ? "- This is the book's final paragraph: end with closure, not setup for another chapter."
      : "- Build directly toward the final paragraph's closure.",
  ]
    .filter(Boolean)
    .join("\n");
}

function chapterBatchDraftPrompt(params: {
  plan: BookPlan;
  chapter: BookPlanChapter;
  chapterIndex: number;
  paragraphs: BookPlanParagraph[];
  generatedById: Map<string, string>;
}): string {
  const planWithGeneratedChapter = {
    ...params.plan,
    chapters: params.plan.chapters.map((chapter) =>
      chapter.id === params.chapter.id ? params.chapter : chapter,
    ),
  };
  const cohesion = buildCohesionArtifacts(planWithGeneratedChapter);
  const window = chapterWindowDraftContext({
    plan: params.plan,
    chapter: params.chapter,
    chapterIndex: params.chapterIndex,
    generatedById: params.generatedById,
  });
  const packet = buildChapterContextPacket({
    plan: planWithGeneratedChapter,
    chapter: params.chapter,
    chapterIndex: params.chapterIndex,
    userInstruction:
      "Draft a coherent multi-paragraph chapter window and return JSON mapped to paragraph ids.",
  });
  return [
    buildChapterRewritePrompt(packet),
    "",
    "Draft a coherent multi-paragraph chapter window for OpenClaw Book Studio.",
    "",
    "Hard rules:",
    "- Return JSON only. No markdown.",
    "- Output exactly one entry for each requested paragraph id.",
    "- Each text value must be final reader-facing manuscript prose.",
    "- Do not include headings, labels, planning notes, or phrases like 'this paragraph' or 'the reader should'.",
    "- Do not change, quote-rewrite, or paraphrase locked text. Treat locked text as immutable story truth.",
    "- Keep the paragraphs cohesive as one scene/chapter movement, not isolated fragments.",
    "",
    `Book title: ${params.plan.title}`,
    `Book idea: ${params.plan.brief.topicParagraph}`,
    `Whole-book canon: premise=${cohesion.canon.premise}; reader promise=${cohesion.canon.readerPromise}; genre=${cohesion.canon.genre}; audience=${cohesion.canon.audience}.`,
    `Chapter ${params.chapter.number}: ${params.chapter.title}`,
    `Chapter plan: ${params.chapter.description}`,
    `Chapter role: ${chapterRoleSummary(params.chapter)}`,
    finalResolutionGuidanceForPrompt({ plan: planWithGeneratedChapter, chapter: params.chapter }),
    `Chapter drafting window:\n${[
      window.previousChapterSummary,
      `Chapter beat map:\n${window.chapterBeatMap}`,
      `Chapter draft so far:\n${window.chapterDraftSoFar}`,
      window.nextChapterSummary,
    ]
      .filter(Boolean)
      .join("\n")}`,
    `Locked constraints:\n${lockedContextForPrompt(cohesion, params.paragraphs[0]?.id ?? "")}`,
    "Requested paragraphs:",
    ...params.paragraphs.map(
      (paragraph) =>
        `- ${paragraph.id}: order=${paragraph.order}; targetWords=${paragraph.targetWords}; plan=${
          paragraph.summary || paragraph.purpose || paragraph.title
        }`,
    ),
    "",
    'Return shape: {"paragraphs":[{"id":"paragraph-id","text":"publishable paragraph text"}]}',
  ].join("\n");
}

function parseChapterBatchDraft(text: string, requestedIds: Set<string>): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(text);
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== "object" || !("paragraphs" in parsed)) {
    return new Map();
  }
  const entries = (parsed as { paragraphs?: unknown }).paragraphs;
  if (!Array.isArray(entries)) {
    return new Map();
  }
  const generated = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = (entry as { id?: unknown }).id;
    const rawText = (entry as { text?: unknown }).text;
    if (typeof id !== "string" || typeof rawText !== "string" || !requestedIds.has(id)) {
      continue;
    }
    const normalized = normalizeGeneratedBookText(rawText);
    if (normalized && !looksLikeInstructionalBookText(normalized) && countWords(normalized) >= 35) {
      generated.set(id, normalized);
    }
  }
  return generated;
}

async function generateChapterWindowBookText(params: {
  config: ResolvedBookWriterConfig;
  plan: BookPlan;
  chapter: BookPlanChapter;
  chapterIndex: number;
  paragraphs: BookPlanParagraph[];
  generatedById: Map<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<Map<string, string>> {
  if (params.paragraphs.length < 2) {
    return new Map();
  }
  const requestedIds = new Set(params.paragraphs.map((paragraph) => paragraph.id));
  const generation = await generateText({
    config: params.config,
    prompt: chapterBatchDraftPrompt(params),
    liveModel: true,
    maxTokens: Math.max(
      700,
      Math.ceil(params.paragraphs.reduce((sum, paragraph) => sum + paragraph.targetWords, 0) * 2.1),
    ),
    timeoutMs: 120_000,
    fetchImpl: params.fetchImpl,
  });
  if (!generation.live || !generation.text.trim()) {
    return new Map();
  }
  return parseChapterBatchDraft(generation.text, requestedIds);
}

function paragraphStartsTooSimilarly(first: string, second: string): boolean {
  const firstWords = first
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");
  const secondWords = second
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");
  return Boolean(firstWords && secondWords && firstWords === secondWords);
}

function lockBridgeObligations(params: {
  previous?: BookPlanParagraph;
  next?: BookPlanParagraph;
}): string[] {
  const obligations: string[] = [];
  if (
    params.previous?.text.trim() &&
    (params.previous.locked || params.previous.fieldLocks?.text)
  ) {
    obligations.push("QA repair: acknowledge the locked paragraph immediately before this one.");
  }
  if (params.next?.text.trim() && (params.next.locked || params.next.fieldLocks?.text)) {
    obligations.push("QA repair: prepare the locked paragraph immediately after this one.");
  }
  return obligations;
}

function minimumCohesiveParagraphWords(paragraph: BookPlanParagraph): number {
  return Math.max(45, Math.floor(paragraph.targetWords * 0.25));
}

function expandThinDraftAfterRepair(params: {
  plan: BookPlan;
  chapter: BookPlanChapter;
  paragraph: BookPlanParagraph;
  text: string;
  next?: BookPlanParagraph;
}): string {
  if (countWords(params.text) >= minimumCohesiveParagraphWords(params.paragraph)) {
    return params.text;
  }
  const chapterFocus = readerFacingTopic(params.chapter.description).toLowerCase();
  const paragraphMove = readerFacingTopic(
    params.paragraph.summary || params.paragraph.purpose || params.paragraph.title,
  ).toLowerCase();
  const nextMove = params.next
    ? readerFacingTopic(
        params.next.summary || params.next.purpose || params.next.title,
      ).toLowerCase()
    : "the next consequence";
  const protagonist = inferPrimaryCharacterName(params.plan) ?? "Mara";
  return [
    params.text.replace(/\s+/g, " ").trim(),
    `That consequence kept ${chapterFocus} tied to ${paragraphMove}, pushed ${protagonist} toward ${nextMove}, and made the forged-invoice trail feel continuous instead of reset.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function qaRepairGeneratedParagraph(params: {
  plan: BookPlan;
  chapter: BookPlanChapter;
  paragraph: BookPlanParagraph;
  text: string;
  previous?: BookPlanParagraph;
  next?: BookPlanParagraph;
  batchGenerated: boolean;
  lockBridgeAlreadyRepaired?: boolean;
}): Pick<
  BookPlanParagraph,
  "text" | "transitionIn" | "transitionOut" | "continuityObligations" | "revisionStatus"
> {
  const lockObligations = lockBridgeObligations({ previous: params.previous, next: params.next });
  const issues: string[] = [];
  if (lockObligations.length && !params.lockBridgeAlreadyRepaired) {
    issues.push("lock-integration");
  }
  if (
    params.previous?.text.trim() &&
    paragraphStartsTooSimilarly(params.previous.text, params.text)
  ) {
    issues.push("repetitive-opening");
  }
  if (countWords(params.text) < minimumCohesiveParagraphWords(params.paragraph)) {
    issues.push("thin-draft");
  }
  const auditPacket = buildParagraphContextPacket({
    plan: params.plan,
    chapter: params.chapter,
    paragraph: params.paragraph,
    previous: params.previous,
    next: params.next,
    userInstruction: "Audit generated Book Text before saving it.",
  });
  const cohesionAudit = scoreCohesion({
    packet: auditPacket,
    candidateText: params.text,
  });
  if (cohesionAudit.status !== "pass") {
    issues.push(
      ...cohesionAudit.issues.map((issue) => `cohesion-${cohesionAudit.minimumScore}: ${issue}`),
    );
  }
  const transitionIn = params.previous?.text.trim()
    ? params.previous.locked || params.previous.fieldLocks?.text
      ? "Continue from the locked paragraph immediately before this one and make its consequence visible."
      : "Continue naturally from the prior Book Text without resetting the scene or argument."
    : "Open this beat while preserving the chapter role and whole-book promise.";
  const transitionOut = params.next?.text.trim()
    ? params.next.locked || params.next.fieldLocks?.text
      ? "Prepare the locked paragraph immediately after this one so it feels inevitable."
      : "Hand off directly into the following existing Book Text."
    : "Create forward motion into the next planned beat.";
  return {
    text: params.text,
    transitionIn,
    transitionOut,
    continuityObligations: [
      `Preserve chapter ${params.chapter.number} role: ${chapterRoleSummary(params.chapter)}.`,
      `Preserve book promise: ${params.plan.brief.readerPromise}.`,
      ...lockObligations,
      ...(lockedBookTextContext(params.plan, params.paragraph.id) === "No locked Book Text yet."
        ? []
        : ["Bridge around locked Book Text without changing it."]),
      ...(params.batchGenerated
        ? ["Drafted through multi-paragraph chapter-window generation."]
        : []),
      `Cohesion audit minimum score: ${cohesionAudit.minimumScore}/10.`,
      ...cohesionAudit.revisionInstructions,
      ...issues.map((issue) => `QA checked: ${issue}.`),
    ],
    revisionStatus:
      cohesionAudit.minimumScore < 6
        ? "blocked-by-cohesion-failure"
        : issues.length
          ? "needs-context-repair"
          : "clean",
  };
}

function bookTextRevisionPrompt(params: {
  plan: BookPlan;
  chapter: BookPlanChapter;
  paragraph: BookPlanParagraph;
  previous?: BookPlanParagraph;
  next?: BookPlanParagraph;
  chapterWindow?: ChapterWindowDraftContext;
  text: string;
  revision: Pick<
    BookPlanParagraph,
    "transitionIn" | "transitionOut" | "continuityObligations" | "revisionStatus"
  >;
}): string {
  return [
    "Revise one editable Book Studio paragraph after QA.",
    "",
    "Hard rules:",
    "- Return only one final publishable paragraph.",
    "- Do not include markdown, labels, headings, JSON, or planning language.",
    "- Do not change locked text. Do not quote-rewrite locked text as a substitute.",
    "- Repair continuity, transition, style, repetition, and locked-content integration issues.",
    "- Preserve the paragraph's intended meaning and the book's reader promise.",
    "",
    bookTextPrompt(params),
    "",
    `QA status: ${params.revision.revisionStatus ?? "clean"}`,
    `QA transition in: ${params.revision.transitionIn ?? ""}`,
    `QA transition out: ${params.revision.transitionOut ?? ""}`,
    `QA obligations:\n${(params.revision.continuityObligations ?? []).join("\n")}`,
    "",
    `Current editable paragraph to revise:\n${params.text}`,
  ].join("\n");
}

async function repairGeneratedParagraphWithModel(params: {
  config: ResolvedBookWriterConfig;
  plan: BookPlan;
  chapter: BookPlanChapter;
  chapterIndex: number;
  paragraph: BookPlanParagraph;
  paragraphIndex: number;
  text: string;
  revision: Pick<
    BookPlanParagraph,
    "transitionIn" | "transitionOut" | "continuityObligations" | "revisionStatus"
  >;
  batchGenerated: boolean;
  generatedById?: Map<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<
  Pick<
    BookPlanParagraph,
    "text" | "transitionIn" | "transitionOut" | "continuityObligations" | "revisionStatus"
  >
> {
  if (params.revision.revisionStatus === "clean") {
    return { ...params.revision, text: params.text };
  }
  const previous = params.chapter.paragraphs[params.paragraphIndex - 1];
  const next = params.chapter.paragraphs[params.paragraphIndex + 1];
  const generation = await generateText({
    config: params.config,
    prompt: bookTextRevisionPrompt({
      plan: params.plan,
      chapter: params.chapter,
      paragraph: params.paragraph,
      previous,
      next,
      chapterWindow: chapterWindowDraftContext({
        plan: params.plan,
        chapter: params.chapter,
        chapterIndex: params.chapterIndex,
        generatedById: params.generatedById,
      }),
      text: params.text,
      revision: params.revision,
    }),
    liveModel: true,
    maxTokens: Math.max(260, Math.ceil(params.paragraph.targetWords * 2.2)),
    timeoutMs: 60_000,
    fetchImpl: params.fetchImpl,
  });
  if (!generation.live || !generation.text.trim()) {
    return { ...params.revision, text: params.text };
  }
  const repairedText = normalizeGeneratedBookText(generation.text);
  if (
    !repairedText ||
    looksLikeInstructionalBookText(repairedText) ||
    countWords(repairedText) < 35
  ) {
    return { ...params.revision, text: params.text };
  }
  const expandedText = expandThinDraftAfterRepair({
    plan: params.plan,
    chapter: params.chapter,
    paragraph: params.paragraph,
    text: repairedText,
    next,
  });
  return qaRepairGeneratedParagraph({
    plan: params.plan,
    chapter: params.chapter,
    paragraph: params.paragraph,
    text: expandedText,
    previous,
    next,
    batchGenerated: params.batchGenerated,
    lockBridgeAlreadyRepaired: true,
  });
}

async function generateReaderFacingBookText(params: {
  config: ResolvedBookWriterConfig;
  plan: BookPlan;
  chapter: BookPlanChapter;
  paragraph: BookPlanParagraph;
  previous?: BookPlanParagraph;
  next?: BookPlanParagraph;
  chapterWindow?: ChapterWindowDraftContext;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  let rejectedText = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? bookTextPrompt(params)
        : bookTextRepairPrompt({
            ...params,
            rejectedText,
          });
    const generation = await generateText({
      config: params.config,
      prompt,
      liveModel: true,
      maxTokens: Math.max(260, Math.ceil(params.paragraph.targetWords * 2.2)),
      timeoutMs: 60_000,
      fetchImpl: params.fetchImpl,
    });
    if (!generation.live || !generation.text.trim()) {
      throw new Error("AI did not return publishable prose. Nothing was changed.");
    }
    const text = normalizeGeneratedBookText(generation.text);
    if (text && !looksLikeInstructionalBookText(text) && countWords(text) >= 35) {
      return text;
    }
    rejectedText = text || generation.text.trim();
  }
  throw new Error("AI did not return publishable prose. Nothing was changed.");
}

async function draftBookPlanWithModel(params: {
  config: ResolvedBookWriterConfig;
  plan: BookPlan;
  fetchImpl?: typeof fetch;
}): Promise<BookPlan> {
  const generatedById = new Map<string, string>();
  const generatedRevisionById = new Map<
    string,
    Pick<
      BookPlanParagraph,
      "transitionIn" | "transitionOut" | "continuityObligations" | "revisionStatus"
    >
  >();
  for (const [chapterIndex, chapter] of params.plan.chapters.entries()) {
    if (chapter.locked) {
      continue;
    }
    const currentChapterParagraphs = chapter.paragraphs.map((candidate) => {
      const generated = generatedById.get(candidate.id);
      if (!generated) {
        return candidate;
      }
      return { ...candidate, text: generated };
    });
    const currentChapter = {
      ...chapter,
      paragraphs: currentChapterParagraphs,
    };
    const draftable = currentChapter.paragraphs.filter(
      (paragraph) =>
        !paragraph.locked &&
        !paragraph.fieldLocks?.text &&
        (!paragraph.text.trim() || looksLikeInstructionalBookText(paragraph.text)),
    );
    const batchGenerated = await generateChapterWindowBookText({
      config: params.config,
      plan: {
        ...params.plan,
        chapters: params.plan.chapters.map((chapter) =>
          chapter.id === currentChapter.id ? currentChapter : chapter,
        ),
      },
      chapter: currentChapter,
      chapterIndex,
      paragraphs: draftable,
      generatedById,
      fetchImpl: params.fetchImpl,
    });
    for (const [paragraphIndex, paragraph] of currentChapter.paragraphs.entries()) {
      if (
        paragraph.locked ||
        paragraph.fieldLocks?.text ||
        (paragraph.text.trim() && !looksLikeInstructionalBookText(paragraph.text))
      ) {
        continue;
      }
      let generated = batchGenerated.get(paragraph.id);
      const previous = currentChapter.paragraphs[paragraphIndex - 1];
      const next = currentChapter.paragraphs[paragraphIndex + 1];
      if (!generated) {
        generated = await generateReaderFacingBookText({
          config: params.config,
          plan: {
            ...params.plan,
            chapters: params.plan.chapters.map((chapter) =>
              chapter.id === currentChapter.id ? currentChapter : chapter,
            ),
          },
          chapter: currentChapter,
          paragraph,
          previous,
          next,
          chapterWindow: chapterWindowDraftContext({
            plan: params.plan,
            chapter: currentChapter,
            chapterIndex,
            generatedById,
          }),
          fetchImpl: params.fetchImpl,
        });
      }
      generatedById.set(paragraph.id, generated);
      const qaRepaired = qaRepairGeneratedParagraph({
        plan: params.plan,
        chapter: currentChapter,
        paragraph,
        text: generated,
        previous,
        next,
        batchGenerated: batchGenerated.has(paragraph.id),
      });
      const aiRepaired = await repairGeneratedParagraphWithModel({
        config: params.config,
        plan: params.plan,
        chapter: currentChapter,
        chapterIndex,
        paragraph,
        paragraphIndex,
        text: qaRepaired.text,
        revision: qaRepaired,
        batchGenerated: batchGenerated.has(paragraph.id),
        generatedById,
        fetchImpl: params.fetchImpl,
      });
      generatedById.set(paragraph.id, aiRepaired.text);
      generatedRevisionById.set(paragraph.id, aiRepaired);
    }
  }
  return {
    ...params.plan,
    status: "drafting",
    cohesionStatus: "drafted",
    chapters: params.plan.chapters.map((chapter) => {
      if (chapter.locked) {
        return chapter;
      }
      const paragraphs = chapter.paragraphs.map((paragraph) =>
        generatedById.has(paragraph.id)
          ? {
              ...paragraph,
              text: generatedById.get(paragraph.id) ?? paragraph.text,
              status: "drafted" as const,
              ...generatedRevisionById.get(paragraph.id),
            }
          : paragraph,
      );
      return {
        ...chapter,
        status: paragraphs.every((paragraph) => paragraph.status === "drafted")
          ? ("drafted" as const)
          : chapter.status,
        paragraphs,
      };
    }),
  };
}

async function draftBookPlanParagraphWithModel(params: {
  config: ResolvedBookWriterConfig;
  plan: BookPlan;
  paragraphId: string;
  replaceExisting?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<BookPlan> {
  const locations = paragraphLocations(params.plan);
  const location = locations.find((candidate) => candidate.paragraph.id === params.paragraphId);
  if (!location) {
    throw new Error(`paragraph not found: ${params.paragraphId}`);
  }
  const locked =
    location.chapter.locked ||
    location.paragraph.locked ||
    Boolean(location.paragraph.fieldLocks?.text);
  if (locked) {
    throw new Error("paragraph is locked.");
  }
  const existingText = Boolean(location.paragraph.text.trim());
  const existingInstructionalText = looksLikeInstructionalBookText(location.paragraph.text);
  if (existingText && !params.replaceExisting && !existingInstructionalText) {
    throw new Error("paragraph already has Book Text.");
  }
  const generated = await generateReaderFacingBookText({
    config: params.config,
    plan: params.plan,
    chapter: location.chapter,
    paragraph: location.paragraph,
    previous: location.chapter.paragraphs[location.paragraphIndex - 1],
    next: location.chapter.paragraphs[location.paragraphIndex + 1],
    chapterWindow: chapterWindowDraftContext({
      plan: params.plan,
      chapter: location.chapter,
      chapterIndex: location.chapterIndex,
    }),
    fetchImpl: params.fetchImpl,
  });
  const qaRepaired = qaRepairGeneratedParagraph({
    plan: params.plan,
    chapter: location.chapter,
    paragraph: location.paragraph,
    text: generated,
    previous: location.chapter.paragraphs[location.paragraphIndex - 1],
    next: location.chapter.paragraphs[location.paragraphIndex + 1],
    batchGenerated: false,
  });
  const repaired = await repairGeneratedParagraphWithModel({
    config: params.config,
    plan: params.plan,
    chapter: location.chapter,
    chapterIndex: location.chapterIndex,
    paragraph: location.paragraph,
    paragraphIndex: location.paragraphIndex,
    text: qaRepaired.text,
    revision: qaRepaired,
    batchGenerated: false,
    fetchImpl: params.fetchImpl,
  });
  return {
    ...params.plan,
    status: "drafting",
    cohesionStatus: "drafted",
    chapters: params.plan.chapters.map((chapter) =>
      chapter.id === location.chapter.id
        ? {
            ...chapter,
            paragraphs: chapter.paragraphs.map((paragraph) =>
              paragraph.id === params.paragraphId
                ? {
                    ...paragraph,
                    ...repaired,
                    status: "drafted" as const,
                  }
                : paragraph,
            ),
          }
        : chapter,
    ),
  };
}

function readerFacingTopic(value: string): string {
  const cleaned = value
    .replace(/\bChapter focus:\s*/gi, "")
    .replace(/\bThis paragraph says,?\s*in reader-facing form,?\s*/gi, "")
    .replace(/\bThe book is about\b/gi, "")
    .replace(/\bThe paragraph should\b/gi, "")
    .replace(/\bThis paragraph should\b/gi, "")
    .replace(/\bAI will\b/gi, "")
    .replace(/\bAI should\b/gi, "")
    .replace(/\bAI reads this\b/gi, "")
    .replace(/\bPlan for AI\b/gi, "")
    .replace(
      /\bOpen with a concrete image, tension, or question that pulls the reader forward\b/gi,
      "a concrete opening moment",
    )
    .replace(
      /\bExplain the situation enough for the reader to understand the stakes\b/gi,
      "clear context",
    )
    .replace(
      /\bAdvance one argument, clue, scene beat, or practical insight\b/gi,
      "one useful insight",
    )
    .replace(
      /\bAdd pressure, contrast, uncertainty, or a useful objection\b/gi,
      "a realistic complication",
    )
    .replace(
      /\bEnd with a decision, insight, or transition that makes the next paragraph necessary\b/gi,
      "a clear next step",
    )
    .replace(/\bOpen the book with\b/gi, "Introduce")
    .replace(/\bShow why\b/gi, "Show")
    .replace(/\bBreak down\b/gi, "Clarify")
    .replace(/\bIncrease obstacles and force\b/gi, "Bring pressure to")
    .replace(
      /\bReveal the missing angle that changes how the reader sees\b/gi,
      "Reveal the angle that changes",
    )
    .replace(/\bApply the book's core idea under\b/gi, "Apply the core idea under")
    .replace(
      /\bDeliver the payoff, conclusion, and practical closure\b/gi,
      "Deliver practical closure",
    )
    .replace(/\bLeave the reader with\b/gi, "Leave")
    .replace(/^an?\s+original\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.?!]+$/g, "")
    .trim();
  return cleaned || "the central promise of the book";
}

function readerFacingMove(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes("open with a concrete")) {
    return "a concrete opening moment";
  }
  if (normalized.includes("explain the situation")) {
    return "clear context";
  }
  if (normalized.includes("advance one argument") || normalized.includes("advance one")) {
    return "one useful insight";
  }
  if (normalized.includes("add pressure") || normalized.includes("contrast")) {
    return "a realistic complication";
  }
  if (normalized.includes("end with a decision") || normalized.includes("transition")) {
    return "a clear next step";
  }
  return readerFacingTopic(value);
}

function isPracticalTopic(plan: BookPlan, chapter: BookPlanChapter): boolean {
  const topicText = `${plan.topic} ${chapter.description}`.toLowerCase();
  if (
    /\b(mystery|fiction|novel|thriller|suspense|detective|case|clue|scene|story|quest|battle|monster|evil|villain|antagonist|protagonist|self[-\s]?aware|attack humanity|world|epic)\b/.test(
      topicText,
    )
  ) {
    return false;
  }
  if (
    /\b(practical|guide|field guide|how to|routine|habit|family|families|workflow|business|decision|supplies|emergency|reader|parents|home)\b/.test(
      topicText,
    )
  ) {
    return true;
  }
  const text = `${plan.topic} ${plan.genre} ${chapter.description}`.toLowerCase();
  if (
    /\b(mystery|fiction|novel|thriller|suspense|detective|case|clue|scene|story|quest|battle|monster|evil|villain|antagonist|protagonist|self[-\s]?aware|attack humanity|world|epic)\b/.test(
      text,
    )
  ) {
    return false;
  }
  return false;
}

function practicalParagraphSentences(params: {
  topic: string;
  chapterTitle: string;
  chapterFocus: string;
  paragraphMove: string;
  paragraphOrder: number;
}): string[] {
  const opener =
    params.paragraphOrder % 5 === 1
      ? `The morning usually starts before anyone feels ready.`
      : `On an ordinary day, one small decision can make the whole routine easier to trust.`;
  return [
    opener,
    `A reader does not need another complicated system; they need a clear move they can remember when the room gets loud and time feels short.`,
    `The safest place to begin is with one visible cue, one repeatable habit, and one person who knows what happens next.`,
    `${capitalizeSentence(params.paragraphMove)} becomes useful when it turns from an idea into something that can be done before stress takes over.`,
    `The routine should feel calm enough to repeat and specific enough that nobody has to guess.`,
    `That kind of clarity gives the reader confidence without pretending every home, family, or day will look the same.`,
  ].map((sentence) => sentence.replace(/\s+/g, " ").trim());
}

function narrativeParagraphSentences(params: {
  topic: string;
  chapterTitle: string;
  chapterFocus: string;
  paragraphMove: string;
  paragraphOrder: number;
  protagonist: string;
}): string[] {
  const opener =
    params.paragraphOrder % 5 === 1
      ? `The first sign of trouble looked small enough to ignore.`
      : `By the time the trail reached ${params.chapterTitle}, the quiet details had started to press together.`;
  return [
    opener,
    `${params.protagonist} kept a thumb on the edge of the invoice and read the numbers again, slower this time, because the mistake was too neat to be accidental.`,
    `Outside the office window, trucks rolled over the bridge with the lazy confidence of people who believed every bolt beneath them had been checked.`,
    `She thought about ${params.chapterFocus.toLowerCase()}, then circled the line item that did not belong and wrote the time beside it.`,
    `${capitalizeSentence(params.paragraphMove)} was no longer an abstract concern; it had a date, a signature, and a cost someone had tried to bury.`,
    `${params.protagonist} closed the folder without closing the question, and the room seemed to narrow around the evidence in her hands.`,
  ].map((sentence) => sentence.replace(/\s+/g, " ").trim());
}

function capitalizeSentence(value: string): string {
  const trimmed = readerFacingTopic(value).trim();
  return trimmed ? `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}` : "This moment";
}

export function looksLikeInstructionalBookText(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const markers = [
    "chapter focus:",
    "ai will",
    "ai should",
    "what ai will",
    "the book is about",
    "a useful book on",
    "the paragraph should",
    "this paragraph should",
    "this chapter should",
    "this book should",
    "the chapter should",
    "the section should",
    "plan for ai",
    "ai reads this",
    "in this part of",
    "write this paragraph",
    "use this paragraph",
    "this paragraph will",
    "this paragraph says",
    "the work in",
    "the reader should see why",
    "use original phrasing and avoid",
    "open with a concrete image",
    "explain the situation enough",
    "advance one argument",
    "add pressure, contrast",
    "end with a decision, insight",
    "has to begin",
    "becomes practical when",
    "becomes useful when",
    "the work in",
    "the voice stayed",
    "the routine should",
    "the reader should",
    "points toward the later reveal",
    "without naming it outright",
    "the reveal lands as a turning point",
    "earlier evidence should be read",
    "the scene now carries the consequence",
    "so the book does not reset afterward",
  ];
  const patterns = [
    /\bthe reader (?:can|will|should|must|needs to|has to)\b/,
    /\bthis (?:paragraph|chapter|section|book) (?:will|would|should|must|needs to|has to)\b/,
    /\b(?:a|an) useful book (?:on|about)\b/,
    /\b(?:has|needs) to begin in an ordinary moment\b/,
    /\b(?:becomes|become) (?:useful|practical) when\b/,
    /\bthe (?:voice|tone|prose|language) (?:stayed|stays|should stay)\b/,
    /\b(?:small|subtle) detail (?:now )?points? toward\b/,
    /\bforeshadow(?:ing)?\b.*\bwithout naming\b/,
  ];
  return (
    markers.some((marker) => normalized.includes(marker)) ||
    patterns.some((pattern) => pattern.test(normalized))
  );
}

export function stripInstructionalBookText(text: string): string {
  return text
    .replace(
      /(?:^|[\n\r]+)\s*A small detail now points toward the later reveal without naming it outright\.?\s*/giu,
      "\n\n",
    )
    .replace(
      /(?:^|[\n\r]+)\s*The reveal lands as a turning point, changing how the earlier evidence should be read\.?\s*/giu,
      "\n\n",
    )
    .replace(
      /(?:^|[\n\r]+)\s*The scene now carries the consequence of the reveal so the book does not reset afterward\.?\s*/giu,
      "\n\n",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function repairInstructionalBookText(text: string): string {
  return stripInstructionalBookText(text)
    .replace(/\bChapter focus:\s*/gi, "")
    .replace(/\bPlan for AI\b/gi, "The scene")
    .replace(/\bAI will write\b/gi, "The paragraph shows")
    .replace(/\bAI should write\b/gi, "The paragraph shows")
    .replace(/\bThe paragraph should\b/gi, "The paragraph")
    .replace(/\bThis paragraph should\b/gi, "This paragraph")
    .replace(/\bThis paragraph will\b/gi, "This paragraph")
    .replace(/\bThis paragraph says,?\s*in reader-facing form,?\s*/gi, "This paragraph ")
    .replace(/\bUse original phrasing and avoid source imitation\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function assertNoInstructionalBookText(plan: BookPlan): void {
  const offender = plan.chapters
    .flatMap((chapter) =>
      chapter.paragraphs.map((paragraph) => ({
        chapter,
        paragraph,
      })),
    )
    .find(
      ({ paragraph }) => paragraph.text.trim() && looksLikeInstructionalBookText(paragraph.text),
    );
  if (!offender) {
    return;
  }
  throw new Error(
    `paragraph ${offender.paragraph.order} in chapter ${offender.chapter.number} still looks like Plan for AI, not reader-facing Book Text.`,
  );
}

function firstMeaningfulWords(text: string, count = 5): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, count)
    .join(" ");
}

export function buildFinalCohesionReport(plan: BookPlan): BookPlanFinalCohesionReport {
  const findings: GateFinding[] = [];
  const paragraphs = plan.chapters.flatMap((chapter) =>
    chapter.paragraphs.map((paragraph) => ({ chapter, paragraph })),
  );
  const drafted = paragraphs.filter(({ paragraph }) => paragraph.text.trim());
  const unresolved = drafted.filter(
    ({ paragraph }) => paragraph.revisionStatus && paragraph.revisionStatus !== "clean",
  );
  findings.push({
    code: "unresolved-revision-map",
    status: unresolved.length === 0 ? "pass" : "fail",
    score: unresolved.length,
    message:
      unresolved.length === 0
        ? "No unresolved paragraph-level repair flags remain."
        : `${unresolved.length} paragraph(s) still require context/style repair before stitching.`,
  });
  const missingDrafts = paragraphs.length - drafted.length;
  findings.push({
    code: "whole-book-draft-coverage",
    status: missingDrafts === 0 && paragraphs.length > 0 ? "pass" : "fail",
    score: drafted.length,
    message:
      missingDrafts === 0
        ? "Every planned paragraph has Book Text."
        : `${missingDrafts} planned paragraph(s) are missing Book Text.`,
  });
  const repeatedChapterOpenings = plan.chapters
    .map((chapter) => chapter.paragraphs.find((paragraph) => paragraph.text.trim())?.text ?? "")
    .map((text) => firstMeaningfulWords(text))
    .filter(Boolean)
    .filter((opening, index, openings) => openings.indexOf(opening) !== index);
  findings.push({
    code: "chapter-opening-variety",
    status: repeatedChapterOpenings.length === 0 ? "pass" : "warn",
    score: repeatedChapterOpenings.length,
    message:
      repeatedChapterOpenings.length === 0
        ? "Chapter openings vary enough to avoid obvious book-level repetition."
        : `${repeatedChapterOpenings.length} chapter opening(s) begin too similarly.`,
  });
  const finalChapterText =
    plan.chapters
      .at(-1)
      ?.paragraphs.map((paragraph) => paragraph.text)
      .join(" ") ?? "";
  const promiseKeywords = readerPromiseCallbackWords(plan);
  const promiseHits = promiseKeywords.filter((word) =>
    finalChapterText.toLowerCase().includes(word),
  );
  findings.push({
    code: "final-reader-promise-callback",
    status: promiseKeywords.length === 0 || promiseHits.length > 0 ? "pass" : "warn",
    score: promiseHits.length,
    message:
      promiseKeywords.length === 0 || promiseHits.length > 0
        ? "Final chapter appears to call back to the reader promise."
        : "Final chapter does not clearly echo the reader promise.",
  });
  const lockedAdjacencyProblems = paragraphs.filter(({ chapter, paragraph }, index) => {
    if (!(paragraph.locked || paragraph.fieldLocks?.text) || !paragraph.text.trim()) {
      return false;
    }
    const before = paragraphs[index - 1];
    const after = paragraphs[index + 1];
    return (
      !chapter.locked &&
      ((!before?.paragraph.text.trim() && index > 0) ||
        (!after?.paragraph.text.trim() && index < paragraphs.length - 1))
    );
  });
  findings.push({
    code: "locked-block-bridges",
    status: lockedAdjacencyProblems.length === 0 ? "pass" : "fail",
    score: lockedAdjacencyProblems.length,
    message:
      lockedAdjacencyProblems.length === 0
        ? "Locked text has surrounding drafted bridge context where needed."
        : `${lockedAdjacencyProblems.length} locked block(s) lack surrounding drafted bridge context.`,
  });
  const hasFail = findings.some((finding) => finding.status === "fail");
  const hasWarn = findings.some((finding) => finding.status === "warn");
  return {
    status: hasFail ? "fail" : hasWarn ? "warn" : "pass",
    findings,
  };
}

function assertFinalCohesionReady(plan: BookPlan): void {
  const report = buildFinalCohesionReport(plan);
  const blocker = report.findings.find((finding) => finding.status === "fail");
  if (blocker) {
    throw new Error(`final cohesion audit failed: ${blocker.message}`);
  }
  const genreReport = buildGenreExcellenceReport(plan);
  const genreBlocker = genreReport.findings.find((finding) => finding.status === "fail");
  if (genreBlocker) {
    throw new Error(`genre excellence audit failed: ${genreBlocker.message}`);
  }
}

function genreFamilyForPlan(plan: BookPlan): BookPlanGenreExcellenceReport["genreFamily"] {
  const haystack = `${plan.genre} ${plan.topic} ${plan.brief.topicParagraph}`.toLowerCase();
  if (/\bmystery|detective|clue|fraud|invoice|murder|case\b/.test(haystack)) {
    return "mystery";
  }
  if (/\bmemoir|autobiograph|life story|personal story\b/.test(haystack)) {
    return "memoir";
  }
  if (/\bbusiness|startup|profit|sales|marketing|management|operator\b/.test(haystack)) {
    return "business";
  }
  if (/\beducat|curriculum|teach|student|learn|lesson|workbook\b/.test(haystack)) {
    return "education";
  }
  if (/\bguide|nonfiction|field guide|manual|how to|practical\b/.test(haystack)) {
    return "nonfiction";
  }
  return "fiction";
}

function chapterTexts(plan: BookPlan): string[] {
  return plan.chapters.map((chapter) =>
    chapter.paragraphs.map((paragraph) => paragraph.text).join(" "),
  );
}

function textHasAny(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

export function buildGenreExcellenceReport(plan: BookPlan): BookPlanGenreExcellenceReport {
  const genreFamily = genreFamilyForPlan(plan);
  const chapters = chapterTexts(plan);
  const manuscript = chapters.join("\n\n");
  const findings: GateFinding[] = [];
  const firstChapter = chapters[0] ?? "";
  const finalChapter = chapters.at(-1) ?? "";
  findings.push({
    code: "chapter-hook",
    status: textHasAny(
      firstChapter,
      /\b(invoice|clue|evidence|question|problem|risk|wanted|needed|found|opened|saw)\b/i,
    )
      ? "pass"
      : "warn",
    message: "Opening chapter hook scan completed.",
  });
  findings.push({
    code: "chapter-ending-momentum",
    status: textHasAny(
      manuscript,
      /\b(next|toward|waiting|revealed|decision|choice|door|file|answer|consequence)\b/i,
    )
      ? "pass"
      : "warn",
    message: "Chapter-ending momentum language scan completed.",
  });
  if (genreFamily === "mystery") {
    const evidenceChapters = chapters.filter((chapter) =>
      textHasAny(
        chapter,
        /\b(clue|invoice|signature|evidence|file|ledger|record|receipt|witness)\b/i,
      ),
    ).length;
    const revealOrPayoff = textHasAny(
      finalChapter || manuscript.slice(-1200),
      /\b(reveal|truth|answer|signature|solved|proved|evidence|caught|confessed)\b/i,
    );
    findings.push({
      code: "mystery-evidence-trail",
      status:
        evidenceChapters >= Math.max(2, Math.ceil(plan.chapters.length * 0.4)) ? "pass" : "fail",
      score: evidenceChapters,
      message: `${evidenceChapters} chapter(s) include concrete clue/evidence language.`,
    });
    findings.push({
      code: "mystery-payoff",
      status: revealOrPayoff ? "pass" : evidenceChapters === 0 ? "fail" : "warn",
      message: revealOrPayoff
        ? "Mystery payoff/reveal language appears near the ending."
        : "Mystery ending lacks clear payoff/reveal language.",
    });
  } else if (
    genreFamily === "nonfiction" ||
    genreFamily === "business" ||
    genreFamily === "education"
  ) {
    const practicalChapters = chapters.filter((chapter) =>
      textHasAny(
        chapter,
        /\b(step|framework|example|practice|use|apply|checklist|system|method|plan)\b/i,
      ),
    ).length;
    findings.push({
      code: "practical-application",
      status:
        practicalChapters >= Math.max(2, Math.ceil(plan.chapters.length * 0.4)) ? "pass" : "warn",
      score: practicalChapters,
      message: `${practicalChapters} chapter(s) include practical application language.`,
    });
    findings.push({
      code: "argument-chain",
      status: textHasAny(
        manuscript,
        /\b(because|therefore|so that|means|result|tradeoff|however|instead)\b/i,
      )
        ? "pass"
        : "warn",
      message: "Argument-chain connective scan completed.",
    });
  } else if (genreFamily === "memoir") {
    findings.push({
      code: "memoir-chronology",
      status: textHasAny(
        manuscript,
        /\b(before|after|later|then|when|years|morning|evening|child|adult)\b/i,
      )
        ? "pass"
        : "warn",
      message: "Memoir chronology language scan completed.",
    });
    findings.push({
      code: "memoir-reflection",
      status: textHasAny(manuscript, /\b(learned|understood|remembered|realized|felt|changed)\b/i)
        ? "pass"
        : "warn",
      message: "Memoir reflection language scan completed.",
    });
  } else {
    const emotionalChapters = chapters.filter((chapter) =>
      textHasAny(chapter, /\b(fear|hope|wanted|needed|choice|promise|risk|felt|heart|breath)\b/i),
    ).length;
    findings.push({
      code: "fiction-emotional-arc",
      status:
        emotionalChapters >= Math.max(2, Math.ceil(plan.chapters.length * 0.35)) ? "pass" : "warn",
      score: emotionalChapters,
      message: `${emotionalChapters} chapter(s) carry emotional-arc language.`,
    });
  }
  const hasFail = findings.some((finding) => finding.status === "fail");
  const hasWarn = findings.some((finding) => finding.status === "warn");
  return {
    genreFamily,
    status: hasFail ? "fail" : hasWarn ? "warn" : "pass",
    findings,
  };
}

export function draftBookPlan(plan: BookPlan): BookPlan {
  return {
    ...plan,
    status: "drafting",
    chapters: plan.chapters.map((chapter) => {
      if (chapter.locked) {
        return chapter;
      }
      const paragraphs: BookPlanParagraph[] = [];
      for (const [paragraphIndex, paragraph] of chapter.paragraphs.entries()) {
        if (
          paragraph.locked ||
          paragraph.fieldLocks?.text ||
          (paragraph.text.trim() && !looksLikeInstructionalBookText(paragraph.text))
        ) {
          paragraphs.push(paragraph);
          continue;
        }
        paragraphs.push({
          ...paragraph,
          text: paragraphDraft({
            plan,
            chapter,
            paragraph,
            previous: paragraphs[paragraphIndex - 1],
            next: chapter.paragraphs[paragraphIndex + 1],
          }),
          status: "drafted" as const,
        });
      }
      return {
        ...chapter,
        status: paragraphs.every((paragraph) => paragraph.status === "drafted")
          ? ("drafted" as const)
          : chapter.status,
        paragraphs,
      };
    }),
  };
}

export function draftBookPlanParagraph(
  plan: BookPlan,
  paragraphId: string,
  opts?: { replaceExisting?: boolean },
): BookPlan {
  let found = false;
  let locked = false;
  let existingText = false;
  let existingInstructionalText = false;
  const chapters = plan.chapters.map((chapter) => {
    const paragraphs = chapter.paragraphs.map((paragraph, paragraphIndex) => {
      if (paragraph.id !== paragraphId) {
        return paragraph;
      }
      found = true;
      locked = chapter.locked || paragraph.locked || Boolean(paragraph.fieldLocks?.text);
      existingText = Boolean(paragraph.text.trim());
      existingInstructionalText = looksLikeInstructionalBookText(paragraph.text);
      if (locked || (existingText && !opts?.replaceExisting && !existingInstructionalText)) {
        return paragraph;
      }
      return {
        ...paragraph,
        text: paragraphDraft({
          plan,
          chapter,
          paragraph,
          previous: chapter.paragraphs[paragraphIndex - 1],
          next: chapter.paragraphs[paragraphIndex + 1],
        }),
        status: "drafted" as const,
      };
    });
    return {
      ...chapter,
      paragraphs,
      status: paragraphs.every((paragraph) => paragraph.status === "drafted")
        ? ("drafted" as const)
        : chapter.status,
    };
  });
  if (!found) {
    throw new Error(`paragraph not found: ${paragraphId}`);
  }
  if (locked) {
    throw new Error("paragraph is locked.");
  }
  if (existingText && !opts?.replaceExisting && !existingInstructionalText) {
    throw new Error("paragraph already has Book Text.");
  }
  return { ...plan, status: "drafting", chapters };
}

export function fillParagraphPlanFields(plan: BookPlan, chapterId?: string): BookPlan {
  return {
    ...plan,
    status: "paragraph-plan",
    chapters: plan.chapters.map((chapter) => {
      if (chapterId && chapter.id !== chapterId) {
        return chapter;
      }
      if (chapter.locked) {
        return chapter;
      }
      return {
        ...chapter,
        paragraphs: chapter.paragraphs.map((paragraph) => {
          if (paragraph.locked) {
            return paragraph;
          }
          const summary = readerFacingParagraphSummary({
            chapterTitle: chapter.title,
            chapterDescription: chapter.description,
            paragraphTitle: paragraph.title,
            purpose: paragraph.summary || paragraph.purpose || paragraph.title,
          });
          const purpose = readerFacingParagraphSummary({
            chapterTitle: chapter.title,
            chapterDescription: chapter.description,
            paragraphTitle: paragraph.title,
            purpose:
              paragraph.summary ||
              paragraph.purpose ||
              `Move the reader through ${chapter.description} with one concrete beat.`,
          });
          return {
            ...paragraph,
            title: paragraph.fieldLocks?.title
              ? paragraph.title
              : paragraph.title.trim() || `Paragraph ${chapter.number}.${paragraph.order}`,
            summary: paragraph.fieldLocks?.summary ? paragraph.summary : summary,
            purpose: paragraph.fieldLocks?.purpose ? paragraph.purpose : purpose,
            styleDirection: paragraph.fieldLocks?.styleDirection
              ? paragraph.styleDirection
              : paragraph.styleDirection.trim() ||
                (chapter.role?.readerFeeling === "suspenseful"
                  ? "Keep the pressure clear and specific without breaking the book's main tone."
                  : "Keep this paragraph clear, reader-facing, and aligned with the chapter tone."),
          };
        }),
      };
    }),
  };
}

export function stitchBookPlan(plan: BookPlan): string {
  assertNoInstructionalBookText({
    ...plan,
    chapters: plan.chapters.map((chapter) => ({
      ...chapter,
      paragraphs: chapter.paragraphs.map((paragraph) => ({
        ...paragraph,
        text: stripInstructionalBookText(paragraph.text),
      })),
    })),
  });
  assertFinalCohesionReady(plan);
  const body = plan.chapters
    .map((chapter) => {
      const paragraphs = chapter.paragraphs
        .map((paragraph) => stripInstructionalBookText(paragraph.text))
        .filter(Boolean)
        .join("\n\n");
      return `## Chapter ${chapter.number}: ${chapter.title}\n\n${paragraphs}`;
    })
    .join("\n\n");
  return [`# ${plan.title}`, `By ${plan.penName}`, body].filter(Boolean).join("\n\n").trim() + "\n";
}

export async function stitchAndSaveBookPlan(
  options: PlanMutationOptions,
): Promise<{ plan: BookPlan; manuscript: string; manuscriptPath: string }> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  const paths = resolveRunPaths(options.config.outputDir, options.runId);
  const manuscript = stitchBookPlan(existing);
  const manuscriptPath = path.join(paths.runDir, "manuscript.md");
  await writeTextFile(manuscriptPath, manuscript);
  const publishPreview = buildPublishPreview(
    {
      runId: existing.runId,
      title: existing.title,
      subtitle: existing.subtitle,
      slug: existing.slug,
      penName: existing.penName,
      genre: existing.genre,
      readerPromise: existing.brief.readerPromise,
      premise: existing.brief.topicParagraph,
      cast: [],
      originalityStrategy: [],
      bannedDependencies: [],
      targetWords: existing.targetWords,
      createdAt: existing.createdAt,
    },
    manuscript,
  );
  const publishPreviewPath = path.join(paths.runDir, "publish-preview.json");
  await writeJsonFile(publishPreviewPath, publishPreview);
  const plan = await saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan: {
      ...existing,
      status: "stitched",
      artifactLinks: {
        ...existing.artifactLinks,
        manuscript: manuscriptPath,
        publishPreview: publishPreviewPath,
      },
    },
    action: "stitch",
    summary: "Stitched editable paragraph text into manuscript.md.",
  });
  return { plan, manuscript, manuscriptPath };
}

export async function draftAndSaveBookPlan(options: PlanMutationOptions): Promise<BookPlan> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  const plan = await draftBookPlanWithModel({
    config: options.config,
    plan: existing,
    fetchImpl: options.fetchImpl,
  });
  return saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan,
    action: "book-prose-writer",
    summary: "OpenClaw Book Writer book-prose-writer generated text for unlocked paragraphs.",
  });
}

export async function draftAndSaveBookPlanParagraph(
  options: PlanMutationOptions & {
    paragraphId: string;
    replaceExisting?: boolean;
  },
): Promise<BookPlan> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  const plan = await draftBookPlanParagraphWithModel({
    config: options.config,
    plan: existing,
    paragraphId: options.paragraphId,
    replaceExisting: options.replaceExisting,
    fetchImpl: options.fetchImpl,
  });
  return saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan,
    action: "book-prose-writer",
    summary: "OpenClaw Book Writer book-prose-writer generated Book Text for one paragraph.",
  });
}

export async function propagateAndSaveStoryImpact(options: PlanMutationOptions): Promise<BookPlan> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  let result = propagatePendingStoryImpact(existing);
  if (options.fetchImpl) {
    result = {
      ...result,
      plan: await rewritePropagatedParagraphsWithModel({
        config: options.config,
        plan: result.plan,
        paragraphIds: result.propagation.rewrittenParagraphIds,
        fetchImpl: options.fetchImpl,
      }),
    };
  }
  return saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan: result.plan,
    action: "story-impact-propagation",
    summary: result.propagation.summary,
    suppressStoryImpactDetection: true,
  });
}

async function rewritePropagatedParagraphsWithModel(params: {
  config: ResolvedBookWriterConfig;
  plan: BookPlan;
  paragraphIds: string[];
  fetchImpl: typeof fetch;
}): Promise<BookPlan> {
  const targetIds = new Set(params.paragraphIds.slice(0, 12));
  const nextChapters: BookPlanChapter[] = [];
  for (const chapter of params.plan.chapters) {
    const nextParagraphs: BookPlanParagraph[] = [];
    for (const paragraph of chapter.paragraphs) {
      if (
        !targetIds.has(paragraph.id) ||
        chapter.locked ||
        paragraph.locked ||
        paragraph.fieldLocks?.text
      ) {
        nextParagraphs.push(paragraph);
        continue;
      }
      const prompt = [
        "Rewrite exactly one paragraph of final reader-facing manuscript prose.",
        "This paragraph is part of a story-impact propagation pass after a major twist.",
        "Do not include labels, notes, markdown, or analysis.",
        "Preserve the existing story facts and make the twist feel coherent.",
        `Book premise: ${params.plan.brief.topicParagraph}`,
        `Reader promise: ${params.plan.brief.readerPromise}`,
        `Chapter ${chapter.number}: ${chapter.title} — ${chapter.description}`,
        `Paragraph purpose: ${paragraph.purpose || paragraph.summary}`,
        `Continuity obligations: ${(paragraph.continuityObligations ?? []).join(" ")}`,
        `Current paragraph draft: ${paragraph.text}`,
        `Target length: about ${paragraph.targetWords} words.`,
      ].join("\n");
      const generated = await generateText({
        config: params.config,
        prompt,
        fetchImpl: params.fetchImpl,
        maxTokens: Math.max(180, Math.ceil(paragraph.targetWords * 2.2)),
        timeoutMs: 120_000,
      }).catch(() => null);
      const text = generated?.text.trim();
      nextParagraphs.push(
        text && !looksLikeInstructionalBookText(text)
          ? {
              ...paragraph,
              text,
              status: "drafted",
              revisionStatus: "clean",
            }
          : paragraph,
      );
    }
    nextChapters.push({ ...chapter, paragraphs: nextParagraphs });
  }
  return { ...params.plan, chapters: nextChapters };
}

export async function rebalanceAndSaveBookPlan(
  options: PlanMutationOptions & { targetWords: number },
): Promise<BookPlan> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  let plan = condensePlanForTargetWords(existing, options.targetWords);
  if (options.fetchImpl) {
    plan = await rewriteRebalancedPlanWithModel({
      config: options.config,
      plan,
      source: existing,
      fetchImpl: options.fetchImpl,
    });
  }
  return saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan,
    action: "target-structure-rebalance",
    summary: `Rebalanced book structure to ${plan.targetWords} target words.`,
    suppressStoryImpactDetection: true,
  });
}

function condensePlanForTargetWords(plan: BookPlan, rawTargetWords: number): BookPlan {
  const targetWords = normalizeTargetWords(rawTargetWords, plan.targetWords);
  const chapterCount = chapterCountForTargetWords(targetWords);
  const chapterTarget = Math.max(1, Math.floor(targetWords / chapterCount));
  const paragraphCount = paragraphCountForChapterTarget(chapterTarget);
  const paragraphTarget = Math.max(40, Math.floor(chapterTarget / paragraphCount));
  const sourceParagraphs = plan.chapters.flatMap((chapter) => chapter.paragraphs);
  const lockedParagraphs = sourceParagraphs.filter(
    (paragraph) => paragraph.locked || paragraph.fieldLocks?.text,
  );
  const sourceSummary = sourceParagraphs
    .map((paragraph) => paragraph.text || paragraph.summary || paragraph.purpose || paragraph.title)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 480);
  const chapters = Array.from({ length: chapterCount }, (_item, chapterIndex) => {
    const sourceChapter = plan.chapters[chapterIndex] ?? plan.chapters.at(-1) ?? plan.chapters[0];
    const preservedLocked = chapterIndex === 0 ? lockedParagraphs.slice(0, paragraphCount - 1) : [];
    const generatedCount = Math.max(1, paragraphCount - preservedLocked.length);
    const title =
      chapterCount === 1 ? plan.title : (sourceChapter?.title ?? `Chapter ${chapterIndex + 1}`);
    const generatedParagraphs: BookPlanParagraph[] = Array.from(
      { length: generatedCount },
      (_paragraph, paragraphIndex) => ({
        id: idFor("para", [plan.runId, "rebalanced", chapterIndex + 1, paragraphIndex + 1]),
        order: paragraphIndex + 1,
        title:
          paragraphCount === 1 ? "Complete Short Story" : `Condensed Beat ${paragraphIndex + 1}`,
        summary:
          paragraphCount === 1
            ? `Condense the current book into one complete ${targetWords}-word story.`
            : `Condense source material into beat ${paragraphIndex + 1} for the new target length.`,
        purpose:
          paragraphCount === 1
            ? `Write a complete reader-facing short story preserving the best plot, twist, ending, and voice from: ${sourceSummary || plan.brief.topicParagraph}`
            : "Carry the condensed story forward while preserving the premise and reader promise.",
        beats: [
          "Use reader-facing prose only.",
          "Preserve the main premise and locked facts.",
          "Make the shorter structure feel intentional.",
        ],
        styleDirection: "Short-form structure: compress setup, conflict, turn, and payoff.",
        fieldLocks: {
          title: false,
          summary: false,
          purpose: false,
          styleDirection: false,
          text: false,
        },
        targetWords: paragraphTarget,
        text: "",
        locked: false,
        status: "planned",
        sourceParagraphIds: sourceParagraphs.map((paragraph) => paragraph.id),
      }),
    );
    const paragraphs = [...generatedParagraphs, ...preservedLocked].map((paragraph, index) =>
      Object.assign({}, paragraph, {
        order: index + 1,
        targetWords:
          paragraph.locked || paragraph.fieldLocks?.text ? paragraph.targetWords : paragraphTarget,
      }),
    );
    return {
      ...(sourceChapter ?? plan.chapters[0]),
      id: sourceChapter?.id ?? idFor("chapter", [plan.runId, "rebalanced", chapterIndex + 1]),
      number: chapterIndex + 1,
      title,
      description:
        chapterCount === 1
          ? `A complete ${targetWords}-word short-story version of the current book.`
          : `Condensed chapter ${chapterIndex + 1} for the new ${targetWords}-word target.`,
      targetWords: chapterTarget,
      locked: false,
      status: "planned",
      paragraphs,
    } satisfies BookPlanChapter;
  });
  return {
    ...plan,
    targetWords,
    status: "paragraph-plan",
    chapters,
    bookSync: {
      state: "needs-propagation",
      lastAnalyzedVersion: plan.version,
      lastSyncedVersion: plan.bookSync?.lastSyncedVersion,
      affectedChapterIds: chapters.map((chapter) => chapter.id),
      affectedParagraphIds: chapters.flatMap((chapter) =>
        chapter.paragraphs.map((paragraph) => paragraph.id),
      ),
      lockedConflictCount: lockedParagraphs.length,
      summary: `Target changed to ${targetWords.toLocaleString()} words; structure was rebalanced and Book Text needs review.`,
    },
  };
}

async function rewriteRebalancedPlanWithModel(params: {
  config: ResolvedBookWriterConfig;
  plan: BookPlan;
  source: BookPlan;
  fetchImpl: typeof fetch;
}): Promise<BookPlan> {
  const sourceText = params.source.chapters
    .flatMap((chapter) =>
      chapter.paragraphs.map((paragraph) => paragraph.text || paragraph.summary),
    )
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
  const chapters: BookPlanChapter[] = [];
  for (const chapter of params.plan.chapters) {
    const paragraphs: BookPlanParagraph[] = [];
    for (const paragraph of chapter.paragraphs) {
      if (paragraph.locked || paragraph.fieldLocks?.text) {
        paragraphs.push(paragraph);
        continue;
      }
      const prompt = [
        "Write final reader-facing prose for a rebalanced Book Studio draft.",
        "Condense the source book into the new target length without sounding like a summary.",
        "Preserve the strongest plot, twist, ending, voice, and locked facts.",
        "Return only the manuscript paragraph text.",
        `Book title: ${params.plan.title}`,
        `Reader promise: ${params.plan.brief.readerPromise}`,
        `Target paragraph words: ${paragraph.targetWords}`,
        `Paragraph purpose: ${paragraph.purpose}`,
        `Source material: ${sourceText || params.plan.brief.topicParagraph}`,
      ].join("\n");
      const generated = await generateText({
        config: params.config,
        prompt,
        fetchImpl: params.fetchImpl,
        maxTokens: Math.max(180, Math.ceil(paragraph.targetWords * 2.2)),
        timeoutMs: 120_000,
      }).catch(() => null);
      const text = generated?.text.trim();
      paragraphs.push(
        text && !looksLikeInstructionalBookText(text)
          ? { ...paragraph, text, status: "drafted", revisionStatus: "clean" }
          : paragraph,
      );
    }
    chapters.push({ ...chapter, paragraphs });
  }
  return {
    ...params.plan,
    chapters,
    bookSync: {
      lastAnalyzedVersion: params.plan.bookSync?.lastAnalyzedVersion,
      lastSyncedVersion: params.plan.bookSync?.lastSyncedVersion,
      affectedChapterIds:
        params.plan.bookSync?.affectedChapterIds ?? chapters.map((chapter) => chapter.id),
      affectedParagraphIds:
        params.plan.bookSync?.affectedParagraphIds ??
        chapters.flatMap((chapter) => chapter.paragraphs.map((paragraph) => paragraph.id)),
      lockedConflictCount: params.plan.bookSync?.lockedConflictCount ?? 0,
      cohesionScore: params.plan.bookSync?.cohesionScore,
      state: "fully-updated",
      summary: `Rebalanced to ${params.plan.targetWords.toLocaleString()} words with model-assisted condensed Book Text.`,
    },
  };
}

export async function fillAndSaveParagraphPlanFields(
  options: PlanMutationOptions & { chapterId?: string },
): Promise<BookPlan> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  return saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan: fillParagraphPlanFields(existing, options.chapterId),
    action: "paragraph-plan-architect",
    summary: options.chapterId
      ? "OpenClaw Book Writer paragraph-plan-architect filled unlocked paragraph plan fields for one chapter."
      : "OpenClaw Book Writer paragraph-plan-architect filled unlocked paragraph plan fields across the book.",
  });
}

export async function createQuickReadAndSave(options: {
  config: ResolvedBookWriterConfig;
  sourceRunId: string;
}): Promise<BookPlan> {
  const source = await readBookPlan(options.config, options.sourceRunId);
  if (!source) {
    throw new Error(`source book plan not found: ${options.sourceRunId}`);
  }
  const now = new Date();
  let quickRead = createQuickReadPlan({ config: options.config, source, now });
  const baseRunId = quickRead.runId;
  for (
    let index = 2;
    await fileExists(resolveRunPaths(options.config.outputDir, quickRead.runId).runDir);
    index += 1
  ) {
    quickRead = createQuickReadPlan({
      config: options.config,
      source,
      now,
      runId: `${baseRunId}-${index}`,
    });
  }
  return saveBookPlan({
    config: options.config,
    plan: quickRead,
    action: "create-quick-read",
    summary: `Created Quick Read Edition from ${source.runId}.`,
  });
}

export async function reorderChapter(
  options: PlanMutationOptions & {
    chapterId: string;
    direction: ReorderDirection;
  },
): Promise<BookPlan> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  const chapters = [...existing.chapters];
  const index = chapters.findIndex((chapter) => chapter.id === options.chapterId);
  const swapIndex = options.direction === "up" ? index - 1 : index + 1;
  if (index < 0 || swapIndex < 0 || swapIndex >= chapters.length) {
    return existing;
  }
  [chapters[index], chapters[swapIndex]] = [chapters[swapIndex], chapters[index]];
  return saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan: { ...existing, chapters },
    action: "reorder-chapter",
    summary: `Moved chapter ${options.direction}.`,
  });
}

export async function reorderParagraph(
  options: PlanMutationOptions & {
    chapterId: string;
    paragraphId: string;
    direction: ReorderDirection;
  },
): Promise<BookPlan> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  const chapters = existing.chapters.map((chapter) => {
    if (chapter.id !== options.chapterId) {
      return chapter;
    }
    const paragraphs = [...chapter.paragraphs];
    const index = paragraphs.findIndex((paragraph) => paragraph.id === options.paragraphId);
    const swapIndex = options.direction === "up" ? index - 1 : index + 1;
    if (index < 0 || swapIndex < 0 || swapIndex >= paragraphs.length) {
      return chapter;
    }
    [paragraphs[index], paragraphs[swapIndex]] = [paragraphs[swapIndex], paragraphs[index]];
    return { ...chapter, paragraphs };
  });
  return saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan: { ...existing, chapters },
    action: "reorder-paragraph",
    summary: `Moved paragraph ${options.direction}.`,
  });
}

function trimForSuggestion(value: string, maxWords: number): string {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= maxWords) {
    return value.trim();
  }
  return `${words.slice(0, maxWords).join(" ")}.`;
}

function titleCaseSuggestion(value: string, fallback: string): string {
  const words = readerFacingTopic(value)
    .split(/\s+/)
    .map((word) => word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter((word) => word.length > 0)
    .slice(0, 7);
  if (!words.length) {
    return fallback;
  }
  return words.map((word) => word.slice(0, 1).toUpperCase() + word.slice(1)).join(" ");
}

function aiHelpDirection(params: {
  intent: BookWriterAiHelpIntent;
  customDirection?: string;
}): string {
  return params.intent === "dramatic"
    ? "Add more tension, consequence, and emotional pressure"
    : params.intent === "humorous"
      ? "Add light wit without breaking the book's main tone"
      : params.intent === "clearer"
        ? "Make the idea plain, specific, and easy to follow"
        : params.intent === "custom" && params.customDirection?.trim()
          ? params.customDirection.trim()
          : "Improve flow, specificity, and fit with the surrounding book";
}

function improveFieldText(params: {
  target: BookWriterAiHelpTarget;
  intent: BookWriterAiHelpIntent;
  original: string;
  context: string;
  customDirection?: string;
}): string {
  const original = params.original.trim();
  const base = original || params.context;
  if (params.intent === "shorten") {
    return trimForSuggestion(base, params.target === "paragraphText" ? 90 : 32);
  }
  const direction = aiHelpDirection(params);
  if (params.target.endsWith("Style")) {
    return direction;
  }
  if (params.target === "paragraphSummary" || params.target === "paragraphPlan") {
    return `This paragraph says, in reader-facing form, ${readerFacingTopic(base).toLowerCase()} while naturally connecting to ${readerFacingTopic(params.context).toLowerCase()}.`;
  }
  if (params.target === "chapterDescription") {
    return `This chapter covers ${readerFacingTopic(base).toLowerCase()}, keeps the reader promise visible, and prepares the next part of the book without feeling detached.`;
  }
  if (params.target === "chapterTitle") {
    return titleCaseSuggestion(base || params.context, "A Clearer Chapter");
  }
  if (params.target === "paragraphTitle") {
    return titleCaseSuggestion(base || params.context, "A Clearer Paragraph");
  }
  if (params.target === "title") {
    const title = titleFromTopic(base);
    return title.length > 4 ? title : "A Clearer Book Title";
  }
  if (params.target === "coverBrief") {
    return `Commercial cover brief for ${readerFacingTopic(params.context).toLowerCase()}: strong thumbnail readability, original imagery, clear title space, and a polished genre signal.`;
  }
  if (params.target === "coverPrompt") {
    return `Create an original, professional book cover that visually promises ${readerFacingTopic(params.context).toLowerCase()}, with clean composition, strong contrast, readable title space, and no trademarked imagery.`;
  }
  return `${base.replace(/[.?!]+$/g, "")}. ${direction}.`;
}

function lockedContextForPlan(params: {
  plan: BookPlan;
  chapter?: BookPlanChapter;
  paragraph?: BookPlanParagraph;
}): string[] {
  const locked = params.plan.chapters.flatMap((chapter) =>
    chapter.paragraphs
      .filter((paragraph) => paragraph.locked && paragraph.text.trim())
      .map(
        (paragraph) =>
          `Locked chapter ${chapter.number}, paragraph ${paragraph.order}: ${trimForSuggestion(
            paragraph.text,
            36,
          )}`,
      ),
  );
  if (locked.length) {
    return locked.slice(0, 8);
  }
  if (params.paragraph?.locked && params.paragraph.text.trim()) {
    return [`Current locked paragraph: ${trimForSuggestion(params.paragraph.text, 36)}`];
  }
  return [];
}

function chapterRoleSummary(chapter: BookPlanChapter): string {
  const role = hydrateChapterRole(chapter.role);
  return `Role: ${humanRoleLabel(role.storyThread)} / ${humanRoleLabel(
    role.plotJob,
  )} / ${humanRoleLabel(role.readerFeeling)}${role.notes.trim() ? ` — ${role.notes.trim()}` : ""}`;
}

function buildAiHelpContext(params: {
  plan: BookPlan;
  chapter?: BookPlanChapter;
  paragraph?: BookPlanParagraph;
  previous?: BookPlanParagraph;
  next?: BookPlanParagraph;
}): { summary: string; locked: string[] } {
  const styleGuide = styleGuideForPlan(params.plan);
  const chapterMap = params.plan.chapters
    .map(
      (chapter) =>
        `Chapter ${chapter.number}: ${chapter.title}. ${chapter.description}. ${chapterRoleSummary(
          chapter,
        )}`,
    )
    .join(" ");
  const locked = lockedContextForPlan(params);
  const summary = [
    `Book: ${params.plan.title}`,
    `Topic: ${params.plan.brief.topicParagraph}`,
    `Promise: ${params.plan.brief.readerPromise}`,
    `Audience: ${params.plan.brief.audience}`,
    `Target length: ${params.plan.targetWords} words`,
    `Tone: ${styleGuide.toneDescription}`,
    `Profanity rule: ${styleGuide.profanityDescription}`,
    `All chapters: ${chapterMap}`,
    params.chapter
      ? `Current chapter: ${params.chapter.title} - ${params.chapter.description}. ${chapterRoleSummary(
          params.chapter,
        )}`
      : "",
    params.previous
      ? `Before: ${
          params.previous.text.trim()
            ? trimForSuggestion(params.previous.text, 36)
            : params.previous.summary || params.previous.purpose
        }`
      : "",
    params.paragraph ? `Current: ${params.paragraph.summary || params.paragraph.purpose}` : "",
    params.next ? `After: ${params.next.summary || params.next.purpose}` : "",
    locked.length
      ? `Locked text is immovable story truth: ${locked.join(" ")}`
      : "No locked text yet.",
  ]
    .filter(Boolean)
    .join(" ");
  return { summary, locked };
}

export function suggestBookPlanField(params: {
  plan: BookPlan;
  target: BookWriterAiHelpTarget;
  intent: BookWriterAiHelpIntent;
  chapterId?: string;
  paragraphId?: string;
  customDirection?: string;
}): BookWriterAiHelpSuggestion {
  const chapter = params.chapterId
    ? params.plan.chapters.find((item) => item.id === params.chapterId)
    : undefined;
  const paragraph = chapter?.paragraphs.find((item) => item.id === params.paragraphId);
  const paragraphIndex =
    chapter?.paragraphs.findIndex((item) => item.id === params.paragraphId) ?? -1;
  const previous = paragraphIndex > 0 ? chapter?.paragraphs[paragraphIndex - 1] : undefined;
  const next =
    chapter && paragraphIndex >= 0 && paragraphIndex + 1 < chapter.paragraphs.length
      ? chapter.paragraphs[paragraphIndex + 1]
      : undefined;
  const context = buildAiHelpContext({
    plan: params.plan,
    chapter,
    paragraph,
    previous,
    next,
  });
  const original =
    params.target === "bookStyle"
      ? (params.plan.styleGuide?.toneDescription ?? params.plan.brief.tone)
      : params.target === "title"
        ? params.plan.title
        : params.target === "topic"
          ? params.plan.brief.topicParagraph
          : params.target === "audience"
            ? params.plan.brief.audience
            : params.target === "readerPromise"
              ? params.plan.brief.readerPromise
              : params.target === "chapterDescription"
                ? (chapter?.description ?? "")
                : params.target === "chapterTitle"
                  ? (chapter?.title ?? "")
                  : params.target === "chapterStyle"
                    ? (chapter?.styleDirection ?? "")
                    : params.target === "paragraphTitle"
                      ? (paragraph?.title ?? "")
                      : params.target === "paragraphSummary"
                        ? (paragraph?.summary ?? "")
                        : params.target === "paragraphPlan"
                          ? (paragraph?.purpose ?? "")
                          : params.target === "paragraphStyle"
                            ? (paragraph?.styleDirection ?? "")
                            : params.target === "coverBrief"
                              ? params.plan.cover.brief
                              : params.target === "coverPrompt"
                                ? params.plan.cover.prompt
                                : (paragraph?.text ?? "");
  const suggestion =
    params.target === "paragraphText" && chapter && paragraph
      ? paragraphDraft({
          plan: params.plan,
          chapter,
          paragraph: {
            ...paragraph,
            styleDirection: [
              paragraph.styleDirection,
              params.intent === "dramatic" || params.intent === "humorous"
                ? aiHelpDirection(params)
                : params.customDirection,
            ]
              .filter(Boolean)
              .join(" "),
          },
          previous,
          next,
        })
      : improveFieldText({
          target: params.target,
          intent: params.intent,
          original,
          context: context.summary,
          customDirection: params.customDirection,
        });
  return {
    runId: params.plan.runId,
    target: params.target,
    intent: params.intent,
    ...(params.chapterId ? { chapterId: params.chapterId } : {}),
    ...(params.paragraphId ? { paragraphId: params.paragraphId } : {}),
    original,
    suggestion:
      params.target === "paragraphText" ? repairInstructionalBookText(suggestion) : suggestion,
    explanation:
      "Generated from the full current book plan, chapter roles, locked text, and before/after context so the edit fits the whole book.",
    contextSummary: context.summary,
    engine: "local-context-fallback",
    lockedContext: context.locked,
  };
}

function fieldSuggestionPrompt(params: {
  suggestion: BookWriterAiHelpSuggestion;
  target: BookWriterAiHelpTarget;
  intent: BookWriterAiHelpIntent;
  customDirection?: string;
}): string {
  return [
    "You are filling one editable field in OpenClaw Book Studio.",
    "Use the full context below. Locked text is immovable story truth.",
    "Return only the field value. No markdown. No explanation.",
    `Field target: ${params.target}`,
    `Intent: ${params.intent}`,
    params.customDirection ? `Custom direction: ${params.customDirection}` : "",
    `Existing value: ${params.suggestion.original || "(blank)"}`,
    `Context: ${params.suggestion.contextSummary}`,
    `Fallback suggestion style to improve from: ${params.suggestion.suggestion}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function setupTopicContext(params: {
  topic: string;
  targetWords?: number;
  tonePreset?: BookPlanTonePreset;
  tone?: string;
  profanityLevel?: BookPlanProfanityLevel;
  penName?: string;
}): string {
  const styleGuide = buildStyleGuide({
    tone: params.tone,
    tonePreset: params.tonePreset,
    profanityLevel: params.profanityLevel,
  });
  return [
    `Current book description: ${params.topic || "(blank)"}`,
    `Target length: ${normalizeTargetWords(params.targetWords)} words`,
    `Tone: ${styleGuide.toneDescription}`,
    `Profanity rule: ${styleGuide.profanityDescription}`,
    params.penName?.trim() ? `Possible pen name: ${params.penName.trim()}` : "",
    "This is the first field in Book Studio. The user will later edit chapters, paragraph plans, and final Book Text, so make this description specific enough for the rest of the book to follow.",
  ]
    .filter(Boolean)
    .join(" ");
}

function setupTopicPrompt(params: {
  fallback: BookWriterAiHelpSuggestion;
  customDirection?: string;
}): string {
  return [
    "You are helping fill the first editable book-description field in OpenClaw Book Studio.",
    "Return only the improved book description paragraph. No markdown, no title, no labels, no explanation.",
    "Make it concrete enough that chapters, paragraph plans, and final reader-facing prose can be generated later.",
    "Do not create the book. Do not write chapter plans. Do not write manuscript text. Only write this setup field.",
    `Intent: ${params.fallback.intent}`,
    params.customDirection ? `Custom direction: ${params.customDirection}` : "",
    `Existing description: ${params.fallback.original || "(blank)"}`,
    `Context: ${params.fallback.contextSummary}`,
    `Fallback suggestion to improve from: ${params.fallback.suggestion}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function suggestBookSetupTopicWithContext(params: {
  config: ResolvedBookWriterConfig;
  topic: string;
  targetWords?: number;
  tonePreset?: BookPlanTonePreset;
  tone?: string;
  profanityLevel?: BookPlanProfanityLevel;
  penName?: string;
  intent: BookWriterAiHelpIntent;
  customDirection?: string;
  fetchImpl?: typeof fetch;
}): Promise<BookWriterAiHelpSuggestion> {
  const contextSummary = setupTopicContext(params);
  const original = params.topic.trim();
  const fallbackText = improveFieldText({
    target: "topic",
    intent: params.intent,
    original,
    context: contextSummary,
    customDirection: params.customDirection,
  });
  const fallback: BookWriterAiHelpSuggestion = {
    runId: "new-book-draft",
    target: "topic",
    intent: params.intent,
    original,
    suggestion: fallbackText,
    explanation:
      "Generated from the current setup controls without creating a book. It stays editable and will guide later chapters, paragraph plans, and Book Text.",
    contextSummary,
    engine: "local-context-fallback",
    lockedContext: [],
  };
  const generation = await generateText({
    config: params.config,
    prompt: setupTopicPrompt({ fallback, customDirection: params.customDirection }),
    liveModel: true,
    maxTokens: 320,
    timeoutMs: 12_000,
    fetchImpl: params.fetchImpl,
  });
  const text = generation.text.trim();
  if (generation.live && text) {
    return {
      ...fallback,
      suggestion: text,
      explanation:
        "Generated by the configured local model from the current setup controls without creating a book.",
      engine: "live-model",
    };
  }
  return {
    ...fallback,
    explanation: `${fallback.explanation} Live local model fill was unavailable or unusable, so this is a clearly labeled local context fallback.`,
  };
}

const IDEA_SETUP_TARGETS = new Set<BookWriterIdeaSetupTarget>([
  "title",
  "summary",
  "readerPromise",
  "targetWords",
  "tone",
  "audience",
]);

const CHAPTER_SETUP_TARGETS = new Set<BookWriterChapterSetupTarget>([
  "title",
  "description",
  "style",
  "role",
]);

function normalizeIdeaSetupTargets(targets: string[] | undefined): BookWriterIdeaSetupTarget[] {
  const selected = (targets ?? Array.from(IDEA_SETUP_TARGETS)).filter(
    (target): target is BookWriterIdeaSetupTarget =>
      IDEA_SETUP_TARGETS.has(target as BookWriterIdeaSetupTarget),
  );
  return selected.length ? [...new Set(selected)] : Array.from(IDEA_SETUP_TARGETS);
}

function normalizeChapterSetupTargets(
  targets: string[] | undefined,
): BookWriterChapterSetupTarget[] {
  const selected = (targets ?? Array.from(CHAPTER_SETUP_TARGETS)).filter(
    (target): target is BookWriterChapterSetupTarget =>
      CHAPTER_SETUP_TARGETS.has(target as BookWriterChapterSetupTarget),
  );
  return selected.length ? [...new Set(selected)] : Array.from(CHAPTER_SETUP_TARGETS);
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("model did not return valid JSON.");
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : undefined;
}

function ideaSetupFallback(plan: BookPlan) {
  const styleGuide = styleGuideForPlan(plan);
  return {
    title: titleFromTopic(plan.brief.topicParagraph || plan.topic),
    summary: readerFacingTopic(plan.brief.topicParagraph || plan.topic),
    readerPromise:
      plan.brief.readerPromise ||
      "A clear, original book that gives the reader a useful and satisfying result.",
    targetWords: normalizeTargetWords(plan.targetWords),
    tone: styleGuide.toneDescription,
    audience: plan.brief.audience || "Commercial readers who want a clear, original book.",
  };
}

function ideaSetupPrompt(plan: BookPlan, targets: BookWriterIdeaSetupTarget[]): string {
  const styleGuide = styleGuideForPlan(plan);
  return [
    "You are the OpenClaw Book Writer idea-strategist specialized agent.",
    "Return only compact JSON with keys: title, summary, readerPromise, targetWords, tone, audience.",
    "Do not include markdown or explanation.",
    "Profanity must remain off. Do not generate or recommend profanity.",
    `Only optimize these requested fields: ${targets.join(", ")}.`,
    `Current title: ${plan.title}`,
    `Current idea summary: ${plan.brief.topicParagraph}`,
    `Current reader promise: ${plan.brief.readerPromise}`,
    `Current audience: ${plan.brief.audience}`,
    `Current target words: ${plan.targetWords}`,
    `Current tone: ${styleGuide.toneDescription}`,
    `Genre/pen name: ${plan.genre} / ${plan.penName}`,
  ].join("\n");
}

function withProfanityOff(plan: BookPlan, toneDescription?: string): BookPlan {
  const current = styleGuideForPlan(plan);
  const styleGuide = buildStyleGuide({
    tone: toneDescription ?? current.toneDescription,
    tonePreset: toneDescription ? "custom" : current.tonePreset,
    profanityLevel: "none",
  });
  return {
    ...plan,
    brief: {
      ...plan.brief,
      tone: styleGuide.toneDescription,
      constraints: [
        ...plan.brief.constraints.filter((constraint) => !/profanity/i.test(constraint)),
        styleGuide.profanityDescription,
      ],
    },
    styleGuide,
  };
}

function applyIdeaSetup(
  plan: BookPlan,
  targets: BookWriterIdeaSetupTarget[],
  generated: ReturnType<typeof ideaSetupFallback>,
): BookPlan {
  let next = withProfanityOff(plan, targets.includes("tone") ? generated.tone : undefined);
  if (targets.includes("title")) {
    const title = generated.title.trim() || next.title;
    next = { ...next, title, slug: slugify(title) };
  }
  if (targets.includes("summary")) {
    next = {
      ...next,
      topic: generated.summary,
      brief: { ...next.brief, topicParagraph: generated.summary },
    };
  }
  if (targets.includes("readerPromise")) {
    next = { ...next, brief: { ...next.brief, readerPromise: generated.readerPromise } };
  }
  if (targets.includes("targetWords")) {
    next = { ...next, targetWords: normalizeTargetWords(generated.targetWords, next.targetWords) };
  }
  if (targets.includes("audience")) {
    next = { ...next, brief: { ...next.brief, audience: generated.audience } };
  }
  return next;
}

function coerceIdeaSetupJson(plan: BookPlan, value: unknown) {
  const fallback = ideaSetupFallback(plan);
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const object = value as Record<string, unknown>;
  const targetWords =
    typeof object.targetWords === "number"
      ? object.targetWords
      : typeof object.targetWords === "string"
        ? Number(object.targetWords)
        : fallback.targetWords;
  return {
    title: stringField(object.title) ?? fallback.title,
    summary: stringField(object.summary) ?? fallback.summary,
    readerPromise: stringField(object.readerPromise) ?? fallback.readerPromise,
    targetWords: normalizeTargetWords(targetWords, fallback.targetWords),
    tone: stringField(object.tone) ?? fallback.tone,
    audience: stringField(object.audience) ?? fallback.audience,
  };
}

export async function generateAndSaveIdeaSetup(
  options: PlanMutationOptions & {
    targets?: string[];
  },
): Promise<BookPlan> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  const targets = normalizeIdeaSetupTargets(options.targets);
  const generation = await generateText({
    config: options.config,
    prompt: ideaSetupPrompt(existing, targets),
    liveModel: true,
    maxTokens: 700,
    timeoutMs: 30_000,
    fetchImpl: options.fetchImpl,
  });
  const generated =
    generation.live && generation.text.trim()
      ? coerceIdeaSetupJson(existing, extractJsonObject(generation.text))
      : ideaSetupFallback(existing);
  const plan = applyIdeaSetup(existing, targets, generated);
  return saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan,
    action: "idea-strategist",
    summary: `OpenClaw Book Writer idea-strategist filled ${targets.join(", ")}. Profanity stayed Off.`,
  });
}

const STORY_THREAD_VALUES = new Set<BookPlanChapterRole["storyThread"]>([
  "main-story",
  "side-story",
  "converging-stories",
  "flashback",
  "interlude",
  "abrupt-shift",
  "resolution",
  "custom",
]);
const PLOT_JOB_VALUES = new Set<BookPlanChapterRole["plotJob"]>([
  "setup",
  "conflict",
  "clue",
  "red-herring",
  "twist",
  "reveal",
  "payoff",
  "mystery-deepens",
  "custom",
]);
const READER_FEELING_VALUES = new Set<BookPlanChapterRole["readerFeeling"]>([
  "calm",
  "funny",
  "suspenseful",
  "dramatic",
  "warm",
  "dark",
  "hopeful",
  "fast-paced",
  "custom",
]);

function lockedChapterContext(plan: BookPlan): string {
  const locked = plan.chapters
    .filter((chapter) => chapter.locked)
    .map(
      (chapter) =>
        `Chapter ${chapter.number} locked: ${chapter.title}. ${chapter.description}. ${chapterRoleSummary(
          chapter,
        )} Style: ${chapter.styleDirection || "none"}.`,
    );
  return locked.length ? locked.join("\n") : "No locked chapters.";
}

function chapterSetupPrompt(plan: BookPlan, targets: BookWriterChapterSetupTarget[]): string {
  const styleGuide = styleGuideForPlan(plan);
  return [
    "You are the OpenClaw Book Writer chapter-architect specialized agent.",
    "Return only compact JSON with a chapters array. Each item must include id, title, description, styleDirection, role.",
    "Role keys: storyThread, plotJob, readerFeeling, notes.",
    "Do not include markdown or explanation.",
    "Locked chapters are immovable truth. Do not change locked chapters; use them for before/after continuity.",
    "Chapter titles are reader-facing hooks, not labels. Avoid descriptive report titles like 'The Problem' or 'Understanding X'.",
    "Do not label the chapter by its structural function: no 'The Promise', 'The Stakes', 'The Pattern', 'The Turn', 'The Test', or 'The Resolution'.",
    "Do not repeat the book title unless the chapter is a one-chapter short story and the title is already highly specific.",
    "For each chapter title, internally consider three candidates and return only the strongest one.",
    "Use a concrete noun, conflict, image, question, contradiction, or turn in every title.",
    "Make every title distinct from every other chapter title.",
    "Crank up title creativity: use mystery, tension, concrete images, unanswered questions, and emotional stakes.",
    "Base each title on what the chapter covers, including existing paragraph plans and Book Text when present.",
    "Keep titles short, memorable, genre-appropriate, and clean when profanity is Off.",
    "Chapter styleDirection should tell AI how this chapter should feel and move, not repeat the summary.",
    `Requested fields: ${targets.join(", ")}.`,
    `Book title: ${plan.title}`,
    `Idea: ${plan.brief.topicParagraph}`,
    `Promise: ${plan.brief.readerPromise}`,
    `Audience: ${plan.brief.audience}`,
    `Target words: ${plan.targetWords}`,
    `Tone: ${styleGuide.toneDescription}`,
    `Profanity rule: ${styleGuide.profanityDescription}`,
    `Locked chapter context:\n${lockedChapterContext(plan)}`,
    `Current chapters:\n${plan.chapters
      .map(
        (chapter) =>
          `${chapter.locked ? "LOCKED " : ""}${chapter.id}: Chapter ${chapter.number}: ${
            chapter.title
          }. ${chapter.description}. Style: ${chapter.styleDirection || "none"}. ${chapterRoleSummary(
            chapter,
          )}. Paragraphs: ${chapter.paragraphs
            .map((paragraph) =>
              [
                `P${paragraph.order}`,
                paragraph.title,
                paragraph.summary || paragraph.purpose,
                paragraph.text ? `Text: ${paragraph.text.slice(0, 220)}` : "",
              ]
                .filter(Boolean)
                .join(" - "),
            )
            .join(" | ")}`,
      )
      .join("\n")}`,
  ].join("\n");
}

function fallbackChapterSetup(plan: BookPlan, chapter: BookPlanChapter): BookPlanChapter {
  const arc = CHAPTER_ARCS[(chapter.number - 1) % CHAPTER_ARCS.length];
  const title =
    chapter.title.trim() && !isGenericChapterTitle(chapter.title, plan.title)
      ? chapter.title.trim()
      : bestChapterTitle({
          baseTitle: plan.title,
          index: chapter.number - 1,
          topic: plan.topic,
          genre: plan.genre,
          readerPromise: plan.brief.readerPromise,
          chapterDescription: chapter.description || arc.description,
          role: hydrateChapterRole(chapter.role),
          existingTitles: plan.chapters
            .filter((candidate) => candidate.id !== chapter.id)
            .map((candidate) => candidate.title),
        });
  const description =
    chapter.description.trim() ||
    `${arc.description} Keep continuity with the surrounding chapters and deliver part of "${plan.brief.readerPromise}".`;
  const styleDirection =
    chapter.styleDirection.trim() ||
    `${arc.title} energy: use a vivid hook, concrete tension, and one unanswered question that makes the next chapter feel necessary.`;
  return {
    ...chapter,
    title,
    description,
    styleDirection,
    role: hydrateChapterRole(chapter.role),
  };
}

function coerceChapterRole(value: unknown, fallback: BookPlanChapterRole): BookPlanChapterRole {
  const object = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const storyThread = object.storyThread;
  const plotJob = object.plotJob;
  const readerFeeling = object.readerFeeling;
  return {
    storyThread:
      typeof storyThread === "string" &&
      STORY_THREAD_VALUES.has(storyThread as BookPlanChapterRole["storyThread"])
        ? (storyThread as BookPlanChapterRole["storyThread"])
        : fallback.storyThread,
    plotJob:
      typeof plotJob === "string" && PLOT_JOB_VALUES.has(plotJob as BookPlanChapterRole["plotJob"])
        ? (plotJob as BookPlanChapterRole["plotJob"])
        : fallback.plotJob,
    readerFeeling:
      typeof readerFeeling === "string" &&
      READER_FEELING_VALUES.has(readerFeeling as BookPlanChapterRole["readerFeeling"])
        ? (readerFeeling as BookPlanChapterRole["readerFeeling"])
        : fallback.readerFeeling,
    notes: stringField(object.notes) ?? fallback.notes,
  };
}

function chapterSetupMap(plan: BookPlan, value: unknown): Map<string, BookPlanChapter> {
  const map = new Map<string, BookPlanChapter>();
  const usedTitles = new Set<string>();
  const object = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const chapters = Array.isArray(object.chapters) ? object.chapters : [];
  for (const item of chapters) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = stringField(record.id);
    const source = id ? plan.chapters.find((chapter) => chapter.id === id) : undefined;
    if (!source) {
      continue;
    }
    const fallback = fallbackChapterSetup(plan, source);
    const generatedTitle = stringField(record.title);
    const safeTitle =
      generatedTitle &&
      !isGenericChapterTitle(generatedTitle, plan.title) &&
      !usedTitles.has(generatedTitle.toLowerCase())
        ? generatedTitle
        : fallback.title;
    usedTitles.add(safeTitle.toLowerCase());
    map.set(source.id, {
      ...source,
      title: safeTitle,
      description: stringField(record.description) ?? fallback.description,
      styleDirection: stringField(record.styleDirection) ?? fallback.styleDirection,
      role: coerceChapterRole(record.role, hydrateChapterRole(source.role)),
    });
  }
  return map;
}

function applyChapterSetup(
  plan: BookPlan,
  targets: BookWriterChapterSetupTarget[],
  generated: Map<string, BookPlanChapter>,
): BookPlan {
  return {
    ...plan,
    status: "chapter-plan",
    chapters: plan.chapters.map((chapter) => {
      if (chapter.locked) {
        return chapter;
      }
      const fallback = fallbackChapterSetup(plan, chapter);
      const suggestion = generated.get(chapter.id) ?? fallback;
      const role = hydrateChapterRole(chapter.role);
      return {
        ...chapter,
        title:
          targets.includes("title") && !chapter.fieldLocks?.title
            ? suggestion.title
            : chapter.title,
        description:
          targets.includes("description") && !chapter.fieldLocks?.description
            ? suggestion.description
            : chapter.description,
        styleDirection:
          targets.includes("style") && !chapter.fieldLocks?.styleDirection
            ? suggestion.styleDirection
            : chapter.styleDirection,
        role: targets.includes("role")
          ? {
              storyThread: suggestion.role?.storyThread ?? role.storyThread,
              plotJob: suggestion.role?.plotJob ?? role.plotJob,
              readerFeeling: suggestion.role?.readerFeeling ?? role.readerFeeling,
              notes: chapter.fieldLocks?.roleNotes
                ? role.notes
                : (suggestion.role?.notes ?? role.notes),
            }
          : role,
      };
    }),
  };
}

export async function generateAndSaveChapterSetup(
  options: PlanMutationOptions & {
    targets?: string[];
  },
): Promise<BookPlan> {
  const existing = await readBookPlan(options.config, options.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${options.runId}`);
  }
  assertPlanVersion(existing, options.baseVersion);
  const targets = normalizeChapterSetupTargets(options.targets);
  const generation = await generateText({
    config: options.config,
    prompt: chapterSetupPrompt(existing, targets),
    liveModel: true,
    maxTokens: 1800,
    timeoutMs: 45_000,
    fetchImpl: options.fetchImpl,
  });
  const generated =
    generation.live && generation.text.trim()
      ? chapterSetupMap(existing, extractJsonObject(generation.text))
      : new Map<string, BookPlanChapter>();
  const plan = applyChapterSetup(existing, targets, generated);
  return saveBookPlan({
    config: options.config,
    baseVersion: existing.version,
    plan,
    action: "chapter-architect",
    summary: `OpenClaw Book Writer chapter-architect filled ${targets.join(", ")} while preserving locked chapters.`,
  });
}

export async function suggestBookPlanFieldWithContext(params: {
  config: ResolvedBookWriterConfig;
  plan: BookPlan;
  target: BookWriterAiHelpTarget;
  intent: BookWriterAiHelpIntent;
  chapterId?: string;
  paragraphId?: string;
  customDirection?: string;
  fetchImpl?: typeof fetch;
}): Promise<BookWriterAiHelpSuggestion> {
  const fallback = suggestBookPlanField(params);
  if (params.target === "paragraphText") {
    const chapter = params.chapterId
      ? params.plan.chapters.find((item) => item.id === params.chapterId)
      : undefined;
    const paragraph = chapter?.paragraphs.find((item) => item.id === params.paragraphId);
    const paragraphIndex =
      chapter?.paragraphs.findIndex((item) => item.id === params.paragraphId) ?? -1;
    if (!chapter || !paragraph) {
      throw new Error("paragraph not found.");
    }
    const suggestion = await generateReaderFacingBookText({
      config: params.config,
      plan: params.plan,
      chapter,
      paragraph: {
        ...paragraph,
        styleDirection: [
          paragraph.styleDirection,
          params.intent === "dramatic" || params.intent === "humorous"
            ? aiHelpDirection(params)
            : params.customDirection,
        ]
          .filter(Boolean)
          .join(" "),
      },
      previous: paragraphIndex > 0 ? chapter.paragraphs[paragraphIndex - 1] : undefined,
      next:
        paragraphIndex >= 0 && paragraphIndex + 1 < chapter.paragraphs.length
          ? chapter.paragraphs[paragraphIndex + 1]
          : undefined,
      fetchImpl: params.fetchImpl,
    });
    return {
      ...fallback,
      suggestion,
      explanation:
        "Generated by the configured local model as final reader-facing prose using the full plan, chapter roles, locked text, and before/after context.",
      engine: "live-model",
    };
  }
  const generation = await generateText({
    config: params.config,
    prompt: fieldSuggestionPrompt({
      suggestion: fallback,
      target: params.target,
      intent: params.intent,
      customDirection: params.customDirection,
    }),
    liveModel: true,
    maxTokens: 260,
    timeoutMs: 12_000,
    fetchImpl: params.fetchImpl,
  });
  const text = generation.text.trim();
  if (generation.live && text) {
    return {
      ...fallback,
      suggestion: text,
      explanation:
        "Generated by the configured local model using the full plan, chapter roles, locked text, and before/after context.",
      engine: "live-model",
    };
  }
  return {
    ...fallback,
    explanation: `${fallback.explanation} Live local model fill was unavailable or unusable, so this is a clearly labeled local context fallback.`,
  };
}

export function buildBookPlanQualityReport(plan: BookPlan): BookPlanQualityReport {
  const paragraphs = plan.chapters.flatMap((chapter) => chapter.paragraphs);
  const draftedParagraphs = paragraphs.filter((paragraph) => paragraph.text.trim()).length;
  const lockedParagraphs = paragraphs.filter((paragraph) => paragraph.locked).length;
  const draftedText = paragraphs.map((paragraph) => paragraph.text).join(" ");
  const draftedWords = countWords(draftedText);
  const styleGuide = styleGuideForPlan(plan);
  const findings: GateFinding[] = [];
  findings.push({
    code: "chapters",
    status: plan.chapters.length > 0 ? "pass" : "fail",
    message:
      plan.chapters.length > 0
        ? `${plan.chapters.length} chapter(s) planned.`
        : "At least one chapter is required.",
  });
  findings.push({
    code: "paragraph-plans",
    status: paragraphs.length > 0 ? "pass" : "fail",
    message:
      paragraphs.length > 0
        ? `${paragraphs.length} paragraph plan(s) ready.`
        : "At least one paragraph plan is required.",
  });
  const titleCounts = new Map<string, number>();
  for (const chapter of plan.chapters) {
    const key = chapter.title.trim().toLowerCase();
    if (key) {
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
  }
  const emptyChapterTitles = plan.chapters.filter((chapter) => !chapter.title.trim()).length;
  const duplicateChapterTitles = [...titleCounts.values()].filter((count) => count > 1).length;
  const genericUnlockedTitles = plan.chapters.filter(
    (chapter) => !chapter.locked && isGenericChapterTitle(chapter.title, plan.title),
  ).length;
  const genericTitleRatio = plan.chapters.length ? genericUnlockedTitles / plan.chapters.length : 0;
  findings.push({
    code: "chapter-title-quality",
    status:
      emptyChapterTitles > 0 || duplicateChapterTitles > 0
        ? "fail"
        : genericTitleRatio > 0.25
          ? "warn"
          : "pass",
    score: genericUnlockedTitles,
    message:
      emptyChapterTitles > 0
        ? `${emptyChapterTitles} chapter title(s) are empty.`
        : duplicateChapterTitles > 0
          ? `${duplicateChapterTitles} duplicate chapter title group(s) found.`
          : genericUnlockedTitles > 0
            ? `${genericUnlockedTitles} unlocked chapter title(s) still look generic.`
            : "Chapter titles are distinct, specific, and reader-facing.",
  });
  findings.push({
    code: "draft-coverage",
    status:
      draftedParagraphs === paragraphs.length && paragraphs.length > 0
        ? "pass"
        : draftedParagraphs > 0
          ? "warn"
          : "fail",
    message: `${draftedParagraphs}/${paragraphs.length} paragraph(s) have generated or edited text.`,
  });
  const instructionalDrafts = paragraphs.filter((paragraph) =>
    looksLikeInstructionalBookText(paragraph.text),
  ).length;
  findings.push({
    code: "reader-facing-text",
    status: instructionalDrafts === 0 ? "pass" : "fail",
    message:
      instructionalDrafts === 0
        ? "Book Text is reader-facing, not internal AI instructions."
        : `${instructionalDrafts} paragraph(s) still look like AI instructions instead of publishable Book Text.`,
  });
  const profanityTerms = countProfanityTerms(draftedText);
  findings.push({
    code: "profanity-control",
    status: styleGuide.profanityLevel === "none" && profanityTerms > 0 ? "fail" : "pass",
    score: profanityTerms,
    message:
      styleGuide.profanityLevel === "none"
        ? profanityTerms > 0
          ? `Profanity is Off and ${profanityTerms} possible profanity term(s) were found.`
          : "Profanity is Off; no profanity terms were found."
        : `Profanity is set to ${styleGuide.profanityLevel}; language scan completed.`,
  });
  findings.push({
    code: "locked-control",
    status: "pass",
    message: `${lockedParagraphs} paragraph(s) locked for preservation.`,
  });
  const hasFail = findings.some((finding) => finding.status === "fail");
  const hasWarn = findings.some((finding) => finding.status === "warn");
  return {
    status: hasFail ? "fail" : hasWarn ? "warn" : "pass",
    findings,
    counts: {
      chapters: plan.chapters.length,
      paragraphs: paragraphs.length,
      draftedParagraphs,
      lockedParagraphs,
      draftedWords,
    },
  };
}

export async function listBookPlanProjects(
  config: ResolvedBookWriterConfig,
): Promise<BookPlanProjectSummary[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(config.outputDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const projects: BookPlanProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) {
      continue;
    }
    const rawPlan = await readJsonFile<BookPlan>(
      path.join(config.outputDir, entry.name, BOOK_PLAN_FILE),
    );
    if (!rawPlan) {
      continue;
    }
    const plan = hydrateBookPlan(rawPlan);
    const quality = buildBookPlanQualityReport(plan);
    projects.push({
      runId: plan.runId,
      title: plan.title,
      subtitle: plan.subtitle,
      penName: plan.penName,
      genre: plan.genre,
      status: plan.status,
      kind: plan.kind,
      version: plan.version,
      updatedAt: plan.updatedAt,
      targetWords: plan.targetWords,
      draftedWords: quality.counts.draftedWords,
      chapterCount: quality.counts.chapters,
      paragraphCount: quality.counts.paragraphs,
      lockedParagraphCount: quality.counts.lockedParagraphs,
      artifactLinks: plan.artifactLinks,
    });
  }
  return projects.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listDeletedBookPlanProjects(
  config: ResolvedBookWriterConfig,
): Promise<DeletedBookPlanSummary[]> {
  const deletedRoot = path.join(config.outputDir, DELETED_BOOKS_DIR);
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(deletedRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const deletedBooks: DeletedBookPlanSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const deletedId = entry.name;
    const deletedDir = path.join(deletedRoot, deletedId);
    const rawPlan = await readJsonFile<BookPlan>(path.join(deletedDir, BOOK_PLAN_FILE));
    if (!rawPlan) {
      continue;
    }
    const plan = hydrateBookPlan(rawPlan);
    const tombstone = await readDeletedBookTombstone(deletedDir);
    const quality = buildBookPlanQualityReport(plan);
    deletedBooks.push({
      deletedId,
      runId: plan.runId,
      title: plan.title,
      subtitle: plan.subtitle,
      penName: plan.penName,
      genre: plan.genre,
      status: plan.status,
      kind: plan.kind,
      version: plan.version,
      deletedAt: tombstone?.deletedAt ?? plan.updatedAt,
      ...(tombstone?.originalDir ? { originalDir: tombstone.originalDir } : {}),
      targetWords: plan.targetWords,
      draftedWords: quality.counts.draftedWords,
      chapterCount: quality.counts.chapters,
      paragraphCount: quality.counts.paragraphs,
    });
  }
  return deletedBooks.toSorted((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export async function listArchivedBookPlanProjects(
  config: ResolvedBookWriterConfig,
): Promise<ArchivedBookPlanSummary[]> {
  const archivedRoot = path.join(config.outputDir, ARCHIVED_BOOKS_DIR);
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(archivedRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const archivedBooks: ArchivedBookPlanSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const archivedId = entry.name;
    const archivedDir = path.join(archivedRoot, archivedId);
    const rawPlan = await readJsonFile<BookPlan>(path.join(archivedDir, BOOK_PLAN_FILE));
    if (!rawPlan) {
      continue;
    }
    const plan = hydrateBookPlan(rawPlan);
    const tombstone = await readArchivedBookTombstone(archivedDir);
    const quality = buildBookPlanQualityReport(plan);
    archivedBooks.push({
      archivedId,
      runId: plan.runId,
      title: plan.title,
      subtitle: plan.subtitle,
      penName: plan.penName,
      genre: plan.genre,
      status: plan.status,
      kind: plan.kind,
      version: plan.version,
      archivedAt: tombstone?.archivedAt ?? plan.updatedAt,
      ...(tombstone?.originalDir ? { originalDir: tombstone.originalDir } : {}),
      targetWords: plan.targetWords,
      draftedWords: quality.counts.draftedWords,
      chapterCount: quality.counts.chapters,
      paragraphCount: quality.counts.paragraphs,
    });
  }
  return archivedBooks.toSorted((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

export async function listFinishedBookPlanProjects(
  config: ResolvedBookWriterConfig,
): Promise<FinishedBookPlanSummary[]> {
  const finishedRoot = path.join(config.outputDir, FINISHED_BOOKS_DIR);
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(finishedRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const finishedBooks: FinishedBookPlanSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const finishedId = entry.name;
    const finishedDir = path.join(finishedRoot, finishedId);
    const rawPlan = await readJsonFile<BookPlan>(path.join(finishedDir, BOOK_PLAN_FILE));
    if (!rawPlan) {
      continue;
    }
    const plan = hydrateBookPlan(rawPlan);
    const tombstone = await readFinishedBookTombstone(finishedDir);
    const reviewPack =
      (await readJsonFile<ReviewPack>(path.join(finishedDir, "review-pack.json"))) ?? null;
    const dryRun =
      (await readJsonFile<KdpDryRunReport>(path.join(finishedDir, "kdp-dry-run-report.json"))) ??
      null;
    const cover =
      tombstone?.coverPath || tombstone?.coverSource
        ? {
            coverPath: tombstone.coverPath,
            coverSource: tombstone.coverSource,
          }
        : resolveFinishedCover({ plan, reviewPack, dryRun });
    const quality = buildBookPlanQualityReport(plan);
    const coverPreviewDataUrl = await readCoverPreviewDataUrl(finishedDir);
    const publishedAt = tombstone?.publishedAt ?? tombstone?.finishedAt ?? plan.updatedAt;
    const publishProof =
      tombstone?.publishProof ??
      normalizePublishedProof({
        proof: { destination: "amazon-kdp", publishedAt },
        publishedAt,
      });
    const metrics = normalizePublishedMetrics(
      tombstone?.metrics,
      tombstone?.metrics?.updatedAt ?? publishedAt,
    );
    finishedBooks.push({
      finishedId,
      runId: plan.runId,
      title: plan.title,
      subtitle: plan.subtitle,
      penName: plan.penName,
      genre: plan.genre,
      status: plan.status,
      kind: plan.kind,
      version: plan.version,
      finishedAt: tombstone?.finishedAt ?? plan.updatedAt,
      publishedAt,
      ...(tombstone?.originalDir ? { originalDir: tombstone.originalDir } : {}),
      ...(cover.coverPath ? { coverPath: cover.coverPath } : {}),
      ...(cover.coverSource ? { coverSource: cover.coverSource } : {}),
      ...(coverPreviewDataUrl ? { coverPreviewDataUrl } : {}),
      publishProof,
      metrics,
      targetWords: plan.targetWords,
      draftedWords: quality.counts.draftedWords,
      chapterCount: quality.counts.chapters,
      paragraphCount: quality.counts.paragraphs,
      artifactLinks: plan.artifactLinks,
    });
  }
  return finishedBooks.toSorted((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}

export async function updatePublishedBookMetrics(options: {
  config: ResolvedBookWriterConfig;
  finishedId: string;
  metrics: Partial<PublishedBookMetrics>;
  now?: Date;
}): Promise<FinishedBookPlanSummary[]> {
  const finishedId = assertFinishedId(options.finishedId);
  const finishedDir = path.join(options.config.outputDir, FINISHED_BOOKS_DIR, finishedId);
  const tombstone = await readFinishedBookTombstone(finishedDir);
  if (!tombstone) {
    throw new Error(`finished book not found: ${finishedId}`);
  }
  const now = (options.now ?? new Date()).toISOString();
  await writeJsonFile(path.join(finishedDir, "finished-book.json"), {
    ...tombstone,
    metrics: normalizePublishedMetrics(
      {
        ...tombstone.metrics,
        ...options.metrics,
        snapshots: options.metrics.snapshots ?? tombstone.metrics?.snapshots ?? [],
      },
      now,
    ),
  });
  return listFinishedBookPlanProjects(options.config);
}

export function recommendNextBookFromPublishedBooks(
  books: FinishedBookPlanSummary[],
): BookWriterNextBookRecommendation | null {
  if (!books.length) {
    return null;
  }
  const scored = books
    .map((book) => ({
      book,
      profit: book.metrics?.totalProfitUsd ?? 0,
      sales: book.metrics?.totalSales ?? 0,
      revenue: book.metrics?.totalRevenueUsd ?? 0,
    }))
    .toSorted((a, b) => b.profit - a.profit || b.sales - a.sales || b.revenue - a.revenue);
  const best = scored[0]?.book;
  if (!best) {
    return null;
  }
  const profitPerWord =
    best.metrics?.totalProfitUsd && best.draftedWords
      ? best.metrics.totalProfitUsd / best.draftedWords
      : 0;
  const confidence =
    (best.metrics?.totalProfitUsd ?? 0) > 0 && (best.metrics?.totalSales ?? 0) >= 10
      ? "high"
      : (best.metrics?.totalSales ?? 0) > 0
        ? "medium"
        : "starter";
  const category = best.publishProof?.category || best.genre;
  const keywords = best.publishProof?.keywords?.slice(0, 4).join(", ") || "clear reader promise";
  return {
    title: `Follow-up to ${best.title}`,
    confidence,
    topicParagraph: `A new original ${best.genre} book for ${category} readers that keeps the proven promise of "${best.title}" but explores a fresh problem, sharper hook, and updated examples. It should target about ${best.targetWords.toLocaleString()} words, use the same reader-friendly strengths, and lean into keywords such as ${keywords} without copying the earlier book.`,
    why:
      confidence === "starter"
        ? "There is not enough sales history yet, so this uses your strongest published-book metadata as a safe starting point."
        : "This recommendation is based on the strongest published-book profit, sales, and category signals in the Trophy Room.",
    evidence: [
      `${best.title}: ${(best.metrics?.totalSales ?? 0).toLocaleString()} sales`,
      `$${(best.metrics?.totalRevenueUsd ?? 0).toLocaleString()} revenue`,
      `$${(best.metrics?.totalProfitUsd ?? 0).toLocaleString()} profit`,
      profitPerWord > 0
        ? `$${profitPerWord.toFixed(4)} profit per word`
        : `${best.draftedWords.toLocaleString()} words`,
    ],
  };
}

async function readPenNameProfileOverrides(
  config: ResolvedBookWriterConfig,
): Promise<Record<string, { lane: string; readerPromise: string; updatedAt?: string }>> {
  return (
    (await readJsonFile<
      Record<string, { lane: string; readerPromise: string; updatedAt?: string }>
    >(path.join(config.outputDir, PEN_NAME_PROFILES_FILE))) ?? {}
  );
}

export async function updatePenNameProfile(
  config: ResolvedBookWriterConfig,
  profile: { name: string; lane: string; readerPromise: string },
): Promise<BookWriterPenNameProfile[]> {
  const name = profile.name.replace(/\s+/g, " ").trim();
  if (!name) {
    throw new Error("pen name is required.");
  }
  await fs.mkdir(config.outputDir, { recursive: true });
  const overrides = await readPenNameProfileOverrides(config);
  overrides[name] = {
    lane: profile.lane.replace(/\s+/g, " ").trim() || "general original books",
    readerPromise:
      profile.readerPromise.replace(/\s+/g, " ").trim() ||
      "clear original books with a consistent reader promise",
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(path.join(config.outputDir, PEN_NAME_PROFILES_FILE), overrides);
  return listPenNameProfiles(config);
}

function addPenBook(
  map: Map<string, BookWriterPenNameProfile>,
  params: {
    penName: string;
    lane: string;
    readerPromise: string;
    bucket: "published" | "completed" | "inProgress";
    id: string;
    title: string;
    genre: string;
    words: number;
  },
) {
  const name = params.penName.replace(/\s+/g, " ").trim() || "Unknown pen name";
  const existing =
    map.get(name) ??
    ({
      name,
      lane: params.lane,
      readerPromise: params.readerPromise,
      publishedCount: 0,
      completedCount: 0,
      inProgressCount: 0,
      books: { published: [], completed: [], inProgress: [] },
    } satisfies BookWriterPenNameProfile);
  existing.books[params.bucket].push({
    id: params.id,
    title: params.title,
    genre: params.genre,
    words: params.words,
  });
  existing.publishedCount = existing.books.published.length;
  existing.completedCount = existing.books.completed.length;
  existing.inProgressCount = existing.books.inProgress.length;
  map.set(name, existing);
}

export async function listPenNameProfiles(
  config: ResolvedBookWriterConfig,
): Promise<BookWriterPenNameProfile[]> {
  const [overrides, projects, finishedBooks] = await Promise.all([
    readPenNameProfileOverrides(config),
    listBookPlanProjects(config),
    listFinishedBookPlanProjects(config),
  ]);
  const map = new Map<string, BookWriterPenNameProfile>();
  for (const configured of config.penNames) {
    const override = overrides[configured.name];
    map.set(configured.name, {
      name: configured.name,
      lane: override?.lane ?? configured.lane,
      readerPromise: override?.readerPromise ?? configured.readerPromise,
      publishedCount: 0,
      completedCount: 0,
      inProgressCount: 0,
      books: { published: [], completed: [], inProgress: [] },
      updatedAt: override?.updatedAt,
    });
  }
  for (const [name, override] of Object.entries(overrides)) {
    if (!map.has(name)) {
      map.set(name, {
        name,
        lane: override.lane,
        readerPromise: override.readerPromise,
        publishedCount: 0,
        completedCount: 0,
        inProgressCount: 0,
        books: { published: [], completed: [], inProgress: [] },
        updatedAt: override.updatedAt,
      });
    }
  }
  for (const book of finishedBooks) {
    const base = map.get(book.penName);
    addPenBook(map, {
      penName: book.penName,
      lane: base?.lane ?? book.genre,
      readerPromise: base?.readerPromise ?? book.genre,
      bucket: "published",
      id: book.finishedId,
      title: book.title,
      genre: book.genre,
      words: book.draftedWords,
    });
  }
  for (const project of projects) {
    const base = map.get(project.penName);
    addPenBook(map, {
      penName: project.penName,
      lane: base?.lane ?? project.genre,
      readerPromise: base?.readerPromise ?? project.genre,
      bucket: project.status === "publish-ready" ? "completed" : "inProgress",
      id: project.runId,
      title: project.title,
      genre: project.genre,
      words: project.draftedWords,
    });
  }
  return [...map.values()].toSorted(
    (a, b) =>
      b.publishedCount - a.publishedCount ||
      b.completedCount - a.completedCount ||
      b.inProgressCount - a.inProgressCount ||
      a.name.localeCompare(b.name),
  );
}

export async function readReviewPack(
  config: ResolvedBookWriterConfig,
  runId: string,
): Promise<ReviewPack | null> {
  const paths = resolveRunPaths(config.outputDir, runId);
  return (await readJsonFile<ReviewPack>(path.join(paths.runDir, "review-pack.json"))) ?? null;
}

export async function readManuscriptPreview(
  config: ResolvedBookWriterConfig,
  plan: BookPlan | null,
): Promise<string> {
  if (!plan) {
    return "";
  }
  const manuscriptPath = plan.artifactLinks.manuscript;
  if (manuscriptPath && (await fileExists(manuscriptPath))) {
    return fs.readFile(manuscriptPath, "utf8");
  }
  try {
    return stitchBookPlan(plan);
  } catch {
    return "";
  }
}
