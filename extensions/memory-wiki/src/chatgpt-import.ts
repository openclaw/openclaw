import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import {
  asNullableRecord,
  isRecord,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  getMemoryWikiImportRunStateStore,
  MEMORY_WIKI_IMPORT_RUN_STATE_MAX_ENTRIES,
  resolveMemoryWikiImportRunsDir,
  type ChatGptImportRunRecord,
} from "./import-runs-state.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  parseWikiMarkdown,
  renderWikiMarkdown,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { resolveMemoryWikiTimestamp } from "./time.js";
import { readExistingWikiPage } from "./vault-page-write.js";
import { initializeMemoryWikiVault } from "./vault.js";

const CHATGPT_PREFERENCE_SIGNAL_RE =
  /\b(prefer|prefers|preference|want|wants|need|needs|avoid|avoids|hate|hates|love|loves|default to|should default to|always use|don't want|does not want|likes|dislikes)\b/i;
const HUMAN_START_MARKER = "<!-- openclaw:human:start -->";
const HUMAN_END_MARKER = "<!-- openclaw:human:end -->";
const MAX_ROLLBACK_RECREATE_ATTEMPTS = 32;

const CHATGPT_RISK_RULES: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "relationships",
    pattern:
      /\b(relationship|dating|breakup|jealous|sex|intimacy|partner|apology|trust|boyfriend|girlfriend|husband|wife)\b/i,
  },
  {
    label: "health",
    pattern:
      /\b(supplement|medication|diagnosis|symptom|therapy|depression|anxiety|mri|migraine|injury|pain|cortisol|sleep)\b/i,
  },
  {
    label: "legal_tax",
    pattern:
      /\b(contract|tax|legal|law|lawsuit|visa|immigration|license|insurance|claim|non-residence|residency)\b/i,
  },
  {
    label: "finance",
    pattern:
      /\b(investment|invest|portfolio|dividend|yield|coupon|valuation|mortgage|loan|crypto|covered call|call option|put option)\b/i,
  },
  {
    label: "drugs",
    pattern: /\b(vape|weed|cannabis|nicotine|opioid|ketamine)\b/i,
  },
];

type ChatGptMessage = {
  role: string;
  text: string;
};

type ChatGptRiskAssessment = {
  level: "low" | "medium" | "high";
  reasons: string[];
};

type ChatGptConversationRecord = NonNullable<ReturnType<typeof toConversationRecord>>;

type ChatGptImportOperation = "create" | "update" | "skip";

export type ChatGptImportResult = Awaited<ReturnType<typeof importChatGptConversations>>;

type ChatGptRollbackPreservedPage = {
  path: string;
  recoveryPath: string;
};

export type ChatGptRollbackResult = Awaited<ReturnType<typeof rollbackChatGptImportRun>>;

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

async function loadConversations(exportInputPath: string): Promise<{
  exportPath: string;
  conversationsPath: string;
  conversations: Record<string, unknown>[];
}> {
  const exportPath = path.resolve(exportInputPath);
  const conversationsPath = exportPath.endsWith(".json")
    ? exportPath
    : path.join(exportPath, "conversations.json");
  const raw = await fs.readFile(conversationsPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const conversations = Array.isArray(parsed)
    ? parsed
    : Object.values(asNullableRecord(parsed) ?? {}).find(Array.isArray);
  if (!conversations) {
    throw new Error(`Unrecognized ChatGPT conversations export format: ${conversationsPath}`);
  }
  return { exportPath, conversationsPath, conversations: conversations.filter(isRecord) };
}

function isoFromUnix(raw: unknown): string | undefined {
  if (typeof raw !== "number" && typeof raw !== "string") {
    return undefined;
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return timestampMsToIsoString(numeric * 1000);
}

function cleanMessageText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (
    (trimmed.includes("asset_pointer") ||
      trimmed.includes("image_asset_pointer") ||
      trimmed.includes("dalle") ||
      trimmed.includes("file_service")) &&
    trimmed.length > 40
  ) {
    return "";
  }
  if (
    trimmed.startsWith("{") &&
    trimmed.length > 80 &&
    (trimmed.includes(":") || trimmed.includes("content_type"))
  ) {
    const textMatch = trimmed.match(/["']text["']\s*:\s*(["'])(.+?)\1/s);
    return textMatch?.[2] ? normalizeWhitespace(textMatch[2]) : "";
  }
  return trimmed;
}

