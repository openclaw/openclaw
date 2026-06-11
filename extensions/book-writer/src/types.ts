export type BookWriterMode = "normal" | "ideal" | "premium" | "light";
export type ReviewRecommendation = "approve" | "revise" | "reject" | "blocked";
export type BookPlanStatus =
  | "brief"
  | "chapter-plan"
  | "paragraph-plan"
  | "drafting"
  | "stitched"
  | "packaged"
  | "publish-ready";
export type BookPlanMode = "simple" | "advanced";
export type BookPlanParagraphStatus = "planned" | "drafted" | "needs-revision" | "approved";
export type BookPlanTonePreset =
  | "professional"
  | "technical"
  | "conversational"
  | "humorous"
  | "dramatic"
  | "literary"
  | "inspirational"
  | "direct"
  | "custom";
export type BookPlanProfanityLevel = "none" | "mild" | "moderate" | "high" | "extreme";

export type MemoryPolicy = {
  defaultGb: number;
  idealGb: number;
  premiumGb: number;
  hardRejectGb: number;
};

export type BookWriterRequest = {
  runId?: string;
  topic?: string;
  genre?: string;
  penName?: string;
  targetWords?: number;
  tone?: string;
  tonePreset?: BookPlanTonePreset;
  profanityLevel?: BookPlanProfanityLevel;
  nonfiction?: boolean;
  mode?: BookWriterMode;
  model?: string;
  liveModel?: boolean;
};

export type BookPlanBrief = {
  topicParagraph: string;
  readerPromise: string;
  audience: string;
  tone: string;
  constraints: string[];
};

export type BookPlanParagraph = {
  id: string;
  order: number;
  title: string;
  summary: string;
  purpose: string;
  beats: string[];
  styleDirection: string;
  fieldLocks?: {
    title?: boolean;
    summary?: boolean;
    purpose?: boolean;
    styleDirection?: boolean;
    text?: boolean;
  };
  targetWords: number;
  text: string;
  locked: boolean;
  status: BookPlanParagraphStatus;
  sourceParagraphIds?: string[];
  sceneBeatId?: string;
  lockConstraintIds?: string[];
  transitionIn?: string;
  transitionOut?: string;
  continuityObligations?: string[];
  revisionStatus?:
    | "clean"
    | "needs-context-repair"
    | "needs-style-repair"
    | "blocked-by-lock-conflict"
    | "blocked-by-cohesion-failure";
};

export type BookPlanChapterRole = {
  storyThread:
    | "main-story"
    | "side-story"
    | "converging-stories"
    | "flashback"
    | "interlude"
    | "abrupt-shift"
    | "resolution"
    | "custom";
  plotJob:
    | "setup"
    | "conflict"
    | "clue"
    | "red-herring"
    | "twist"
    | "reveal"
    | "payoff"
    | "mystery-deepens"
    | "custom";
  readerFeeling:
    | "calm"
    | "funny"
    | "suspenseful"
    | "dramatic"
    | "warm"
    | "dark"
    | "hopeful"
    | "fast-paced"
    | "custom";
  notes: string;
};

export type BookPlanChapter = {
  id: string;
  number: number;
  title: string;
  description: string;
  styleDirection: string;
  role?: BookPlanChapterRole;
  fieldLocks?: {
    title?: boolean;
    description?: boolean;
    styleDirection?: boolean;
    roleNotes?: boolean;
  };
  targetWords: number;
  locked: boolean;
  status: BookPlanParagraphStatus;
  paragraphs: BookPlanParagraph[];
  scenePurpose?: string;
  continuityIn?: string[];
  continuityOut?: string[];
  characterArcMove?: string;
  themeMove?: string;
  setupPayoffLinks?: string[];
};

export type BookPlanRevision = {
  version: number;
  at: string;
  action: string;
  summary: string;
};

export type BookPlanStyleGuide = {
  tonePreset: BookPlanTonePreset;
  toneDescription: string;
  profanityLevel: BookPlanProfanityLevel;
  profanityDescription: string;
};

export type BookPlanCover = {
  brief: string;
  prompt: string;
  status: "planned" | "generated" | "approved";
  variants: Array<{
    id: string;
    label: string;
    path?: string;
    source?: "local-ai" | "svg-concept" | "upload" | "kdp-cover-creator";
    prompt?: string;
    provider?: string;
    model?: string;
    createdAt?: string;
    mimeType?: string;
    previewDataUrl?: string;
    approved: boolean;
  }>;
};

