import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CandidatesFile, ErrorSeed, EvidenceRef, LessonCandidate, Severity } from "./types.js";
import { agentDataRoot, atomicWriteJson, ensureDir, nowIso, readJson } from "./utils.js";

export const PROMPT_VERSION = "p1.distill.v1";
export const DEFAULT_MIN_CLUSTER_SIZE = 2;

const FINGERPRINT_LEN = 16;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function candidatesFilePath(root?: string): string {
  return path.join(agentDataRoot(root), "shared", "lessons", "candidates.json");
}

/** Pluggable LLM provider used by the distiller. */
export interface DistillLLMProvider {
  complete(prompt: string): Promise<string>;
}

/** Default provider that shells out to the `claude` CLI. */
export class ClaudeCliProvider implements DistillLLMProvider {
  constructor(private readonly bin: string = "claude") {}
  async complete(prompt: string): Promise<string> {
    const proc = spawnSync(this.bin, ["-p", prompt], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8,
    });
    if (proc.status !== 0) {
      throw new Error(
        `claude CLI failed (exit=${proc.status}): ${(proc.stderr ?? "").toString().slice(0, 500)}`,
      );
    }
    return (proc.stdout ?? "").toString();
  }
}

/** OpenClaw-native provider using the agent runtime. */
export class NativeProvider implements DistillLLMProvider {
  constructor(private readonly agentId: string = "builder") {}

  async complete(prompt: string): Promise<string> {
    const { loadConfig } = await import("openclaw/plugin-sdk/config-runtime");
    const {
      prepareSimpleCompletionModelForAgent,
      completeWithPreparedSimpleCompletionModel,
      resolveNonCliModelRef,
      resolveSimpleCompletionSelectionForAgent,
    } = await import("openclaw/plugin-sdk/agent-runtime");

    const cfg = loadConfig();
    let prepared = await prepareSimpleCompletionModelForAgent({
      cfg,
      agentId: this.agentId,
    });
    if ("error" in prepared) {
      // Agent may be configured with a CLI-only model (e.g. claude-cli/opus[1m])
      // which cannot be used for simple completions. Fall back to the non-CLI equivalent.
      const selection = resolveSimpleCompletionSelectionForAgent({ cfg, agentId: this.agentId });
      if (selection) {
        const nonCliRef = resolveNonCliModelRef(
          { provider: selection.provider, model: selection.modelId },
          cfg,
        );
        if (nonCliRef.provider !== selection.provider) {
          const fallback = await prepareSimpleCompletionModelForAgent({
            cfg,
            agentId: this.agentId,
            modelRef: nonCliRef.provider + "/" + nonCliRef.model,
          });
          if (!("error" in fallback)) prepared = fallback;
        }
      }
      if ("error" in prepared) {
        throw new Error("NativeProvider: " + prepared.error);
      }
    }
    const result = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      context: {
        messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
      },
    });
    // Extract text from AssistantMessage.content
    const texts: string[] = [];
    for (const c of result.content) {
      if (c.type === "text") texts.push(c.text);
    }
    return texts.join("\n");
  }
}

/** Test/mocking provider that returns a canned response (or via fn). */
export class MockProvider implements DistillLLMProvider {
  constructor(private readonly responder: string | ((prompt: string) => string)) {}
  async complete(prompt: string): Promise<string> {
    return typeof this.responder === "function" ? this.responder(prompt) : this.responder;
  }
}

/**
 * Cluster seeds by fingerprint within the same agent.
 * Key shape: `<agent>:<fingerprint>`.
 */
export function clusterSeeds(seeds: ErrorSeed[]): Map<string, ErrorSeed[]> {
  const map = new Map<string, ErrorSeed[]>();
  for (const s of seeds) {
    const key = `${s.agent}:${s.fingerprint}`;
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  }
  return map;
}

/** Deterministic distill key from agent + sorted fingerprints + prompt version. */
export function distillKey(agent: string, fingerprints: string[]): string {
  const sorted = Array.from(new Set(fingerprints)).sort();
  return sha256Hex(`${agent}:${sorted.join(",")}:${PROMPT_VERSION}`).slice(0, FINGERPRINT_LEN);
}

/** Build the prompt asking the LLM for a structured lesson candidate. */
export function buildDistillPrompt(cluster: ErrorSeed[], agent: string): string {
  const sample = cluster.slice(0, 5).map((s) => ({
    tool: s.tool,
    errorClass: s.errorClass,
    errorMessage: s.errorMessage,
    domainTags: s.domainTags,
    timestamp: s.timestamp,
  }));
  const tools = Array.from(new Set(cluster.map((s) => s.tool))).sort();
  const errorClasses = Array.from(new Set(cluster.map((s) => s.errorClass))).sort();
  const tags = Array.from(new Set(cluster.flatMap((s) => s.domainTags))).sort();
  return [
    `You are analyzing repeated tool failures observed in the "${agent}" agent.`,
    `There are ${cluster.length} occurrences of the same error fingerprint.`,
    ``,
    `Tools involved: ${tools.join(", ")}`,
    `Error classes: ${errorClasses.join(", ")}`,
    `Domain tags: ${tags.join(", ")}`,
    ``,
    `Recent samples:`,
    JSON.stringify(sample, null, 2),
    ``,
    `Produce a single JSON object (no prose, no markdown fences) with these keys:`,
    `{`,
    `  "title": short headline,`,
    `  "category": one of operations|messaging|filesystem|github|shell|provider|other,`,
    `  "tags": string array,`,
    `  "context": when this happens,`,
    `  "mistake": what the agent did wrong,`,
    `  "lesson": the rule to remember,`,
    `  "fix": concrete remediation steps,`,
    `  "severity": one of critical|high|important|minor,`,
    `  "confidence": number between 0 and 1`,
    `}`,
    ``,
    `Prompt version: ${PROMPT_VERSION}`,
  ].join("\n");
}