function extractMessageText(message: Record<string, unknown>): string {
  const content = asNullableRecord(message.content);
  if (content) {
    const parts = content.parts;
    if (Array.isArray(parts)) {
      return parts
        .map((part) => {
          if (typeof part === "string") {
            return cleanMessageText(part);
          }
          const text = asNullableRecord(part)?.text;
          return typeof text === "string" ? text.trim() : "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
    }
    if (typeof content.text === "string") {
      return cleanMessageText(content.text);
    }
  }
  return typeof message.text === "string" ? cleanMessageText(message.text) : "";
}

function activeBranchMessages(conversation: Record<string, unknown>): ChatGptMessage[] {
  const mapping = asNullableRecord(conversation.mapping);
  if (!mapping) {
    return [];
  }
  let currentNode =
    typeof conversation.current_node === "string" ? conversation.current_node : undefined;
  const seen = new Set<string>();
  const chain: ChatGptMessage[] = [];
  while (currentNode && !seen.has(currentNode)) {
    seen.add(currentNode);
    const node = asNullableRecord(mapping[currentNode]);
    if (!node) {
      break;
    }
    const message = asNullableRecord(node.message);
    if (message) {
      const author = asNullableRecord(message.author);
      const role = typeof author?.role === "string" ? author.role : "unknown";
      const text = extractMessageText(message);
      if (text) {
        chain.push({ role, text });
      }
    }
    currentNode = typeof node.parent === "string" ? node.parent : undefined;
  }
  return chain.toReversed();
}

function inferRisk(title: string, sampleText: string): ChatGptRiskAssessment {
  const blob = `${title}\n${sampleText}`.toLowerCase();
  const reasons = CHATGPT_RISK_RULES.filter((rule) => rule.pattern.test(blob)).map(
    (rule) => rule.label,
  );
  if (reasons.length > 0) {
    return { level: "high", reasons: uniqueStrings(reasons) };
  }
  if (/\b(career|job|salary|interview|offer|resume|cover letter)\b/i.test(blob)) {
    return { level: "medium", reasons: ["work_career"] };
  }
  return { level: "low", reasons: [] };
}

function inferLabels(title: string, sampleText: string): string[] {
  const blob = `${title}\n${sampleText}`.toLowerCase();
  const labels = new Set<string>(["domain/personal"]);
  const addAreaTopic = (area: string, topic = area) => {
    labels.add(`area/${area}`);
    labels.add(`topic/${topic}`);
  };
  if (
    /\b(translate|translation|traduc\w*|traducc\w*|traduç\w*|traducci[oó]n|traduccio|traducció|traduzione)\b/i.test(
      blob,
    )
  ) {
    labels.add("topic/translation");
  }
  const areas: Array<[string, RegExp]> = [
    [
      "language-learning",
      /\b(anki|flashcards?|grammar|conjugat\w*|declension|pronunciation|vocab(?:ular(?:y|io))?|lesson|tutor|teacher|jlpt|kanji|hiragana|katakana|study|learn|practice)\b/i,
    ],
    [
      "travel",
      /\b(hike|trail|hotel|flight|trip|travel|airport|itinerary|booking|airbnb|train|stay)\b/i,
    ],
    [
      "cooking",
      /\b(recipe|cook|cooking|bread|sourdough|pizza|espresso|coffee|mousse|cast iron|meatballs?)\b/i,
    ],
    [
      "gardening",
      /\b(garden|orchard|plant|soil|compost|agroforestry|permaculture|mulch|beds?|irrigation|seeds?)\b/i,
    ],
    ["relationships", /\b(dating|relationship|partner|jealous|breakup|trust)\b/i],
    [
      "finance",
      /\b(investment|invest|portfolio|dividend|yield|coupon|valuation|return|mortgage|loan|kraken|crypto|covered call|call option|put option|option chain|bond|stocks?)\b/i,
    ],
    [
      "legal-tax",
      /\b(contract|mou|tax|impuesto|legal|law|lawsuit|visa|immigration|license|licencia|dispute|claim|insurance|non-residence|residency)\b/i,
    ],
    [
      "health",
      /\b(supplement|medication|diagnos(?:is|e)|symptom|therapy|depress(?:ion|ed)|anxiet(?:y|ies)|mri|migraine|injur(?:y|ies)|pain|cortisol|sleep|dentist|dermatolog(?:ist|y))\b/i,
    ],
    [
      "life-admin",
      /\b(book (an )?appointment|rebook|open (a )?new account|driving test|exam|gestor(?:a)?|itv)\b/i,
    ],
  ];
  for (const [area, pattern] of areas) {
    if (pattern.test(blob)) {
      addAreaTopic(area);
    }
  }
  if (/\b(frc|robot|robotics|wpilib|limelight|chiefdelphi)\b/i.test(blob)) {
    addAreaTopic("work", "robotics");
  } else if (
    /\b(docker|git|python|node|npm|pip|sql|postgres|api|bug|stack trace|permission denied)\b/i.test(
      blob,
    )
  ) {
    addAreaTopic("work", "software");
  } else if (/\b(job|interview|cover letter|resume|cv)\b/i.test(blob)) {
    addAreaTopic("work", "career");
  }
  if (/\b(wifi|wi-fi|starlink|router|mesh|network|orbi|milesight|coverage)\b/i.test(blob)) {
    addAreaTopic("home", "home-infrastructure");
  }
  if (
    /\b(p38|range rover|porsche|bmw|bobcat|excavator|auger|trailer|chainsaw|stihl)\b/i.test(blob)
  ) {
    addAreaTopic("vehicles");
  }
  if (![...labels].some((label) => label.startsWith("area/"))) {
    labels.add("area/other");
  }
  return [...labels];
}

function collectPreferenceSignals(userTexts: string[]): string[] {
  const signals: string[] = [];
  const seen = new Set<string>();
  for (const text of userTexts.slice(0, 25)) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = normalizeWhitespace(rawLine);
      if (!line || !CHATGPT_PREFERENCE_SIGNAL_RE.test(line)) {
        continue;
      }
      const key = line.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      signals.push(line);
      if (signals.length >= 10) {
        return signals;
      }
    }
  }
  return signals;
}

