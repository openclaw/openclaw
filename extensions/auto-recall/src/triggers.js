import fs from "node:fs/promises";

/** Built-in English/Russian trigger lists and internal prompt filters. */
export const DEFAULT_TRIGGERS = Object.freeze({
  past_tense_questions: [
    "what",
    "when",
    "where",
    "why",
    "who",
    "which",
    "how",
    "что",
    "когда",
    "где",
    "почему",
    "кто",
    "какой",
    "какая",
    "какое",
    "какие",
    "как",
  ],
  past_tense_verbs: [
    "did",
    "decided",
    "said",
    "discussed",
    "wrote",
    "planned",
    "agreed",
    "built",
    "fixed",
    "closed",
    "bought",
    "sold",
    "was",
    "were",
    "было",
    "были",
    "был",
    "была",
    "делал",
    "делала",
    "делали",
    "решил",
    "решила",
    "решили",
    "обсуждал",
    "обсуждала",
    "обсуждали",
    "писал",
    "писала",
    "писали",
    "говорил",
    "говорила",
    "говорили",
    "планировал",
    "планировали",
    "закрыл",
    "закрыли",
    "купил",
    "продал",
  ],
  memory_keywords: [
    "remember",
    "recall",
    "remind me",
    "do you remember",
    "what did we",
    "what was",
    "помнишь",
    "вспомни",
    "напомни",
    "что мы",
    "что было",
    "как мы",
  ],
  past_references: [
    "last time",
    "earlier",
    "previously",
    "before",
    "we discussed",
    "we decided",
    "our plan",
    "в прошлый раз",
    "раньше",
    "до этого",
    "мы обсуждали",
    "мы решили",
    "наш план",
  ],
  named_entities: [],
  internal_prompt_denylist: [
    "You are a memory search agent",
    "System (untrusted):",
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    "[Subagent Context]",
    "Runtime context (internal)",
  ],
  term_whitelist: [
    "OpenClaw",
    "Mnemostack",
    "Qdrant",
    "Memgraph",
    "Gemini",
    "Hetzner",
    "Selectel",
    "Yandex",
    "Tailscale",
    "SearXNG",
    "API",
    "JSON",
    "CLI",
    "HTTP",
    "PR",
    "CI",
  ],
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringArray(name, value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

/**
 * Normalize a triggers file into arrays of non-empty strings.
 * @param {unknown} raw Raw triggers configuration.
 * @returns {object} Normalized triggers.
 */
export function normalizeTriggers(raw = {}) {
  const merged = { ...DEFAULT_TRIGGERS, ...(raw && typeof raw === "object" ? raw : {}) };
  return Object.freeze({
    past_tense_questions: Object.freeze(
      stringArray("past_tense_questions", merged.past_tense_questions),
    ),
    past_tense_verbs: Object.freeze(stringArray("past_tense_verbs", merged.past_tense_verbs)),
    memory_keywords: Object.freeze(stringArray("memory_keywords", merged.memory_keywords)),
    past_references: Object.freeze(stringArray("past_references", merged.past_references)),
    named_entities: Object.freeze(stringArray("named_entities", merged.named_entities)),
    internal_prompt_denylist: Object.freeze(
      stringArray("internal_prompt_denylist", merged.internal_prompt_denylist),
    ),
    term_whitelist: Object.freeze(stringArray("term_whitelist", merged.term_whitelist || [])),
  });
}

function compileWordRegex(items) {
  if (!items.length) return null;
  return new RegExp(
    `(^|\\P{L})(${items
      .map(escapeRegex)
      .sort((a, b) => b.length - a.length)
      .join("|")})(?=\\P{L}|$)`,
    "iu",
  );
}

function tokenize(text) {
  return (
    String(text || "")
      .toLowerCase()
      .match(/[\p{L}]+/gu) || []
  );
}

/**
 * Compile normalized triggers into runtime regexes and lookup sets.
 * @param {object} raw Normalized triggers.
 * @returns {object} Compiled trigger snapshot.
 */
export function compileTriggers(raw) {
  const cfg = normalizeTriggers(raw);
  const compiled = Object.freeze({
    raw: cfg,
    memoryKeywordRe: compileWordRegex(cfg.memory_keywords),
    pastReferenceRe: compileWordRegex(cfg.past_references),
    namedEntityRe: compileWordRegex(cfg.named_entities),
    whitelistRe: compileWordRegex(cfg.term_whitelist),
    internalPromptPatterns: Object.freeze(
      cfg.internal_prompt_denylist.map((item) => new RegExp(`^${escapeRegex(item)}`, "i")),
    ),
    questionWords: new Set(cfg.past_tense_questions.map((item) => item.toLowerCase())),
    pastVerbs: new Set(cfg.past_tense_verbs.map((item) => item.toLowerCase())),
    counts: Object.freeze(
      Object.fromEntries(Object.entries(cfg).map(([key, value]) => [key, value.length])),
    ),
  });
  return compiled;
}

/**
 * Build the default immutable trigger snapshot.
 * @returns {object} Default trigger snapshot.
 */
export function defaultTriggerSnapshot() {
  const compiled = compileTriggers(DEFAULT_TRIGGERS);
  return Object.freeze({
    ...compiled,
    sourcePath: "defaults",
    version: `defaults-${JSON.stringify(compiled.counts)}`,
    loadedAt: new Date().toISOString(),
  });
}

export async function loadTriggerSnapshot(customPath, previousRaw = null) {
  if (!customPath) return defaultTriggerSnapshot();
  const raw = JSON.parse(await fs.readFile(customPath, "utf8"));
  const compiled = compileTriggers(raw);
  const stat = await fs.stat(customPath);
  return Object.freeze({
    ...compiled,
    sourcePath: customPath,
    version: `${Math.trunc(stat.mtimeMs)}-${JSON.stringify(compiled.counts)}`,
    loadedAt: new Date().toISOString(),
    mtimeMs: stat.mtimeMs,
    delta: diffTriggers(previousRaw, compiled.raw),
  });
}

/**
 * Summarize trigger category size changes.
 * @param {object} oldRaw Previous raw trigger config.
 * @param {object} newRaw Next raw trigger config.
 * @returns {object} Per-category count deltas.
 */
export function diffTriggers(oldRaw, newRaw) {
  if (!oldRaw) return {};
  const added = {};
  const removed = {};
  for (const key of Object.keys(DEFAULT_TRIGGERS)) {
    const oldSet = new Set(oldRaw[key] || []);
    const newSet = new Set(newRaw[key] || []);
    const add = [...newSet].filter((item) => !oldSet.has(item));
    const rem = [...oldSet].filter((item) => !newSet.has(item));
    if (add.length) added[key] = add;
    if (rem.length) removed[key] = rem;
  }
  return {
    ...(Object.keys(added).length ? { added } : {}),
    ...(Object.keys(removed).length ? { removed } : {}),
  };
}

/**
 * Check whether text matches the internal prompt denylist.
 * @param {unknown} text Text to inspect.
 * @param {object} [snapshot=defaultTriggerSnapshot()] Compiled trigger snapshot.
 * @returns {boolean} True when text is internal prompt content.
 */
export function isInternalPrompt(text, snapshot = defaultTriggerSnapshot()) {
  const value = String(text || "").trim();
  return snapshot.internalPromptPatterns.some((pattern) => pattern.test(value));
}

/**
 * Match user text against recall trigger patterns.
 * @param {unknown} text User-visible text.
 * @param {object} [snapshot=defaultTriggerSnapshot()] Compiled trigger snapshot.
 * @returns {{match: boolean, patternId?: string, matchedText?: string, reason?: string}} Trigger decision.
 */
export function getRecallTrigger(text, snapshot = defaultTriggerSnapshot()) {
  const value = String(text || "");
  if (!value.trim()) return { match: false };
  if (isInternalPrompt(value, snapshot)) return { match: false, reason: "internal_prompt" };

  for (const [patternId, re] of [
    ["memory_keyword", snapshot.memoryKeywordRe],
    ["past_reference", snapshot.pastReferenceRe],
    ["named_entity", snapshot.namedEntityRe],
  ]) {
    if (!re) continue;
    const matched = value.match(re);
    if (matched) return { match: true, patternId, matchedText: matched[2] || matched[0] };
  }

  const words = tokenize(value);
  const hasQuestion = words.some((word) => snapshot.questionWords.has(word));
  const hasPastVerb = words.some((word) => snapshot.pastVerbs.has(word));
  if (hasQuestion && hasPastVerb) return { match: true, patternId: "past_tense_question" };

  if (snapshot.whitelistRe?.test(value)) return { match: false, reason: "whitelisted_term" };
  return { match: false };
}

/**
 * Create a hot-reloadable trigger snapshot manager.
 * @param {{customPath?: string, reloadSignal?: string|false, logger?: {info?: Function, warn?: Function}}} [options={}] Trigger manager options.
 * @returns {{getSnapshot: Function, reload: Function, dispose: Function}} Trigger manager.
 */
export function createTriggerManager({ customPath, reloadSignal = "SIGUSR2", logger } = {}) {
  let snapshot = defaultTriggerSnapshot();
  let disposed = false;
  let reloading = Promise.resolve();

  async function reload(reason = "manual") {
    if (!customPath || disposed) return snapshot;
    reloading = reloading.then(async () => {
      try {
        const next = await loadTriggerSnapshot(customPath, snapshot.raw);
        snapshot = next;
        logger?.info?.({
          event: "triggers_reloaded",
          reason,
          sourcePath: next.sourcePath,
          version: next.version,
          delta: next.delta,
        });
      } catch (error) {
        logger?.warn?.({
          event: "triggers_reload_failed",
          reason,
          error: error?.message || String(error),
        });
      }
      return snapshot;
    });
    return reloading;
  }

  const signalName = reloadSignal === false ? undefined : reloadSignal;
  const onSignal = () => {
    void reload(signalName);
  };
  let signalRegistered = false;
  if (customPath && signalName && typeof process?.on === "function") {
    try {
      process.on(signalName, onSignal);
      signalRegistered = true;
    } catch (error) {
      logger?.warn?.({
        event: "triggers_signal_failed",
        signal: signalName,
        error: error?.message || String(error),
      });
    }
  }
  if (customPath) void reload("startup");

  return {
    getSnapshot: () => snapshot,
    reload,
    dispose() {
      disposed = true;
      if (signalRegistered && typeof process?.off === "function") process.off(signalName, onSignal);
    },
  };
}