export type BookPlanPublishing = {
  channel: "kdp";
  finalSubmitRequiresApproval: true;
  status: "not-ready" | "dry-run-ready" | "approval-required";
  checklist: string[];
};

export type BookPlan = {
  schemaVersion: 1;
  kind: "full" | "quick-read";
  sourceRunId?: string;
  runId: string;
  title: string;
  subtitle: string;
  slug: string;
  topic: string;
  genre: string;
  penName: string;
  targetWords: number;
  createdAt: string;
  updatedAt: string;
  version: number;
  status: BookPlanStatus;
  mode: BookPlanMode;
  canonVersion?: number;
  cohesionStatus?: "unbuilt" | "planned" | "drafted" | "revised" | "audited";
  qualityScore?: number;
  lastCohesionRunId?: string;
  storylineOverview?: {
    status: "current" | "stale" | "needs-refresh";
    shortText: string;
    protagonistGoal: string;
    centralConflict: string;
    currentTwist?: string;
    stakes: string;
    relationshipDynamics: string[];
    unresolvedQuestions: string[];
    nextChapterDirection: string;
    sourceVersion: number;
    updatedAt: string;
    confidence: number;
  };
  bookSync?: {
    state:
      | "synced"
      | "story-impact-detected"
      | "needs-propagation"
      | "updating-affected-chapters"
      | "locked-conflict-found"
      | "cohesion-review-needed"
      | "fully-updated";
    pendingImpactId?: string;
    lastAnalyzedVersion?: number;
    lastSyncedVersion?: number;
    affectedChapterIds: string[];
    affectedParagraphIds: string[];
    lockedConflictCount: number;
    cohesionScore?: number;
    summary: string;
  };
  storyImpactEvents?: Array<{
    id: string;
    createdAt: string;
    sourceVersion: number;
    sourceChapterId: string;
    sourceParagraphId?: string;
    editSummary: string;
    impactClass?: "local" | "scene" | "chapter" | "book";
    impactLevel: "none" | "local" | "chapter" | "multi-chapter" | "whole-book";
    twistTypes: string[];
    affectedSystems: string[];
    affectedChapterIds: string[];
    status: "detected" | "planned" | "applied" | "blocked" | "dismissed";
  }>;
  brief: BookPlanBrief;
  styleGuide?: BookPlanStyleGuide;
  chapters: BookPlanChapter[];
  cover: BookPlanCover;
  publishing: BookPlanPublishing;
  artifactLinks: Record<string, string>;
  revisionHistory: BookPlanRevision[];
};

export type BookPlanProjectSummary = {
  runId: string;
  title: string;
  subtitle: string;
  penName: string;
  genre: string;
  status: BookPlanStatus;
  kind: BookPlan["kind"];
  version: number;
  updatedAt: string;
  targetWords: number;
  draftedWords: number;
  chapterCount: number;
  paragraphCount: number;
  lockedParagraphCount: number;
  artifactLinks: Record<string, string>;
};

export type DeletedBookPlanSummary = {
  deletedId: string;
  runId: string;
  title: string;
  subtitle: string;
  penName: string;
  genre: string;
  status: BookPlanStatus;
  kind: BookPlan["kind"];
  version: number;
  deletedAt: string;
  originalDir?: string;
  targetWords: number;
  draftedWords: number;
  chapterCount: number;
  paragraphCount: number;
};

export type ArchivedBookPlanSummary = {
  archivedId: string;
  runId: string;
  title: string;
  subtitle: string;
  penName: string;
  genre: string;
  status: BookPlanStatus;
  kind: BookPlan["kind"];
  version: number;
  archivedAt: string;
  originalDir?: string;
  targetWords: number;
  draftedWords: number;
  chapterCount: number;
  paragraphCount: number;
};

export type FinishedBookPlanSummary = {
  finishedId: string;
  runId: string;
  title: string;
  subtitle: string;
  penName: string;
  genre: string;
  status: BookPlanStatus;
  kind: BookPlan["kind"];
  version: number;
  finishedAt: string;
  publishedAt?: string;
  originalDir?: string;
  coverPath?: string;
  coverSource?: string;
  coverPreviewDataUrl?: string;
  publishProof?: PublishedBookProof;
  metrics?: PublishedBookMetrics;
  targetWords: number;
  draftedWords: number;
  chapterCount: number;
  paragraphCount: number;
  artifactLinks: Record<string, string>;
};

export type PublishedBookProof = {
  destination: "amazon-kdp" | "kindle" | "paperback" | "other";
  publishedAt: string;
  operatorConfirmed?: boolean;
  confirmedAt?: string;
  asin?: string;
  marketplaceUrl?: string;
  priceUsd?: number;
  category?: string;
  keywords?: string[];
};