function buildTranscript(messages: ChatGptMessage[]): string {
  if (messages.length === 0) {
    return "_No active-branch transcript could be reconstructed._";
  }
  return messages
    .flatMap((message) => [
      `### ${message.role[0]?.toUpperCase() ?? "U"}${message.role.slice(1)}`,
      "",
      message.text,
      "",
    ])
    .join("\n")
    .trim();
}

function resolveConversationPagePath(record: { conversationId: string; createdAt?: string }): {
  pageId: string;
  pagePath: string;
} {
  const conversationSlug = record.conversationId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const pageId = `source.chatgpt.${conversationSlug || createHash("sha1").update(record.conversationId).digest("hex").slice(0, 12)}`;
  const datePrefix = record.createdAt?.slice(0, 10) ?? "undated";
  return {
    pageId,
    pagePath: path
      .join("sources", `chatgpt-${datePrefix}-${conversationSlug || "export"}.md`)
      .replace(/\\/g, "/"),
  };
}

function toConversationRecord(conversation: Record<string, unknown>, sourcePath: string) {
  const conversationId =
    typeof conversation.conversation_id === "string" ? conversation.conversation_id.trim() : "";
  if (!conversationId) {
    return null;
  }
  const title =
    typeof conversation.title === "string" && conversation.title.trim()
      ? conversation.title.trim()
      : "Untitled conversation";
  const transcript = activeBranchMessages(conversation);
  const userTexts = transcript.filter((entry) => entry.role === "user").map((entry) => entry.text);
  const assistantTexts = transcript.filter((entry) => entry.role === "assistant");
  const sampleText = userTexts.slice(0, 6).join("\n");
  const createdAt = isoFromUnix(conversation.create_time);
  const risk = inferRisk(title, sampleText);
  const labels = inferLabels(title, sampleText);
  const { pageId, pagePath } = resolveConversationPagePath({
    conversationId,
    createdAt,
  });
  return {
    conversationId,
    title,
    createdAt,
    updatedAt: isoFromUnix(conversation.update_time) ?? createdAt,
    sourcePath,
    pageId,
    pagePath,
    labels,
    risk,
    userMessageCount: userTexts.length,
    assistantMessageCount: assistantTexts.length,
    preferenceSignals: risk.level === "low" ? collectPreferenceSignals(userTexts) : [],
    firstUserLine: userTexts[0]?.split(/\r?\n/)[0]?.trim(),
    lastUserLine: userTexts.at(-1)?.split(/\r?\n/)[0]?.trim(),
    transcript,
  };
}

