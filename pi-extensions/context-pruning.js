//#region src/agents/glob-pattern.ts
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function compileGlobPattern(params) {
  const normalized = params.normalize(params.raw);
  if (!normalized) {
    return {
      kind: "exact",
      value: "",
    };
  }
  if (normalized === "*") {
    return { kind: "all" };
  }
  if (!normalized.includes("*")) {
    return {
      kind: "exact",
      value: normalized,
    };
  }
  return {
    kind: "regex",
    value: new RegExp(`^${escapeRegex(normalized).replaceAll("\\*", ".*")}$`),
  };
}
function compileGlobPatterns(params) {
  if (!Array.isArray(params.raw)) {
    return [];
  }
  return params.raw
    .map((raw) =>
      compileGlobPattern({
        raw,
        normalize: params.normalize,
      }),
    )
    .filter((pattern) => pattern.kind !== "exact" || pattern.value);
}
function matchesAnyGlobPattern(value, patterns) {
  for (const pattern of patterns) {
    if (pattern.kind === "all") {
      return true;
    }
    if (pattern.kind === "exact" && value === pattern.value) {
      return true;
    }
    if (pattern.kind === "regex" && pattern.value.test(value)) {
      return true;
    }
  }
  return false;
}

//#endregion
//#region src/agents/pi-extensions/context-pruning/tools.ts
function normalizeGlob(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}
function makeToolPrunablePredicate(match) {
  const deny = compileGlobPatterns({
    raw: match.deny,
    normalize: normalizeGlob,
  });
  const allow = compileGlobPatterns({
    raw: match.allow,
    normalize: normalizeGlob,
  });
  return (toolName) => {
    const normalized = normalizeGlob(toolName);
    if (matchesAnyGlobPattern(normalized, deny)) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    return matchesAnyGlobPattern(normalized, allow);
  };
}

//#endregion
//#region src/agents/pi-extensions/context-pruning/pruner.ts
const CHARS_PER_TOKEN_ESTIMATE = 4;
const IMAGE_CHAR_ESTIMATE = 8e3;
function asText(text) {
  return {
    type: "text",
    text,
  };
}
function collectTextSegments(content) {
  const parts = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts;
}
function estimateJoinedTextLength(parts) {
  if (parts.length === 0) {
    return 0;
  }
  let len = 0;
  for (const p of parts) {
    len += p.length;
  }
  len += Math.max(0, parts.length - 1);
  return len;
}
function takeHeadFromJoinedText(parts, maxChars) {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  let out = "";
  for (let i = 0; i < parts.length && remaining > 0; i++) {
    if (i > 0) {
      out += "\n";
      remaining -= 1;
      if (remaining <= 0) {
        break;
      }
    }
    const p = parts[i];
    if (p.length <= remaining) {
      out += p;
      remaining -= p.length;
    } else {
      out += p.slice(0, remaining);
      remaining = 0;
    }
  }
  return out;
}
function takeTailFromJoinedText(parts, maxChars) {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  const out = [];
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.length <= remaining) {
      out.push(p);
      remaining -= p.length;
    } else {
      out.push(p.slice(p.length - remaining));
      remaining = 0;
      break;
    }
    if (remaining > 0 && i > 0) {
      out.push("\n");
      remaining -= 1;
    }
  }
  out.reverse();
  return out.join("");
}
function hasImageBlocks(content) {
  for (const block of content) {
    if (block.type === "image") return true;
  }
  return false;
}
function estimateMessageChars(message) {
  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") {
      return content.length;
    }
    let chars = 0;
    for (const b of content) {
      if (b.type === "text") {
        chars += b.text.length;
      }
      if (b.type === "image") {
        chars += IMAGE_CHAR_ESTIMATE;
      }
    }
    return chars;
  }
  if (message.role === "assistant") {
    let chars = 0;
    for (const b of message.content) {
      if (b.type === "text") {
        chars += b.text.length;
      }
      if (b.type === "thinking") {
        chars += b.thinking.length;
      }
      if (b.type === "toolCall") {
        try {
          chars += JSON.stringify(b.arguments ?? {}).length;
        } catch {
          chars += 128;
        }
      }
    }
    return chars;
  }
  if (message.role === "toolResult") {
    let chars = 0;
    for (const b of message.content) {
      if (b.type === "text") {
        chars += b.text.length;
      }
      if (b.type === "image") {
        chars += IMAGE_CHAR_ESTIMATE;
      }
    }
    return chars;
  }
  return 256;
}
function estimateContextChars(messages) {
  return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}