export type PublishedBookSalesSnapshot = {
  id: string;
  label: string;
  rangeStart?: string;
  rangeEnd?: string;
  unitsSold: number;
  revenueUsd: number;
  adSpendUsd: number;
  profitUsd: number;
  kuPagesRead?: number;
  royaltyUsd?: number;
  notes?: string;
};

export type PublishedBookMetrics = {
  totalSales: number;
  totalRevenueUsd: number;
  totalProfitUsd: number;
  adSpendUsd: number;
  ratingAverage?: number;
  reviewCount?: number;
  snapshots: PublishedBookSalesSnapshot[];
  updatedAt?: string;
};

export type BookWriterNextBookRecommendation = {
  topicParagraph: string;
  title: string;
  confidence: "starter" | "medium" | "high";
  why: string;
  evidence: string[];
};

export type BookWriterPenNameProfile = {
  name: string;
  lane: string;
  readerPromise: string;
  publishedCount: number;
  completedCount: number;
  inProgressCount: number;
  books: {
    published: Array<{ id: string; title: string; genre: string; words: number }>;
    completed: Array<{ id: string; title: string; genre: string; words: number }>;
    inProgress: Array<{ id: string; title: string; genre: string; words: number }>;
  };
  updatedAt?: string;
};

export type BookWriterAutomationStatus = {
  enabled: boolean;
  scheduled: boolean;
  status: "manual-only" | "scheduled" | "scheduled-paused";
  message: string;
  schedulePath?: string;
  scriptPath?: string;
  cronExpression?: string;
  timezone?: string;
};

export type BookWriterAiHelpIntent =
  | "fill"
  | "improve"
  | "shorten"
  | "clearer"
  | "dramatic"
  | "humorous"
  | "custom";

export type BookWriterAiHelpTarget =
  | "bookStyle"
  | "title"
  | "topic"
  | "audience"
  | "readerPromise"
  | "chapterTitle"
  | "chapterDescription"
  | "chapterStyle"
  | "paragraphTitle"
  | "paragraphSummary"
  | "paragraphPlan"
  | "paragraphStyle"
  | "paragraphText"
  | "coverBrief"
  | "coverPrompt";

export type BookWriterIdeaSetupTarget =
  | "title"
  | "summary"
  | "readerPromise"
  | "targetWords"
  | "tone"
  | "audience";

export type BookWriterChapterSetupTarget = "title" | "description" | "style" | "role";

export type BookWriterAiHelpSuggestion = {
  runId: string;
  target: BookWriterAiHelpTarget;
  intent: BookWriterAiHelpIntent;
  chapterId?: string;
  paragraphId?: string;
  original: string;
  suggestion: string;
  explanation: string;
  contextSummary: string;
  engine?: "live-model" | "local-context-fallback";
  lockedContext?: string[];
};

export type BookWriterGenerationModel = {
  provider: "lmstudio" | "ollama" | "custom";
  model: string;
};

export type BookWriterLocalAiHealth = {
  status: "ready" | "unreachable" | "model-missing" | "unknown";
  provider: "lmstudio" | "ollama" | "custom";
  model: string;
  baseUrl: string;
  reachable: boolean;
  modelAvailable: boolean;
  modelLoaded: boolean;
  message: string;
  lastCheckedAt: string;
  lastError?: string;
  benchmark?: {
    source: "estimated" | "measured" | "unavailable";
    tokensPerSecond: number;
    peakMemoryGb: number;
    qualityScore: number;
    measuredAt: string;
  };
  guidance: string[];
};

export type BookWriterLocalCoverAiStatus = {
  status: "ready" | "setup-needed" | "fallback";
  provider?: string;
  model?: string;
  message: string;
  guidance: string[];
  checkedAt: string;
};

export type BookPlanQualityReport = GateReport & {
  counts: {
    chapters: number;
    paragraphs: number;
    draftedParagraphs: number;
    lockedParagraphs: number;
    draftedWords: number;
  };
};

export type BookPlanFinalCohesionReport = GateReport;
export type BookPlanGenreExcellenceReport = GateReport & {
  genreFamily: "fiction" | "mystery" | "nonfiction" | "memoir" | "business" | "education";
};