function renderConversationPage(record: ChatGptConversationRecord): string {
  const autoDigestLines =
    record.risk.level === "low"
      ? [
          `- User messages: ${record.userMessageCount}`,
          `- Assistant messages: ${record.assistantMessageCount}`,
          ...(record.firstUserLine ? [`- First user line: ${record.firstUserLine}`] : []),
          ...(record.lastUserLine ? [`- Last user line: ${record.lastUserLine}`] : []),
          ...(record.preferenceSignals.length > 0
            ? ["- Preference signals:", ...record.preferenceSignals.map((line) => `  - ${line}`)]
            : ["- Preference signals: none detected"]),
        ]
      : [
          "- Auto digest withheld from durable-candidate generation until reviewed.",
          `- Risk reasons: ${record.risk.reasons.length > 0 ? record.risk.reasons.join(", ") : "none recorded"}`,
        ];
  return renderWikiMarkdown({
    frontmatter: {
      pageType: "source",
      id: record.pageId,
      title: `ChatGPT Export: ${record.title}`,
      sourceType: "chatgpt-export",
      sourceSystem: "chatgpt",
      sourcePath: record.sourcePath,
      conversationId: record.conversationId,
      riskLevel: record.risk.level,
      riskReasons: record.risk.reasons,
      labels: record.labels,
      status: "draft",
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    },
    body: [
      `# ChatGPT Export: ${record.title}`,
      "",
      "## Source",
      `- Conversation id: \`${record.conversationId}\``,
      `- Export file: \`${record.sourcePath}\``,
      ...(record.createdAt ? [`- Created: ${record.createdAt}`] : []),
      ...(record.updatedAt ? [`- Updated: ${record.updatedAt}`] : []),
      "",
      "## Auto Triage",
      `- Risk level: \`${record.risk.level}\``,
      `- Labels: ${record.labels.join(", ")}`,
      `- Active-branch messages: ${record.transcript.length}`,
      "",
      "## Auto Digest",
      ...autoDigestLines,
      "",
      "## Active Branch Transcript",
      buildTranscript(record.transcript),
      "",
      "## Notes",
      HUMAN_START_MARKER,
      HUMAN_END_MARKER,
      "",
    ].join("\n"),
  });
}

const HUMAN_BLOCK_PATTERN = new RegExp(`${HUMAN_START_MARKER}[\\s\\S]*?${HUMAN_END_MARKER}`);
const RELATED_BLOCK_BODY_PATTERN = new RegExp(
  `${WIKI_RELATED_START_MARKER}\\n?([\\s\\S]*?)\\n?${WIKI_RELATED_END_MARKER}`,
);

function preserveExistingPageBlocks(rendered: string, existing: string): string {
  if (!existing.trim()) {
    return withTrailingNewline(rendered);
  }
  const parsedExisting = parseWikiMarkdown(existing);
  const parsedRendered = parseWikiMarkdown(rendered);
  let nextBody = parsedRendered.body;

  const humanBlock = parsedExisting.body.match(HUMAN_BLOCK_PATTERN)?.[0];
  if (humanBlock) {
    nextBody = nextBody.replace(HUMAN_BLOCK_PATTERN, () => humanBlock);
  }

  const relatedBody = parsedExisting.body.match(RELATED_BLOCK_BODY_PATTERN)?.[1]?.trim();
  if (relatedBody) {
    nextBody = replaceManagedMarkdownBlock({
      original: nextBody,
      heading: "## Related",
      startMarker: WIKI_RELATED_START_MARKER,
      endMarker: WIKI_RELATED_END_MARKER,
      body: relatedBody,
    });
  }

  return withTrailingNewline(
    renderWikiMarkdown({
      frontmatter: parsedRendered.frontmatter,
      body: nextBody,
    }),
  );
}

function buildRunId(exportPath: string, nowIso: string): string {
  const seed = `${exportPath}:${nowIso}:${Math.random()}`;
  return `chatgpt-${createHash("sha1").update(seed).digest("hex").slice(0, 12)}`;
}

function normalizeConversationActions(
  records: ChatGptConversationRecord[],
  operations: Map<string, ChatGptImportOperation>,
) {
  return records.map((record) => ({
    conversationId: record.conversationId,
    title: record.title,
    pagePath: record.pagePath,
    operation: operations.get(record.pagePath) ?? "skip",
    riskLevel: record.risk.level,
    labels: record.labels,
    userMessageCount: record.userMessageCount,
    assistantMessageCount: record.assistantMessageCount,
    preferenceSignals: record.preferenceSignals,
  }));
}

const MACHINE_RELATED_BLOCK_PATTERN = new RegExp(
  `(?:^|\\n\\n)## Related\\n${WIKI_RELATED_START_MARKER}\\n[\\s\\S]*?\\n${WIKI_RELATED_END_MARKER}`,
  "g",
);

function hashChatGptImportContent(content: string): string {
  // The compiler owns the exact separator and Related block, but not any
  // suffix bytes after it. Keep those bytes visible to rollback comparisons.
  const importOwnedContent = content.replace(MACHINE_RELATED_BLOCK_PATTERN, "");
  return createHash("sha256").update(importOwnedContent, "utf8").digest("hex");
}