function findAssistantCutoffIndex(messages, keepLastAssistants) {
  if (keepLastAssistants <= 0) {
    return messages.length;
  }
  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") {
      continue;
    }
    remaining--;
    if (remaining === 0) {
      return i;
    }
  }
  return null;
}
function findFirstUserIndex(messages) {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") return i;
  }
  return null;
}
function softTrimToolResultMessage(params) {
  const { msg, settings } = params;
  if (hasImageBlocks(msg.content)) {
    return null;
  }
  const parts = collectTextSegments(msg.content);
  const rawLen = estimateJoinedTextLength(parts);
  if (rawLen <= settings.softTrim.maxChars) {
    return null;
  }
  const headChars = Math.max(0, settings.softTrim.headChars);
  const tailChars = Math.max(0, settings.softTrim.tailChars);
  if (headChars + tailChars >= rawLen) {
    return null;
  }
  const trimmed = `${takeHeadFromJoinedText(parts, headChars)}
...
${takeTailFromJoinedText(parts, tailChars)}`;
  const note = `

[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;
  return {
    ...msg,
    content: [asText(trimmed + note)],
  };
}
function pruneContextMessages(params) {
  const { messages, settings, ctx } = params;
  const contextWindowTokens =
    typeof params.contextWindowTokensOverride === "number" &&
    Number.isFinite(params.contextWindowTokensOverride) &&
    params.contextWindowTokensOverride > 0
      ? params.contextWindowTokensOverride
      : ctx.model?.contextWindow;
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return messages;
  }
  const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (charWindow <= 0) {
    return messages;
  }
  const cutoffIndex = findAssistantCutoffIndex(messages, settings.keepLastAssistants);
  if (cutoffIndex === null) {
    return messages;
  }
  const firstUserIndex = findFirstUserIndex(messages);
  const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;
  const isToolPrunable = params.isToolPrunable ?? makeToolPrunablePredicate(settings.tools);
  let totalChars = estimateContextChars(messages);
  let ratio = totalChars / charWindow;
  if (ratio < settings.softTrimRatio) {
    return messages;
  }
  const prunableToolIndexes = [];
  let next = null;
  for (let i = pruneStartIndex; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    if (!isToolPrunable(msg.toolName)) {
      continue;
    }
    if (hasImageBlocks(msg.content)) {
      continue;
    }
    prunableToolIndexes.push(i);
    const updated = softTrimToolResultMessage({
      msg,
      settings,
    });
    if (!updated) {
      continue;
    }
    const beforeChars = estimateMessageChars(msg);
    const afterChars = estimateMessageChars(updated);
    totalChars += afterChars - beforeChars;
    if (!next) {
      next = messages.slice();
    }
    next[i] = updated;
  }
  const outputAfterSoftTrim = next ?? messages;
  ratio = totalChars / charWindow;
  if (ratio < settings.hardClearRatio) {
    return outputAfterSoftTrim;
  }
  if (!settings.hardClear.enabled) {
    return outputAfterSoftTrim;
  }
  let prunableToolChars = 0;
  for (const i of prunableToolIndexes) {
    const msg = outputAfterSoftTrim[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    prunableToolChars += estimateMessageChars(msg);
  }
  if (prunableToolChars < settings.minPrunableToolChars) {
    return outputAfterSoftTrim;
  }
  for (const i of prunableToolIndexes) {
    if (ratio < settings.hardClearRatio) {
      break;
    }
    const msg = (next ?? messages)[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    const beforeChars = estimateMessageChars(msg);
    const cleared = {
      ...msg,
      content: [asText(settings.hardClear.placeholder)],
    };
    if (!next) {
      next = messages.slice();
    }
    next[i] = cleared;
    const afterChars = estimateMessageChars(cleared);
    totalChars += afterChars - beforeChars;
    ratio = totalChars / charWindow;
  }
  return next ?? messages;
}

//#endregion
//#region src/agents/pi-extensions/context-pruning/runtime.ts
const REGISTRY = /* @__PURE__ */ new WeakMap();
function getContextPruningRuntime(sessionManager) {
  if (!sessionManager || typeof sessionManager !== "object") {
    return null;
  }
  return REGISTRY.get(sessionManager) ?? null;
}

//#endregion
//#region src/agents/pi-extensions/context-pruning/extension.ts
function contextPruningExtension(api) {
  api.on("context", (event, ctx) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return;
    }
    if (runtime.settings.mode === "cache-ttl") {
      const ttlMs = runtime.settings.ttlMs;
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      if (!lastTouch || ttlMs <= 0) {
        return;
      }
      if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) {
        return;
      }
    }
    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? void 0,
    });
    if (next === event.messages) {
      return;
    }
    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
    }
    return { messages: next };
  });
}

//#endregion
//#region src/cli/parse-duration.ts
function parseDurationMs(raw, opts) {
  const trimmed = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!trimmed) {
    throw new Error("invalid duration (empty)");
  }
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(trimmed);
  if (!m) {
    throw new Error(`invalid duration: ${raw}`);
  }
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid duration: ${raw}`);
  }
  const unit = m[2] ?? opts?.defaultUnit ?? "ms";
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1e3 : unit === "m" ? 6e4 : unit === "h" ? 36e5 : 864e5;
  const ms = Math.round(value * multiplier);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid duration: ${raw}`);
  }
  return ms;
}

//#endregion
//#region src/agents/pi-extensions/context-pruning/settings.ts
const DEFAULT_CONTEXT_PRUNING_SETTINGS = {
  mode: "cache-ttl",
  ttlMs: 300 * 1e3,
  keepLastAssistants: 3,
  softTrimRatio: 0.3,
  hardClearRatio: 0.5,
  minPrunableToolChars: 5e4,
  tools: {},
  softTrim: {
    maxChars: 4e3,
    headChars: 1500,
    tailChars: 1500,
  },
  hardClear: {
    enabled: true,
    placeholder: "[Old tool result content cleared]",
  },
};
function computeEffectiveSettings(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const cfg = raw;
  if (cfg.mode !== "cache-ttl") {
    return null;
  }
  const s = structuredClone(DEFAULT_CONTEXT_PRUNING_SETTINGS);
  s.mode = cfg.mode;
  if (typeof cfg.ttl === "string") {
    try {
      s.ttlMs = parseDurationMs(cfg.ttl, { defaultUnit: "m" });
    } catch {}
  }
  if (typeof cfg.keepLastAssistants === "number" && Number.isFinite(cfg.keepLastAssistants)) {
    s.keepLastAssistants = Math.max(0, Math.floor(cfg.keepLastAssistants));
  }
  if (typeof cfg.softTrimRatio === "number" && Number.isFinite(cfg.softTrimRatio)) {
    s.softTrimRatio = Math.min(1, Math.max(0, cfg.softTrimRatio));
  }
  if (typeof cfg.hardClearRatio === "number" && Number.isFinite(cfg.hardClearRatio)) {
    s.hardClearRatio = Math.min(1, Math.max(0, cfg.hardClearRatio));
  }
  if (typeof cfg.minPrunableToolChars === "number" && Number.isFinite(cfg.minPrunableToolChars)) {
    s.minPrunableToolChars = Math.max(0, Math.floor(cfg.minPrunableToolChars));
  }
  if (cfg.tools) {
    s.tools = cfg.tools;
  }
  if (cfg.softTrim) {
    if (typeof cfg.softTrim.maxChars === "number" && Number.isFinite(cfg.softTrim.maxChars)) {
      s.softTrim.maxChars = Math.max(0, Math.floor(cfg.softTrim.maxChars));
    }
    if (typeof cfg.softTrim.headChars === "number" && Number.isFinite(cfg.softTrim.headChars)) {
      s.softTrim.headChars = Math.max(0, Math.floor(cfg.softTrim.headChars));
    }
    if (typeof cfg.softTrim.tailChars === "number" && Number.isFinite(cfg.softTrim.tailChars)) {
      s.softTrim.tailChars = Math.max(0, Math.floor(cfg.softTrim.tailChars));
    }
  }
  if (cfg.hardClear) {
    if (typeof cfg.hardClear.enabled === "boolean") {
      s.hardClear.enabled = cfg.hardClear.enabled;
    }
    if (typeof cfg.hardClear.placeholder === "string" && cfg.hardClear.placeholder.trim()) {
      s.hardClear.placeholder = cfg.hardClear.placeholder.trim();
    }
  }
  return s;
}

//#endregion
export {
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  computeEffectiveSettings,
  contextPruningExtension as default,
  pruneContextMessages,
};
