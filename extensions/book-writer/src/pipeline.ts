import path from "node:path";
import type { ResolvedBookWriterConfig } from "./config.js";
import { buildCoverTiff } from "./cover.js";
import { writeEpub } from "./epub.js";
import { validatePublishingExports } from "./export-validation.js";
import {
  createRunId,
  ensureRunDir,
  fileExists,
  readJsonFile,
  resolveRunPaths,
  writeBinaryFile,
  writeJsonFile,
  writeTextFile,
} from "./files.js";
import { generateText, type GenerateTextResult } from "./model-adapter.js";
import {
  estimateBookEndurance,
  memoryCapForMode,
  readBenchRecords,
  selectBestModel,
} from "./model-governor.js";
import { buildOriginalityReport, detectCopyrightAdjacentPrompt } from "./originality.js";
import { buildCoverSvg, buildPrintHtml, buildPublishPreview } from "./packaging.js";
import { buildEditorialPolicyReport } from "./policy.js";
import {
  buildContinuityReport,
  buildEnduranceReport,
  buildQualityReport,
  buildStoryQualityReport,
  validateEpubStructure,
} from "./quality.js";
import { countWords, slugify } from "./text.js";
import type {
  BookBible,
  BookOutline,
  BookPlanProfanityLevel,
  BookWriterMode,
  BookWriterRequest,
  GateReport,
  ModelBenchRecord,
  ReviewPack,
  ReviewRecommendation,
} from "./types.js";

export type BookWriterPipelineOptions = {
  config: ResolvedBookWriterConfig;
  request: BookWriterRequest;
  stages?: "plan" | "write" | "gate" | "package" | "review-pack";
  fetchImpl?: typeof fetch;
};

type PipelineState = {
  paths: ReturnType<typeof resolveRunPaths>;
  bible: BookBible;
  outline: BookOutline;
  manuscript: string;
  gaps: string[];
  selectedModel?: ModelBenchRecord;
};

const DEFAULT_CAST: BookBible["cast"] = [
  {
    name: "Audrey Vale",
    role: "protagonist and night-shift warehouse auditor",
    notes: "Patient, exacting, and morally steady; use her as the lead in every chapter.",
  },
  {
    name: "Marcus Reed",
    role: "security guard and practical ally",
    notes: "Helps Audrey verify physical evidence and access logs.",
  },
  {
    name: "Nora Pell",
    role: "warehouse manager",
    notes: "Knows the business pressure points and may be hiding uncomfortable facts.",
  },
  {
    name: "Gideon Shaw",
    role: "bookkeeper connected to the invoice fraud",
    notes: "A plausible suspect whose motive must be proven, not assumed.",
  },
];
const LIVE_SEGMENT_TARGET_WORDS = 1200;
const MIN_LIVE_SEGMENT_TOKENS = 512;
const MAX_LIVE_SEGMENT_TOKENS = 4096;
const MIN_LIVE_SEGMENT_TIMEOUT_MS = 90 * 1000;
const MAX_LIVE_SEGMENT_TIMEOUT_MS = 10 * 60 * 1000;
const TARGET_WORD_APPROVAL_RATIO = 0.9;
const MAX_LIVE_CHAPTER_EXPANSION_ATTEMPTS = 4;

function castForBible(bible: BookBible): BookBible["cast"] {
  return Array.isArray(bible.cast) && bible.cast.length > 0 ? bible.cast : DEFAULT_CAST;
}