async function writeTrackedImportPage(params: {
  vaultRoot: string;
  runDir: string;
  relativePath: string;
  existing: string;
  rendered: string;
  record: ChatGptImportRunRecord;
}): Promise<void> {
  const absolutePath = path.join(params.vaultRoot, params.relativePath);
  // Hash the exact import-owned bytes before writing. A later compile must not
  // let a concurrent user save become the recorded rollback baseline.
  const contentHash = hashChatGptImportContent(params.rendered);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  if (!params.existing) {
    await fs.writeFile(absolutePath, params.rendered, "utf8");
    params.record.createdPaths.push({ path: params.relativePath, contentHash });
    return;
  }
  const snapshotHash = createHash("sha1").update(params.relativePath).digest("hex").slice(0, 12);
  const snapshotRelativePath = path.join("snapshots", `${snapshotHash}.md`).replace(/\\/g, "/");
  const snapshotAbsolutePath = path.join(params.runDir, snapshotRelativePath);
  await fs.mkdir(path.dirname(snapshotAbsolutePath), { recursive: true });
  await fs.writeFile(snapshotAbsolutePath, params.existing, "utf8");
  await fs.writeFile(absolutePath, params.rendered, "utf8");
  params.record.updatedPaths.push({
    path: params.relativePath,
    snapshotPath: snapshotRelativePath,
    contentHash,
  });
}

export async function importChatGptConversations(params: {
  config: ResolvedMemoryWikiConfig;
  exportPath: string;
  dryRun?: boolean;
  nowMs?: number;
}) {
  return await withMemoryWikiVaultMutation(params.config.vault.path, async () => {
    await initializeMemoryWikiVault(params.config, { nowMs: params.nowMs });
    const { exportPath, conversationsPath, conversations } = await loadConversations(
      params.exportPath,
    );
    const records = conversations
      .map((conversation) => toConversationRecord(conversation, conversationsPath))
      .filter((entry): entry is ChatGptConversationRecord => entry !== null)
      .toSorted((left, right) => left.pagePath.localeCompare(right.pagePath));

    const operations = new Map<string, ChatGptImportOperation>();
    let runId: string | undefined;
    const nowIso = resolveMemoryWikiTimestamp(params.nowMs);
    const importPlans: Array<{
      relativePath: string;
      existing: string;
      rendered: string;
      operation: ChatGptImportOperation;
    }> = [];

    for (const record of records) {
      const rendered = renderConversationPage(record);
      const absolutePath = path.join(params.config.vault.path, record.pagePath);
      const existing = await readExistingWikiPage(
        () => fs.readFile(absolutePath, "utf8"),
        (error) => asNullableRecord(error)?.code === "ENOENT",
      );
      const stabilized = preserveExistingPageBlocks(rendered, existing);
      const operation: ChatGptImportOperation =
        existing === stabilized ? "skip" : existing ? "update" : "create";
      operations.set(record.pagePath, operation);
      importPlans.push({
        relativePath: record.pagePath,
        existing,
        rendered: stabilized,
        operation,
      });
    }

    const createdCount = importPlans.filter((plan) => plan.operation === "create").length;
    const updatedCount = importPlans.filter((plan) => plan.operation === "update").length;
    const skippedCount = importPlans.length - createdCount - updatedCount;
    const changedCount = createdCount + updatedCount;
    let indexUpdatedFiles: string[] = [];

    if (!params.dryRun && changedCount > 0) {
      const requiredStateRows = 1 + changedCount;
      const existingStateRows = await getMemoryWikiImportRunStateStore().rowCount();
      const projectedStateRows = existingStateRows + requiredStateRows;
      if (projectedStateRows > MEMORY_WIKI_IMPORT_RUN_STATE_MAX_ENTRIES) {
        throw new Error(
          `Memory Wiki ChatGPT import exceeds SQLite import-run entry limit (${projectedStateRows}/${MEMORY_WIKI_IMPORT_RUN_STATE_MAX_ENTRIES})`,
        );
      }

      runId = buildRunId(exportPath, nowIso);
      const importRunDir = path.join(
        resolveMemoryWikiImportRunsDir(params.config.vault.path),
        runId,
      );
      const importRunRecord: ChatGptImportRunRecord = {
        version: 1,
        runId,
        importType: "chatgpt",
        exportPath,
        sourcePath: conversationsPath,
        appliedAt: nowIso,
        conversationCount: records.length,
        createdCount,
        updatedCount,
        skippedCount,
        createdPaths: [],
        updatedPaths: [],
      };

      for (const plan of importPlans) {
        if (plan.operation === "skip") {
          continue;
        }
        await writeTrackedImportPage({
          vaultRoot: params.config.vault.path,
          runDir: importRunDir,
          relativePath: plan.relativePath,
          existing: plan.existing,
          rendered: plan.rendered,
          record: importRunRecord,
        });
      }
      await getMemoryWikiImportRunStateStore().write(params.config.vault.path, importRunRecord);
      const compile = await compileMemoryWikiVault(params.config).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Memory Wiki ChatGPT import run ${importRunRecord.runId} changed source pages, but vault compilation failed: ${message}. After fixing the compile error, run \`openclaw wiki chatgpt rollback ${importRunRecord.runId}\` to restore the imported pages.`,
          { cause: error },
        );
      });
      indexUpdatedFiles = compile.updatedFiles;
      await appendMemoryWikiLog(params.config.vault.path, {
        type: "ingest",
        timestamp: nowIso,
        details: {
          sourceType: "chatgpt-export",
          runId: importRunRecord.runId,
          exportPath,
          sourcePath: conversationsPath,
          conversationCount: records.length,
          createdCount: importRunRecord.createdPaths.length,
          updatedCount: importRunRecord.updatedPaths.length,
          skippedCount,
        },
      });
    }

    return {
      dryRun: Boolean(params.dryRun),
      exportPath,
      sourcePath: conversationsPath,
      conversationCount: records.length,
      createdCount,
      updatedCount,
      skippedCount,
      actions: normalizeConversationActions(records, operations),
      pagePaths: records.map((record) => record.pagePath),
      ...(runId ? { runId } : {}),
      indexUpdatedFiles,
    };
  });
}