export type BookWriterDashboardSnapshot = {
  generatedAt: string;
  outputDir: string;
  projects: BookPlanProjectSummary[];
  archivedBooks: ArchivedBookPlanSummary[];
  deletedBooks: DeletedBookPlanSummary[];
  finishedBooks: FinishedBookPlanSummary[];
  penNameProfiles: BookWriterPenNameProfile[];
  recommendation?: BookWriterNextBookRecommendation | null;
  selectedRunId: string | null;
  plan: BookPlan | null;
  manuscriptPreview: string;
  planQuality: BookPlanQualityReport | null;
  reviewPack: ReviewPack | null;
  publishDryRun: KdpDryRunReport | null;
  automation: BookWriterAutomationStatus;
  generationModel: BookWriterGenerationModel;
  localAiHealth: BookWriterLocalAiHealth;
  localCoverAiStatus: BookWriterLocalCoverAiStatus;
  nextActions: string[];
};

export type BookBible = {
  runId: string;
  title: string;
  subtitle: string;
  slug: string;
  penName: string;
  genre: string;
  readerPromise: string;
  premise: string;
  cast: Array<{
    name: string;
    role: string;
    notes: string;
  }>;
  originalityStrategy: string[];
  bannedDependencies: string[];
  targetWords: number;
  tone?: string;
  profanityLevel?: BookPlanProfanityLevel;
  createdAt: string;
};

export type OutlineChapter = {
  number: number;
  title: string;
  promise: string;
  beats: string[];
};

export type BookOutline = {
  runId: string;
  chapters: OutlineChapter[];
};

export type GateStatus = "pass" | "fail" | "warn" | "blocked";

export type GateFinding = {
  code: string;
  status: GateStatus;
  message: string;
  score?: number;
};

export type GateReport = {
  status: GateStatus;
  findings: GateFinding[];
};

export type ModelBenchRecord = {
  model: string;
  provider: string;
  source: "estimated" | "measured" | "unavailable";
  peakMemoryGb: number;
  tokensPerSecond: number;
  stableContextTokens: number;
  crashRate: number;
  qualityScore: number;
  measuredAt: string;
  notes: string[];
};

export type EnduranceEstimate = {
  targetWords: number;
  chapterCount: number;
  maxAttemptsPerChapter: number;
  estimatedMinutes: number;
  canFinishByReviewTime: boolean;
  reviewReadyBy: string;
  requiredTokensEstimate: number;
  overheadMinutes: number;
};

export type PublishPreview = {
  channel: "kdp";
  finalSubmitRequiresApproval: true;
  aiDisclosure: string;
  kdpSelectDefault: boolean;
  title: string;
  subtitle: string;
  description: string;
  keywords: string[];
  categories: string[];
  pricing: {
    ebookUsd: number;
    paperbackUsd?: number;
  };
  checklist: string[];
};

export type KdpCoverStrategy = "kdp-cover-creator" | "upload";

export type KdpDryRunStatus = "ready" | "needs-review" | "blocked";

export type KdpBrowserAction = {
  id: string;
  kind: "navigate" | "click" | "fill" | "select" | "upload" | "confirm" | "pause";
  target: string;
  value?: string | number | boolean | string[];
  file?: string;
  note?: string;
  requiresApproval?: boolean;
};

export type KdpUploadManifest = {
  channel: "kdp";
  mode: "browser-assisted-dry-run";
  runId: string;
  preparedAt: string;
  status: KdpDryRunStatus;
  finalSubmitRequiresApproval: true;
  coverStrategy: KdpCoverStrategy;
  files: {
    ebook?: string;
    printPdf?: string;
    coverUpload?: string;
    coverBrief?: string;
    metadata?: string;
    publishPreview?: string;
  };
  metadata?: PublishPreview;
  aiDisclosure?: string;
  kdpSelectDefault?: boolean;
};

export type KdpDryRunReport = {
  runId: string;
  status: KdpDryRunStatus;
  coverStrategy: KdpCoverStrategy;
  findings: GateFinding[];
  uploadManifestPath: string;
  browserActionsPath: string;
  uploadManifest: KdpUploadManifest;
  browserActions: KdpBrowserAction[];
  finalSubmit: {
    allowed: false;
    requiresApproval: true;
    reason: string;
  };
  createdAt: string;
};

export type ReviewPack = {
  runId: string;
  recommendation: ReviewRecommendation;
  artifacts: Record<string, string>;
  gaps: string[];
  reports: {
    quality: GateReport;
    originality: GateReport;
    editorialPolicy: GateReport;
    continuity: GateReport;
    storyQuality: GateReport;
    endurance: GateReport;
    exportValidation: GateReport;
  };
  publishPreview: PublishPreview;
  createdAt: string;
};