const SEVERITIES = new Set<Severity>(["critical", "high", "important", "minor"]);

function coerceSeverity(value: unknown): Severity {
  if (typeof value === "string" && SEVERITIES.has(value as Severity)) return value as Severity;
  return "important";
}

function coerceConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Strip code fences and locate the first JSON object in a model response. */
function extractJsonBlock(text: string): string {
  let s = text.trim();
  // Strip ```json ... ``` fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return s;
  return s.slice(start, end + 1);
}

export interface ParseDistillOptions {
  /** Override the candidate id (deterministic in tests). */
  id?: string;
  /** Override createdAt; defaults to current ISO timestamp. */
  now?: Date;
}

export function parseDistillResponse(
  response: string,
  agent: string,
  cluster: ErrorSeed[],
  opts: ParseDistillOptions = {},
): LessonCandidate {
  const block = extractJsonBlock(response);
  let parsed: Record<string, unknown> = {};
  try {
    const result = JSON.parse(block);
    if (result && typeof result === "object") parsed = result as Record<string, unknown>;
  } catch {
    // Fall through with empty parsed; downstream values will be defaulted.
  }
  const fingerprints = cluster.map((s) => s.fingerprint);
  const key = distillKey(agent, fingerprints);
  const evidenceRefs: EvidenceRef[] = cluster.map((s) => ({
    sessionKey: s.sessionKey,
    agent: s.agent,
    tool: s.tool,
    errorFingerprint: s.fingerprint,
    timestamp: s.timestamp,
  }));
  const createdAt = nowIso(opts.now);
  const id = opts.id ?? `cand-${createdAt.slice(0, 10).replace(/-/g, "")}-${key.slice(0, 8)}`;
  return {
    id,
    distillKey: key,
    agent,
    title: asString(parsed.title, `Repeated failure in ${cluster[0]?.tool ?? "tool"}`),
    category: asString(parsed.category, "operations"),
    tags: asStringArray(parsed.tags),
    context: asString(parsed.context),
    mistake: asString(parsed.mistake),
    lesson: asString(parsed.lesson),
    fix: asString(parsed.fix),
    severity: coerceSeverity(parsed.severity),
    confidence: coerceConfidence(parsed.confidence),
    evidenceRefs,
    status: "pending",
    createdAt,
  };
}

export async function distillCluster(
  cluster: ErrorSeed[],
  agent: string,
  llm: DistillLLMProvider,
  opts: ParseDistillOptions = {},
): Promise<LessonCandidate> {
  const prompt = buildDistillPrompt(cluster, agent);
  const response = await llm.complete(prompt);
  return parseDistillResponse(response, agent, cluster, opts);
}

export interface DistillAllOptions {
  seeds: ErrorSeed[];
  llm: DistillLLMProvider;
  root?: string;
  minClusterSize?: number;
  existing?: CandidatesFile;
  now?: Date;
}

export interface DistillAllResult {
  candidates: LessonCandidate[];
  skipped: number;
}

/** Drive the LLM over every cluster meeting the minimum size, idempotent on distillKey. */
export async function distillAll(opts: DistillAllOptions): Promise<DistillAllResult> {
  const minSize = opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
  const existing = opts.existing ?? readCandidatesFile(opts.root);
  const seenKeys = new Set(existing.candidates.map((c) => c.distillKey));
  const clusters = clusterSeeds(opts.seeds);
  const candidates: LessonCandidate[] = [];
  let skipped = 0;
  let seq = 0;
  const datePrefix = (opts.now ?? new Date()).toISOString().slice(0, 10).replace(/-/g, "");
  // Stable iteration order.
  const sortedKeys = Array.from(clusters.keys()).sort();
  for (const key of sortedKeys) {
    const cluster = clusters.get(key)!;
    if (cluster.length < minSize) {
      skipped++;
      continue;
    }
    const agent = cluster[0].agent;
    const dKey = distillKey(
      agent,
      cluster.map((c) => c.fingerprint),
    );
    if (seenKeys.has(dKey)) {
      skipped++;
      continue;
    }
    seq++;
    const id = `cand-${datePrefix}-${String(seq).padStart(3, "0")}`;
    const candidate = await distillCluster(cluster, agent, opts.llm, { id, now: opts.now });
    candidates.push(candidate);
    seenKeys.add(candidate.distillKey);
  }
  return { candidates, skipped };
}

export function readCandidatesFile(root?: string): CandidatesFile {
  const filePath = candidatesFilePath(root);
  if (!fs.existsSync(filePath)) {
    return {
      version: 1,
      promptVersion: PROMPT_VERSION,
      updatedAt: nowIso(),
      candidates: [],
    };
  }
  try {
    const parsed = readJson<CandidatesFile>(filePath);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.candidates)) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return {
    version: 1,
    promptVersion: PROMPT_VERSION,
    updatedAt: nowIso(),
    candidates: [],
  };
}

export function writeCandidatesFile(file: CandidatesFile, root?: string): string {
  const filePath = candidatesFilePath(root);
  ensureDir(path.dirname(filePath));
  atomicWriteJson(filePath, file);
  return filePath;
}