type ChatGptImportRunEntry = ChatGptImportRunRecord["createdPaths"][number];
type ChatGptRollbackEntryRef = {
  entry: ChatGptImportRunEntry;
  kind: "created" | "updated";
  index: number;
};
type ChatGptRecoverySlot = {
  ref: ChatGptRollbackEntryRef;
  slotRelativePath: string;
  contentRelativePath: string;
};
type ChatGptRollbackRoot = Awaited<ReturnType<typeof fsRoot>>;

function toVaultRelativePath(vaultRoot: string, absolutePath: string): string {
  return path.relative(vaultRoot, absolutePath).replace(/\\/g, "/");
}

function recoverySlotPrefix(ref: ChatGptRollbackEntryRef): string {
  return `${ref.kind}-${ref.index}-${createHash("sha256").update(ref.entry.path).digest("hex")}-`;
}

function resolveContainedImportPath(root: string, relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative path: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (!isPathInside(resolvedRoot, resolvedPath)) {
    throw new Error(`${label} must stay inside ${resolvedRoot}: ${relativePath}`);
  }
  return resolvedPath;
}

function buildRollbackEntryRefs(record: ChatGptImportRunRecord): ChatGptRollbackEntryRef[] {
  return [
    ...record.createdPaths.map((entry, index) => ({ entry, kind: "created" as const, index })),
    ...record.updatedPaths.map((entry, index) => ({ entry, kind: "updated" as const, index })),
  ];
}

function listPreservedPaths(record: ChatGptImportRunRecord): ChatGptRollbackPreservedPage[] {
  return [...record.createdPaths, ...record.updatedPaths].flatMap((entry) =>
    (entry.recoveryPaths ?? []).map((recoveryPath) => ({
      path: entry.path,
      recoveryPath,
    })),
  );
}

function isFsSafeErrorCode(error: unknown, code: FsSafeError["code"]): boolean {
  return error instanceof FsSafeError && error.code === code;
}

async function reserveRecoverySlot(
  runRoot: ChatGptRollbackRoot,
  ref: ChatGptRollbackEntryRef,
): Promise<{ slotRelativePath: string; contentRelativePath: string }> {
  await runRoot.mkdir("recovered");
  const slotRelativePath = path.posix.join(
    "recovered",
    `${recoverySlotPrefix(ref)}${randomUUID()}`,
  );
  await runRoot.mkdir(slotRelativePath);
  return {
    slotRelativePath,
    contentRelativePath: path.posix.join(slotRelativePath, "content"),
  };
}

async function removeEmptyRecoverySlot(
  runRoot: ChatGptRollbackRoot,
  slotRelativePath: string,
): Promise<void> {
  try {
    if ((await runRoot.list(slotRelativePath)).length > 0) {
      return;
    }
    await runRoot.remove(slotRelativePath);
  } catch (error) {
    if (isFsSafeErrorCode(error, "not-found")) {
      return;
    }
    throw error;
  }
}