function defaultTopic(request: BookWriterRequest): string {
  return (
    request.topic ??
    "An original clean mystery about a small-town repair expert who uncovers a financial fraud without compromising his conscience"
  );
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

function defaultTone(request: BookWriterRequest): string {
  return request.tone?.trim() || "Professional, polished, practical, and clear.";
}

function profanityRequirement(level: BookPlanProfanityLevel): string {
  switch (level) {
    case "mild":
      return "Allow mild category-appropriate profanity only when the scene pressure justifies it.";
    case "moderate":
      return "Allow moderate category-appropriate profanity, but keep it character-serving and non-gratuitous.";
    case "high":
      return "Allow high profanity relative to the category when it supports voice, character, and stakes.";
    case "extreme":
      return "Allow extreme profanity relative to the category, including frequent explicit language when it matches the audience expectation.";
    case "none":
    default:
      return "Use no profanity; keep the manuscript clean for the category.";
  }
}

function profanityNarrativeLine(level: BookPlanProfanityLevel): string {
  switch (level) {
    case "mild":
      return "When frustration showed, it came through in brief rough edges rather than spectacle.";
    case "moderate":
      return "The pressure gave the dialogue a rougher edge, enough to feel honest without overtaking the case.";
    case "high":
      return "The scene allowed a blunt, hard-edged voice because the stakes had earned that heat.";
    case "extreme":
      return "The scene carried a raw, explicit edge, matching characters who had run out of patience and politeness.";
    case "none":
    default:
      return "Even under pressure, the language stayed clean and the tension came from evidence, choices, and consequence.";
  }
}

function choosePenName(config: ResolvedBookWriterConfig, requested?: string) {
  return (
    config.penNames.find((penName) => penName.name === requested) ??
    config.penNames[0] ?? {
      name: "Northstar House",
      lane: "clean commercial mystery",
      readerPromise: "fast, satisfying suspense with practical courage",
    }
  );
}

function buildBookBible(params: {
  config: ResolvedBookWriterConfig;
  request: BookWriterRequest;
  runId: string;
  now: Date;
}): BookBible {
  const penName = choosePenName(params.config, params.request.penName);
  const topic = defaultTopic(params.request);
  const genre = params.request.genre ?? penName.lane;
  const profanityLevel = normalizeProfanityLevel(params.request.profanityLevel);
  const titleSeed = topic
    .replace(/^an?\s+original\s+/i, "")
    .replace(/\babout\b.+$/i, "")
    .trim();
  const title =
    titleSeed.length > 8 && titleSeed.length < 64
      ? titleSeed.replace(/\b\w/g, (char) => char.toUpperCase())
      : "The Ledger at Briar Hill";
  return {
    runId: params.runId,
    title,
    subtitle: "An Original Clean Mystery",
    slug: slugify(title),
    penName: penName.name,
    genre,
    readerPromise: penName.readerPromise,
    premise: topic,
    cast: DEFAULT_CAST,
    originalityStrategy: [
      "Use original names, settings, chapter problems, and resolution.",
      "Avoid franchise elements, living-author style imitation, summaries, and public-domain rewrites.",
      "Build continuity from the book bible and outline rather than copied source material.",
    ],
    bannedDependencies: [
      "third-party summaries",
      "fanfic",
      "living-author style imitation",
      "unauthorized biographies",
      "PLR",
    ],
    targetWords: params.request.targetWords ?? 12000,
    tone: defaultTone(params.request),
    profanityLevel,
    createdAt: params.now.toISOString(),
  };
}

function buildOutline(runId: string): BookOutline {
  const chapters = [
    ["The Broken Bell", "A small public failure reveals a hidden ledger."],
    ["Receipts in the Rain", "The hero finds a pattern without trusting rumor."],
    ["A Favor Repaid", "An ally offers help with a cost."],
    ["The Locked Workshop", "Evidence disappears and forces a new theory."],
    ["The Quiet Audit", "The cast tests every claim before accusing anyone."],
    ["A Name on the Margin", "The real motive becomes personal but not petty."],
    ["The Town Meeting", "Truth is presented under pressure."],
    ["Resolution at First Light", "The fraud is stopped and the community repairs itself."],
  ];
  return {
    runId,
    chapters: chapters.map(([title, promise], index) => ({
      number: index + 1,
      title,
      promise,
      beats: [
        "Open with a concrete scene and immediate question.",
        "Advance one clue, one relationship, and one obstacle.",
        "Close with a decision that makes the next chapter necessary.",
      ],
    })),
  };
}

function deterministicChapter(params: {
  bible: BookBible;
  chapterTitle: string;
  chapterNumber: number;
  promise: string;
  targetWords: number;
}): string {
  const protagonist = castForBible(params.bible)[0]?.name ?? "Audrey Vale";
  const ally = castForBible(params.bible)[1]?.name ?? "Marcus Reed";
  const tone = params.bible.tone ?? "Professional, polished, practical, and clear.";
  const language = profanityNarrativeLine(normalizeProfanityLevel(params.bible.profanityLevel));
  const paragraphs = [
    `${params.chapterTitle} began with a practical problem, the kind nobody could ignore because it made honest work harder. The town had learned to tolerate small inconveniences, but this one carried a pattern that asked for courage instead of complaint.`,
    `${protagonist} did not chase drama. She checked dates, names, receipts, and the tiny contradictions people usually wave away. Each fact had to stand on its own because the book's promise is a clean mystery solved by discipline, neighborly loyalty, and moral nerve.`,
    `The voice stayed ${tone.replace(/[.?!]+$/g, "").toLowerCase()}, and every sentence worked to keep the reader inside the problem. ${language}`,
    `${params.promise} The discovery changed what the characters believed about the case, yet it did not give them permission to become reckless. They measured the next step, protected the innocent, and refused the easy accusation.`,
    `By the end of the chapter, the conflict had narrowed. Someone had benefited from confusion, someone had counted on silence, and someone had underestimated what ordinary people can do when they decide that truth is worth the inconvenience.`,
  ];
  const wordsPerLoop = countWords(paragraphs.join("\n\n"));
  const loops = Math.max(1, Math.ceil(params.targetWords / Math.max(1, wordsPerLoop)));
  const body: string[] = [];
  for (let index = 0; index < loops; index += 1) {
    body.push(
      ...paragraphs.map((paragraph) =>
        paragraph.replace(protagonist, index % 2 === 0 ? protagonist : ally),
      ),
    );
  }
  return `## Chapter ${params.chapterNumber}: ${params.chapterTitle}\n\n${body.join("\n\n")}`;
}

function deterministicManuscript(params: { bible: BookBible; outline: BookOutline }): string {
  const chapterTarget = Math.ceil(params.bible.targetWords / params.outline.chapters.length);
  return [
    `# ${params.bible.title}`,
    `By ${params.bible.penName}`,
    ...params.outline.chapters.map((chapter) =>
      deterministicChapter({
        bible: params.bible,
        chapterTitle: chapter.title,
        chapterNumber: chapter.number,
        promise: chapter.promise,
        targetWords: chapterTarget,
      }),
    ),
    "## Final Note",
    "The resolution is complete, the central question is answered, and the book remains original to this generated review package.",
  ].join("\n\n");
}

function normalizeLiveChapter(params: {
  chapter: BookOutline["chapters"][number];
  text: string;
}): string {
  const heading = `## Chapter ${params.chapter.number}: ${params.chapter.title}`;
  const trimmed = params.text.trim();
  if (trimmed.startsWith(heading)) {
    return trimmed;
  }
  return `${heading}\n\n${trimmed.replace(/^#+\s.*$/m, "").trim()}`;
}

function normalizeLiveSegment(params: {
  chapter: BookOutline["chapters"][number];
  segmentNumber: number;
  text: string;
}): string {
  if (params.segmentNumber === 1) {
    return normalizeLiveChapter({ chapter: params.chapter, text: params.text });
  }
  return params.text.replace(/^## Chapter\s+\d+:\s+.+$/gm, "").trim();
}

function liveChapterSegmentPrompt(params: {
  bible: BookBible;
  outline: BookOutline;
  chapter: BookOutline["chapters"][number];
  chapterTarget: number;
  segmentNumber: number;
  segmentCount: number;
  segmentTarget: number;
  minSegmentWords: number;
  retry?: boolean;
}): string {
  const firstSegment = params.segmentNumber === 1;
  const headingInstruction = firstSegment
    ? `Start exactly with "## Chapter ${params.chapter.number}: ${params.chapter.title}".`
    : `Continue Chapter ${params.chapter.number}: ${params.chapter.title}; do not repeat the chapter heading.`;
  return `Write segment ${params.segmentNumber} of ${params.segmentCount} for one chapter of a complete original ${params.bible.genre} manuscript.

Hard requirements:
- ${headingInstruction}
- Write only final manuscript prose for this chapter.
- Do not add analysis, planning notes, summaries, source references, or publishing commentary.
- Target about ${params.segmentTarget} words for this segment.
- Use at least ${params.minSegmentWords} words.
- Preserve the book premise, reader promise, requested tone, and language controls.
- Tone: ${params.bible.tone ?? "Professional, polished, practical, and clear."}
- Profanity setting: ${profanityRequirement(normalizeProfanityLevel(params.bible.profanityLevel))}
- Use Audrey Vale as the protagonist in this chapter; do not rename the protagonist.
- ${params.segmentNumber === params.segmentCount ? "End with a decision, clue, or turn that makes the next chapter necessary." : "End with an unresolved beat that naturally continues this same chapter."}
${params.retry ? "- This is a repair retry: expand the scene with specific action, dialogue, and clue work while keeping the exact heading." : ""}

Book title: ${params.bible.title}
Pen name: ${params.bible.penName}
Premise: ${params.bible.premise}
Reader promise: ${params.bible.readerPromise}
Chapter promise: ${params.chapter.promise}
Chapter target: about ${params.chapterTarget} words across all ${params.segmentCount} segment(s).
Canonical cast:
${castForBible(params.bible)
  .map((member) => `- ${member.name}: ${member.role}. ${member.notes}`)
  .join("\n")}
Chapter beats:
${params.chapter.beats.map((beat) => `- ${beat}`).join("\n")}

Full outline context:
${params.outline.chapters
  .map((chapter) => `Chapter ${chapter.number}: ${chapter.title} - ${chapter.promise}`)
  .join("\n")}`;
}

function liveChapterExpansionPrompt(params: {
  bible: BookBible;
  chapter: BookOutline["chapters"][number];
  missingWords: number;
  currentChapter: string;
}): string {
  return `Continue and expand Chapter ${params.chapter.number}: ${params.chapter.title} for the same original ${params.bible.genre} manuscript.

Hard requirements:
- Write only additional manuscript prose.
- Do not repeat the chapter heading.
- Add at least ${params.missingWords} useful words of specific scene action, dialogue, evidence work, or character decision.
- Keep Audrey Vale as the protagonist and preserve the same clue logic.
- Tone: ${params.bible.tone ?? "Professional, polished, practical, and clear."}
- Profanity setting: ${profanityRequirement(normalizeProfanityLevel(params.bible.profanityLevel))}
- Do not add analysis, notes, summaries, or publishing commentary.

Book title: ${params.bible.title}
Premise: ${params.bible.premise}
Reader promise: ${params.bible.readerPromise}
Chapter promise: ${params.chapter.promise}

Current chapter text to continue:
${params.currentChapter.slice(-4000)}`;
}

function liveSegmentBudget(params: { segmentTarget: number; tokensPerSecond: number }): {
  maxTokens: number;
  timeoutMs: number;
} {
  const maxTokens = Math.min(
    MAX_LIVE_SEGMENT_TOKENS,
    Math.max(MIN_LIVE_SEGMENT_TOKENS, Math.ceil(params.segmentTarget * 1.8)),
  );
  const expectedMs = Math.ceil((maxTokens / Math.max(1, params.tokensPerSecond)) * 1000 * 3);
  return {
    maxTokens,
    timeoutMs: Math.min(
      MAX_LIVE_SEGMENT_TIMEOUT_MS,
      Math.max(MIN_LIVE_SEGMENT_TIMEOUT_MS, expectedMs),
    ),
  };
}

async function planStage(params: {
  config: ResolvedBookWriterConfig;
  request: BookWriterRequest;
}): Promise<PipelineState> {
  const promptReport = detectCopyrightAdjacentPrompt(defaultTopic(params.request));
  const now = new Date();
  const seed = defaultTopic(params.request);
  const runId = params.request.runId ?? createRunId(seed, now);
  const paths = resolveRunPaths(params.config.outputDir, runId);
  await ensureRunDir(paths);
  if (promptReport.status === "blocked") {
    const bible = buildBookBible({ config: params.config, request: params.request, runId, now });
    const outline = buildOutline(runId);
    await writeJsonFile(path.join(paths.runDir, "originality-report.json"), promptReport);
    await writeJsonFile(path.join(paths.runDir, "book-bible.json"), bible);
    await writeJsonFile(path.join(paths.runDir, "outline.json"), outline);
    return {
      paths,
      bible,
      outline,
      manuscript: "",
      gaps: ["Prompt blocked before drafting because it is copyright-adjacent."],
    };
  }
  const bible =
    (await readJsonFile<BookBible>(path.join(paths.runDir, "book-bible.json"))) ??
    buildBookBible({ config: params.config, request: params.request, runId, now });
  const outline =
    (await readJsonFile<BookOutline>(path.join(paths.runDir, "outline.json"))) ??
    buildOutline(runId);
  await writeJsonFile(path.join(paths.runDir, "book-bible.json"), bible);
  await writeJsonFile(path.join(paths.runDir, "outline.json"), outline);
  return { paths, bible, outline, manuscript: "", gaps: [] };
}

async function selectModel(config: ResolvedBookWriterConfig, request: BookWriterRequest) {
  const records = await readBenchRecords(config.outputDir);
  return selectBestModel({
    records,
    policy: config.memoryPolicy,
    mode: request.mode ?? "normal",
    preferredModel: request.model,
  });
}

function selectionGaps(params: {
  request: BookWriterRequest;
  selected?: ModelBenchRecord;
  rejected: Array<{ model: string; reasons: string[] }>;
}): string[] {
  if (!params.selected) {
    return params.rejected.flatMap((item) =>
      item.reasons.map((reason) => `${item.model}: ${reason}`),
    );
  }
  if (params.request.model && params.selected.model !== params.request.model) {
    const preferredRejection = params.rejected.find((item) => item.model === params.request.model);
    return [
      `Preferred model ${params.request.model} was not eligible; selected ${params.selected.model}.`,
      ...(preferredRejection?.reasons.map((reason) => `${params.request.model}: ${reason}`) ?? []),
    ];
  }
  return [];
}

async function writeStage(params: {
  config: ResolvedBookWriterConfig;
  state: PipelineState;
  request: BookWriterRequest;
  fetchImpl?: typeof fetch;
}): Promise<PipelineState> {
  const existingPath = path.join(params.state.paths.runDir, "manuscript.md");
  if (await fileExists(existingPath)) {
    const { selected, rejected } = await selectModel(params.config, params.request);
    return {
      ...params.state,
      gaps: [
        ...params.state.gaps,
        ...selectionGaps({ request: params.request, selected, rejected }),
      ],
      manuscript: await import("node:fs/promises").then((fs) => fs.readFile(existingPath, "utf8")),
      selectedModel: selected,
    };
  }
  const { selected, rejected } = await selectModel(params.config, params.request);
  const gaps = [
    ...params.state.gaps,
    ...selectionGaps({ request: params.request, selected, rejected }),
  ];
  const wantsLive = params.request.liveModel ?? true;
  const chapterTarget = Math.ceil(
    params.state.bible.targetWords / params.state.outline.chapters.length,
  );
  let manuscript = "";
  if (selected && wantsLive) {
    const chapters: string[] = [];
    for (const chapter of params.state.outline.chapters) {
      const segmentCount = Math.max(1, Math.ceil(chapterTarget / LIVE_SEGMENT_TARGET_WORDS));
      const segmentTarget = Math.ceil(chapterTarget / segmentCount);
      const segmentBudget = liveSegmentBudget({
        segmentTarget,
        tokensPerSecond: selected.tokensPerSecond,
      });
      const minChapterWords = Math.max(
        80,
        Math.floor(chapterTarget * TARGET_WORD_APPROVAL_RATIO),
        Math.ceil(params.config.qualityThresholds.minWords / params.state.outline.chapters.length),
      );
      const minSegmentWords = Math.max(80, Math.floor(segmentTarget * 0.55));
      const segments: string[] = [];
      let acceptedChapter = "";
      let lastGeneration: GenerateTextResult | undefined;
      for (let segmentNumber = 1; segmentNumber <= segmentCount; segmentNumber += 1) {
        let acceptedSegment = "";
        let bestSegment = "";
        for (const attempt of [0, 1]) {
          const generation = await generateText({
            config: params.config,
            model: selected,
            prompt: liveChapterSegmentPrompt({
              bible: params.state.bible,
              outline: params.state.outline,
              chapter,
              chapterTarget,
              segmentNumber,
              segmentCount,
              segmentTarget: attempt === 0 ? segmentTarget : Math.max(segmentTarget, 180),
              minSegmentWords,
              retry: attempt > 0,
            }),
            liveModel: true,
            maxTokens: segmentBudget.maxTokens,
            timeoutMs: segmentBudget.timeoutMs,
            fetchImpl: params.fetchImpl,
          });
          lastGeneration = generation;
          const liveText = generation.text.trim();
          if (generation.live && liveText) {
            const normalized = normalizeLiveSegment({ chapter, segmentNumber, text: liveText });
            if (countWords(normalized) > countWords(bestSegment)) {
              bestSegment = normalized;
            }
            if (countWords(normalized) >= minSegmentWords) {
              acceptedSegment = normalized;
              break;
            }
          }
        }
        if (!acceptedSegment && bestSegment) {
          acceptedSegment = bestSegment;
        }
        if (!acceptedSegment) {
          break;
        }
        segments.push(acceptedSegment);
      }
      let liveChapter = normalizeLiveChapter({ chapter, text: segments.join("\n\n") });
      if (segments.length === segmentCount && countWords(liveChapter) < minChapterWords) {
        for (
          let expansionAttempt = 0;
          expansionAttempt < MAX_LIVE_CHAPTER_EXPANSION_ATTEMPTS;
          expansionAttempt += 1
        ) {
          const missingWords = minChapterWords - countWords(liveChapter);
          if (missingWords <= 0) {
            break;
          }
          const expansionBudget = liveSegmentBudget({
            segmentTarget: Math.max(missingWords, 240),
            tokensPerSecond: selected.tokensPerSecond,
          });
          const generation = await generateText({
            config: params.config,
            model: selected,
            prompt: liveChapterExpansionPrompt({
              bible: params.state.bible,
              chapter,
              missingWords,
              currentChapter: liveChapter,
            }),
            liveModel: true,
            maxTokens: expansionBudget.maxTokens,
            timeoutMs: expansionBudget.timeoutMs,
            fetchImpl: params.fetchImpl,
          });
          lastGeneration = generation;
          const addition = normalizeLiveSegment({
            chapter,
            segmentNumber: 2,
            text: generation.text.trim(),
          });
          if (generation.live && countWords(addition) > 0) {
            liveChapter = normalizeLiveChapter({
              chapter,
              text: `${liveChapter}\n\n${addition}`,
            });
          }
        }
      }
      if (segments.length === segmentCount && countWords(liveChapter) >= minChapterWords) {
        acceptedChapter = liveChapter;
      }
      if (acceptedChapter) {
        chapters.push(acceptedChapter);
        continue;
      }
      gaps.push(...(lastGeneration?.gaps ?? []));
      gaps.push(
        `${lastGeneration?.provider ?? selected.provider} ${lastGeneration?.model ?? selected.model} output for chapter ${chapter.number} was too short or unavailable after segmented retry; deterministic fallback was used for that chapter.`,
      );
      chapters.push(
        deterministicChapter({
          bible: params.state.bible,
          chapterTitle: chapter.title,
          chapterNumber: chapter.number,
          promise: chapter.promise,
          targetWords: chapterTarget,
        }),
      );
    }
    manuscript = [
      `# ${params.state.bible.title}`,
      `By ${params.state.bible.penName}`,
      ...chapters,
      "## Final Note",
      "The resolution is complete, the central question is answered, and the book remains original to this generated review package.",
    ].join("\n\n");
  } else if (selected) {
    const generation: GenerateTextResult = await generateText({
      config: params.config,
      model: selected,
      prompt: "",
      liveModel: false,
      fetchImpl: params.fetchImpl,
    });
    gaps.push(...generation.gaps);
  } else {
    gaps.push("No eligible model was available under the active memory policy.");
  }
  if (!manuscript) {
    manuscript = deterministicManuscript({
      bible: params.state.bible,
      outline: params.state.outline,
    });
  }
  await writeTextFile(existingPath, manuscript);
  return { ...params.state, manuscript, gaps, selectedModel: selected };
}

async function gateStage(params: {
  config: ResolvedBookWriterConfig;
  state: PipelineState;
  request: BookWriterRequest;
}): Promise<{
  quality: GateReport;
  originality: GateReport;
  editorialPolicy: GateReport;
  continuity: GateReport;
  storyQuality: GateReport;
  endurance: GateReport;
  exportValidation: GateReport;
}> {
  const protagonist = castForBible(params.state.bible).find((member) =>
    member.role.includes("protagonist"),
  )?.name;
  const endurance = estimateBookEndurance({
    targetWords: params.state.bible.targetWords,
    chapterCount: params.state.outline.chapters.length,
    tokensPerSecond: params.state.selectedModel?.tokensPerSecond ?? 1,
    reviewReadyBy: params.config.schedule.reviewReadyBy,
  });
  const continuity = buildContinuityReport({
    manuscript: params.state.manuscript,
    chapterCount: params.state.outline.chapters.length,
    expectedProtagonist: protagonist,
  });
  const storyQuality = buildStoryQualityReport({
    bible: params.state.bible,
    outline: params.state.outline,
    manuscript: params.state.manuscript,
  });
  const enduranceReport = buildEnduranceReport({
    selectedModel: params.state.selectedModel,
    endurance,
    memoryCapGb: memoryCapForMode(params.config.memoryPolicy, params.request.mode ?? "normal"),
  });
  const originality = await buildOriginalityReport({
    config: params.config,
    runId: params.state.paths.runId,
    prompt: params.state.bible.premise,
    manuscript: params.state.manuscript,
    premise: params.state.bible.premise,
  });
  const editorialPolicy = buildEditorialPolicyReport({
    config: params.config,
    text: `${params.state.bible.premise}\n${params.state.manuscript}`,
  });
  const quality = buildQualityReport({
    config: params.config,
    manuscript: params.state.manuscript,
    targetWords: params.state.bible.targetWords,
    profanityLevel: params.state.bible.profanityLevel,
    expectedArtifacts: {
      "book-bible": path.join(params.state.paths.runDir, "book-bible.json"),
      outline: path.join(params.state.paths.runDir, "outline.json"),
      manuscript: path.join(params.state.paths.runDir, "manuscript.md"),
    },
  });
  const exportValidation = (await readJsonFile<GateReport>(
    path.join(params.state.paths.runDir, "export-validation-report.json"),
  )) ?? {
    status: "warn",
    findings: [
      {
        code: "export-validation",
        status: "warn",
        message: "Packaging export validation has not run yet.",
      },
    ],
  };
  await writeJsonFile(path.join(params.state.paths.runDir, "continuity-report.json"), continuity);
  await writeJsonFile(path.join(params.state.paths.runDir, "originality-report.json"), originality);
  await writeJsonFile(
    path.join(params.state.paths.runDir, "editorial-policy-report.json"),
    editorialPolicy,
  );
  await writeJsonFile(path.join(params.state.paths.runDir, "quality-report.json"), quality);
  await writeJsonFile(
    path.join(params.state.paths.runDir, "story-quality-report.json"),
    storyQuality,
  );
  await writeJsonFile(
    path.join(params.state.paths.runDir, "endurance-report.json"),
    enduranceReport,
  );
  return {
    quality,
    originality,
    editorialPolicy,
    continuity,
    storyQuality,
    endurance: enduranceReport,
    exportValidation,
  };
}

async function packageStage(params: {
  config: ResolvedBookWriterConfig;
  state: PipelineState;
}): Promise<Record<string, string>> {
  const runDir = params.state.paths.runDir;
  const printHtmlPath = path.join(runDir, "print.html");
  const ebookPath = path.join(runDir, "ebook.epub");
  const printPdfPath = path.join(runDir, "print.pdf");
  const coverTiffPath = path.join(runDir, "cover.tiff");
  const coverSvgPath = path.join(runDir, "cover.svg");
  const metadata = {
    title: params.state.bible.title,
    subtitle: params.state.bible.subtitle,
    penName: params.state.bible.penName,
    genre: params.state.bible.genre,
    slug: params.state.bible.slug,
    targetWords: params.state.bible.targetWords,
  };
  const publishPreview = buildPublishPreview(params.state.bible, params.state.manuscript);
  await writeJsonFile(path.join(runDir, "metadata.json"), metadata);
  await writeJsonFile(path.join(runDir, "publish-preview.json"), publishPreview);
  await writeJsonFile(path.join(runDir, "cover-brief.json"), {
    title: params.state.bible.title,
    subtitle: params.state.bible.subtitle,
    marketSignal: params.state.bible.genre,
    uploadCover: "cover.tiff",
    pixelDimensions: "1600x2560",
    format: "RGB TIFF",
    instruction:
      "Create a clean commercial mystery cover with restrained typography, no trademarked imagery, and clear thumbnail readability.",
  });
  await writeTextFile(coverSvgPath, buildCoverSvg(params.state.bible));
  await writeBinaryFile(coverTiffPath, buildCoverTiff(params.state.bible));
  await writeTextFile(
    printHtmlPath,
    buildPrintHtml({
      bible: params.state.bible,
      outline: params.state.outline,
      manuscript: params.state.manuscript,
    }),
  );
  await writeEpub({
    outputPath: ebookPath,
    bible: params.state.bible,
    outline: params.state.outline,
    manuscript: params.state.manuscript,
  });
  const exportValidation = await validatePublishingExports({
    epubPath: ebookPath,
    printHtmlPath,
    printPdfPath,
  });
  await writeJsonFile(path.join(runDir, "export-validation-report.json"), exportValidation.report);
  return {
    bookBible: path.join(runDir, "book-bible.json"),
    outline: path.join(runDir, "outline.json"),
    manuscript: path.join(runDir, "manuscript.md"),
    metadata: path.join(runDir, "metadata.json"),
    publishPreview: path.join(runDir, "publish-preview.json"),
    coverBrief: path.join(runDir, "cover-brief.json"),
    cover: coverTiffPath,
    coverSvg: coverSvgPath,
    ebook: ebookPath,
    printHtml: printHtmlPath,
    ...(exportValidation.printPdfPath ? { printPdf: exportValidation.printPdfPath } : {}),
  };
}

function recommendationFor(params: {
  reports: Record<string, GateReport>;
  gaps: string[];
}): ReviewRecommendation {
  const statuses = new Set(Object.values(params.reports).map((report) => report.status));
  if (statuses.has("blocked")) {
    return "blocked";
  }
  if (statuses.has("fail")) {
    return "reject";
  }
  if (params.gaps.length > 0 || statuses.has("warn")) {
    return "revise";
  }
  return "approve";
}

export async function runBookWriterPipeline(
  options: BookWriterPipelineOptions,
): Promise<ReviewPack> {
  const planned = await planStage({ config: options.config, request: options.request });
  const written =
    options.stages === "plan"
      ? planned
      : await writeStage({
          config: options.config,
          state: planned,
          request: options.request,
          fetchImpl: options.fetchImpl,
        });
  const artifacts =
    options.stages === "plan" || options.stages === "write" || written.manuscript.length === 0
      ? {
          bookBible: path.join(written.paths.runDir, "book-bible.json"),
          outline: path.join(written.paths.runDir, "outline.json"),
          manuscript: path.join(written.paths.runDir, "manuscript.md"),
        }
      : await packageStage({ config: options.config, state: written });
  const reports = await gateStage({
    config: options.config,
    state: written,
    request: options.request,
  });
  if (artifacts.ebook) {
    reports.quality.findings.push(await validateEpubStructure(artifacts.ebook));
    reports.quality.status = reports.quality.findings.some((finding) => finding.status === "fail")
      ? "fail"
      : reports.quality.status;
    await writeJsonFile(path.join(written.paths.runDir, "quality-report.json"), reports.quality);
  }
  const publishPreview =
    (await readJsonFile<ReviewPack["publishPreview"]>(
      path.join(written.paths.runDir, "publish-preview.json"),
    )) ?? buildPublishPreview(written.bible, written.manuscript);
  const reviewPack: ReviewPack = {
    runId: written.paths.runId,
    recommendation: recommendationFor({ reports, gaps: written.gaps }),
    artifacts: {
      ...artifacts,
      continuityReport: path.join(written.paths.runDir, "continuity-report.json"),
      qualityReport: path.join(written.paths.runDir, "quality-report.json"),
      originalityReport: path.join(written.paths.runDir, "originality-report.json"),
      editorialPolicyReport: path.join(written.paths.runDir, "editorial-policy-report.json"),
      storyQualityReport: path.join(written.paths.runDir, "story-quality-report.json"),
      enduranceReport: path.join(written.paths.runDir, "endurance-report.json"),
      exportValidationReport: path.join(written.paths.runDir, "export-validation-report.json"),
    },
    gaps: written.gaps,
    reports,
    publishPreview,
    createdAt: new Date().toISOString(),
  };
  await writeJsonFile(path.join(written.paths.runDir, "review-pack.json"), reviewPack);
  return reviewPack;
}

export async function runPipelineStage(options: BookWriterPipelineOptions): Promise<ReviewPack> {
  return runBookWriterPipeline(options);
}

export function normalizeMode(mode?: string): BookWriterMode {
  if (mode === "light" || mode === "ideal" || mode === "premium" || mode === "normal") {
    return mode;
  }
  return "normal";
}