async function moveTargetToRecovery(params: {
  vaultRoot: ChatGptRollbackRoot;
  runRoot: ChatGptRollbackRoot;
  runRelativePath: string;
  ref: ChatGptRollbackEntryRef;
}): Promise<ChatGptRecoverySlot | null> {
  resolveContainedImportPath(
    params.vaultRoot.rootDir,
    params.ref.entry.path,
    "Memory Wiki import page path",
  );
  for (;;) {
    const slot = await reserveRecoverySlot(params.runRoot, params.ref);
    const recoveryVaultRelativePath = path.posix.join(
      params.runRelativePath,
      slot.contentRelativePath,
    );
    try {
      await params.vaultRoot.move(params.ref.entry.path, recoveryVaultRelativePath);
      return { ref: params.ref, ...slot };
    } catch (error) {
      await removeEmptyRecoverySlot(params.runRoot, slot.slotRelativePath);
      if (isFsSafeErrorCode(error, "not-found")) {
        return null;
      }
      if (isFsSafeErrorCode(error, "already-exists")) {
        continue;
      }
      throw error;
    }
  }
}

async function scanRecoverySlots(params: {
  runRoot: ChatGptRollbackRoot;
  record: ChatGptImportRunRecord;
}): Promise<ChatGptRecoverySlot[]> {
  const refs = buildRollbackEntryRefs(params.record);
  const refsByPrefix = new Map(refs.map((ref) => [recoverySlotPrefix(ref), ref]));
  let slots: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>;
  try {
    slots = await params.runRoot.list("recovered", { withFileTypes: true });
  } catch (error) {
    if (isFsSafeErrorCode(error, "not-found")) {
      return [];
    }
    throw error;
  }
  const recovered: ChatGptRecoverySlot[] = [];
  for (const slot of slots) {
    if (!slot.isDirectory || slot.isSymbolicLink) {
      continue;
    }
    const prefix = /^(?:created|updated)-\d+-[a-f0-9]{64}-/.exec(slot.name)?.[0];
    const ref = prefix ? refsByPrefix.get(prefix) : undefined;
    if (!ref) {
      continue;
    }
    const slotRelativePath = path.posix.join("recovered", slot.name);
    recovered.push({
      ref,
      slotRelativePath,
      contentRelativePath: path.posix.join(slotRelativePath, "content"),
    });
  }
  return recovered;
}

async function classifyRecoverySlots(params: {
  vaultRoot: string;
  runRoot: ChatGptRollbackRoot;
  slots: ChatGptRecoverySlot[];
}): Promise<boolean> {
  let recordChanged = false;
  for (const slot of params.slots) {
    const { entry } = slot.ref;
    const recoveryPath = toVaultRelativePath(
      params.vaultRoot,
      path.join(params.runRoot.rootDir, slot.contentRelativePath),
    );
    // Once reported, recovery evidence is operator-owned. Retries must not
    // reclassify or remove it even if its contents later change.
    if (entry.recoveryPaths?.includes(recoveryPath)) {
      continue;
    }
    let recoveryHash: string | null = null;
    try {
      const stat = await params.runRoot.stat(slot.contentRelativePath);
      if (stat.isFile && !stat.isSymbolicLink) {
        recoveryHash = hashChatGptImportContent(
          await params.runRoot.readText(slot.contentRelativePath),
        );
      }
    } catch (error) {
      if (isFsSafeErrorCode(error, "not-found")) {
        await removeEmptyRecoverySlot(params.runRoot, slot.slotRelativePath);
        continue;
      }
      throw error;
    }
    if (entry.contentHash && recoveryHash === entry.contentHash) {
      await params.runRoot.remove(slot.contentRelativePath);
      await removeEmptyRecoverySlot(params.runRoot, slot.slotRelativePath);
      continue;
    }
    (entry.recoveryPaths ??= []).push(recoveryPath);
    recordChanged = true;
  }
  return recordChanged;
}

async function targetMatchesSnapshot(
  vaultRoot: ChatGptRollbackRoot,
  targetRelativePath: string,
  snapshot: string,
): Promise<boolean> {
  try {
    const target = await vaultRoot.readText(targetRelativePath);
    return hashChatGptImportContent(target) === hashChatGptImportContent(snapshot);
  } catch (error) {
    if (isFsSafeErrorCode(error, "not-found")) {
      return false;
    }
    throw error;
  }
}

export async function rollbackChatGptImportRun(params: {
  config: ResolvedMemoryWikiConfig;
  runId: string;
}) {
  return await withMemoryWikiVaultMutation(params.config.vault.path, async () => {
    const vaultRoot = params.config.vault.path;
    const record = await getMemoryWikiImportRunStateStore().read(vaultRoot, params.runId);
    if (!record) {
      throw new Error(`Memory Wiki import run not found: ${params.runId}`);
    }
    const refs = buildRollbackEntryRefs(record);
    const pagePaths = refs.map(({ entry }) => entry.path).toSorted((a, b) => a.localeCompare(b));
    if (record.rolledBackAt) {
      return {
        runId: record.runId,
        removedCount: 0,
        restoredCount: 0,
        preservedPaths: listPreservedPaths(record),
        pagePaths,
        indexUpdatedFiles: [],
        alreadyRolledBack: true,
      };
    }
    const importRunsDir = resolveMemoryWikiImportRunsDir(vaultRoot);
    const runDir = resolveContainedImportPath(
      importRunsDir,
      record.runId,
      "Memory Wiki import run id",
    );
    for (const ref of refs) {
      resolveContainedImportPath(vaultRoot, ref.entry.path, "Memory Wiki import page path");
      if (ref.entry.snapshotPath) {
        resolveContainedImportPath(
          runDir,
          ref.entry.snapshotPath,
          "Memory Wiki import snapshot path",
        );
      }
    }
    if (!record.rollbackStartedAt) {
      record.rollbackStartedAt = new Date().toISOString();
      await getMemoryWikiImportRunStateStore().write(vaultRoot, record);
    }
    if (!record.rollbackTargetsFinalizedAt) {
      await initializeMemoryWikiVault(params.config);
      const vaultFs = await fsRoot(vaultRoot);
      const runRelativePath = toVaultRelativePath(vaultRoot, runDir);
      await vaultFs.mkdir(runRelativePath);
      const runFs = await fsRoot(runDir);
      const recoverySlots = await scanRecoverySlots({ runRoot: runFs, record });
      if (await classifyRecoverySlots({ vaultRoot, runRoot: runFs, slots: recoverySlots })) {
        await getMemoryWikiImportRunStateStore().write(vaultRoot, record);
      }
      for (const ref of refs) {
        const { entry } = ref;
        if (ref.kind === "updated" && !entry.snapshotPath) {
          continue;
        }
        const snapshot =
          ref.kind === "updated" && entry.snapshotPath
            ? await runFs.readText(entry.snapshotPath)
            : undefined;
        let completed = false;
        for (let attempt = 0; attempt < MAX_ROLLBACK_RECREATE_ATTEMPTS; attempt += 1) {
          if (
            snapshot !== undefined &&
            (await targetMatchesSnapshot(vaultFs, entry.path, snapshot))
          ) {
            completed = true;
            break;
          }
          const slot = await moveTargetToRecovery({
            vaultRoot: vaultFs,
            runRoot: runFs,
            runRelativePath,
            ref,
          });
          if (slot && (await classifyRecoverySlots({ vaultRoot, runRoot: runFs, slots: [slot] }))) {
            await getMemoryWikiImportRunStateStore().write(vaultRoot, record);
          }
          if (snapshot === undefined) {
            if (slot) {
              continue;
            }
            completed = true;
            break;
          }
          try {
            await vaultFs.create(entry.path, snapshot, { encoding: "utf8", mkdir: true });
            completed = true;
            break;
          } catch (error) {
            if (!isFsSafeErrorCode(error, "already-exists")) {
              throw error;
            }
          }
        }
        if (!completed) {
          throw new Error(
            `Memory Wiki rollback could not ${ref.kind === "created" ? "remove" : "restore"} ${entry.path} after ${MAX_ROLLBACK_RECREATE_ATTEMPTS} concurrent recreations`,
          );
        }
      }
      // The store commits path rows before this meta fence. It does not claim
      // host power-loss ordering beyond process-restart recovery.
      record.rollbackTargetsFinalizedAt = new Date().toISOString();
      await getMemoryWikiImportRunStateStore().write(vaultRoot, record);
    }
    // Finalization rebuilds derived artifacts without rewriting source pages.
    // A normal later compile may refresh machine-managed Related blocks.
    const compile = await compileMemoryWikiVault(params.config, {
      sourcePageWrites: "preserve",
    });
    record.rolledBackAt = new Date().toISOString();
    await getMemoryWikiImportRunStateStore().write(vaultRoot, record);
    const preservedPaths = listPreservedPaths(record);
    const removedCount = record.createdPaths.length;
    const restoredCount = record.updatedPaths.filter((entry) => entry.snapshotPath).length;
    await appendMemoryWikiLog(vaultRoot, {
      type: "ingest",
      timestamp: record.rolledBackAt,
      details: {
        sourceType: "chatgpt-export",
        runId: record.runId,
        rollback: true,
        removedCount,
        restoredCount,
        preservedCount: preservedPaths.length,
      },
    }).catch(() => undefined);
    return {
      runId: record.runId,
      removedCount,
      restoredCount,
      preservedPaths,
      pagePaths,
      indexUpdatedFiles: compile.updatedFiles,
      alreadyRolledBack: false,
    };
  });
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
