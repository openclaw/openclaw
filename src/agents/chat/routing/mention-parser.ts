/**
 * Mention parser for multi-agent chat system.
 * Parses @mentions in messages to determine target agents.
 */

export type MentionType = "explicit" | "pattern" | "broadcast" | "channel";

export type ParsedMention = {
  type: MentionType;
  value: string;
  raw: string;
  startIndex: number;
  endIndex: number;
};

export type MentionParseResult = {
  /** Explicit @agent:id mentions */
  explicitMentions: string[];
  /** @AgentName pattern matches */
  patternMentions: string[];
  /** @all/@channel/@here was detected */
  isBroadcast: boolean;
  /** Message content with mentions stripped */
  strippedMessage: string;
  /** All parsed mentions with positions */
  allMentions: ParsedMention[];
};

// Mention patterns
const PATTERNS = {
  // @agent:id - explicit agent mention by ID
  explicitAgent: /@agent:([a-zA-Z0-9_-]+)/g,

  // @user:id - user mention
  explicitUser: /@user:([a-zA-Z0-9_-]+)/g,

  // @AgentName - agent mention by name (capitalized word)
  patternAgent: /@([A-Z][a-zA-Z0-9_-]*)/g,

  // @all, @channel, @here - broadcast mentions
  broadcast: /@(all|channel|here)\b/gi,
};

/**
 * Parse mentions from message text.
 */
export function parseMentions(text: string): MentionParseResult {
  const allMentions: ParsedMention[] = [];
  const explicitMentions: string[] = [];
  const patternMentions: string[] = [];
  let isBroadcast = false;

  // Parse explicit agent mentions (@agent:id)
  let match: RegExpExecArray | null;
  const explicitPattern = new RegExp(PATTERNS.explicitAgent.source, "g");
  while ((match = explicitPattern.exec(text)) !== null) {
    const id = match[1];
    if (!explicitMentions.includes(id)) {
      explicitMentions.push(id);
    }
    allMentions.push({
      type: "explicit",
      value: id,
      raw: match[0],
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  // Parse broadcast mentions (@all, @channel, @here)
  const broadcastPattern = new RegExp(PATTERNS.broadcast.source, "gi");
  while ((match = broadcastPattern.exec(text)) !== null) {
    isBroadcast = true;
    allMentions.push({
      type: "broadcast",
      value: match[1].toLowerCase(),
      raw: match[0],
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  // Parse pattern mentions (@AgentName) - only if no explicit mentions
  // This avoids matching names like @Agent when @agent:id was meant
  const patternAgentPattern = new RegExp(PATTERNS.patternAgent.source, "g");
  while ((match = patternAgentPattern.exec(text)) !== null) {
    const name = match[1];
    // Skip if this looks like it could be a broadcast or explicit
    if (/^(all|channel|here|agent|user)$/i.test(name)) {
      continue;
    }
    // Skip if overlapping with existing mention
    const startIdx = match.index;
    const endIdx = match.index + match[0].length;
    const overlaps = allMentions.some(
      (m) =>
        (startIdx >= m.startIndex && startIdx < m.endIndex) ||
        (endIdx > m.startIndex && endIdx <= m.endIndex),
    );
    if (overlaps) {
      continue;
    }

    if (!patternMentions.includes(name)) {
      patternMentions.push(name);
    }
    allMentions.push({
      type: "pattern",
      value: name,
      raw: match[0],
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  // Sort mentions by position
  allMentions.sort((a, b) => a.startIndex - b.startIndex);

  // Strip mentions from message
  const strippedMessage = stripMentions(text, allMentions);

  return {
    explicitMentions,
    patternMentions,
    isBroadcast,
    strippedMessage,
    allMentions,
  };
}

/**
 * Strip mentions from text, preserving readability.
 */
function stripMentions(text: string, mentions: ParsedMention[]): string {
  if (mentions.length === 0) {
    return text;
  }

  // Remove mentions in reverse order to preserve indices
  let result = text;
  const sorted = [...mentions].toSorted((a, b) => b.startIndex - a.startIndex);

  for (const mention of sorted) {
    const before = result.slice(0, mention.startIndex);
    const after = result.slice(mention.endIndex);
    result = before + after;
  }

  // Clean up extra whitespace
  return result.replace(/\s+/g, " ").trim();
}

/**
 * Check if a text contains any mentions.
 */
export function hasMentions(text: string): boolean {
  const result = parseMentions(text);
  return (
    result.explicitMentions.length > 0 || result.patternMentions.length > 0 || result.isBroadcast
  );
}

/**
 * Check if a text explicitly mentions a specific agent.
 */
export function mentionsAgent(text: string, agentId: string, agentName?: string): boolean {
  const result = parseMentions(text);

  // Check explicit mention by ID
  if (result.explicitMentions.includes(agentId)) {
    return true;
  }

  // Check pattern mention by name
  if (agentName) {
    const normalizedName = agentName.toLowerCase();
    if (result.patternMentions.some((n) => n.toLowerCase() === normalizedName)) {
      return true;
    }
  }

  return false;
}

/**
 * Format an agent mention for display.
 */
export function formatMention(agentId: string, displayName?: string): string {
  if (displayName) {
    return `@${displayName}`;
  }
  return `@agent:${agentId}`;
}

/**
 * Extract all agent IDs from explicit mentions.
 */
export function extractAgentIds(text: string): string[] {
  const result = parseMentions(text);
  return result.explicitMentions;
}

/**
 * Normalize agent name for matching.
 * Removes special characters and converts to lowercase.
 */
export function normalizeAgentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/**
 * Match pattern mentions to agent names.
 * Returns a map of pattern -> agentId.
 */
export function matchPatternMentions(
  patternMentions: string[],
  agentNames: Map<string, string>, // agentId -> name
): Map<string, string> {
  const matches = new Map<string, string>(); // pattern -> agentId

  for (const pattern of patternMentions) {
    const normalizedPattern = normalizeAgentName(pattern);

    for (const [agentId, name] of agentNames) {
      const normalizedName = normalizeAgentName(name);

      // Exact match
      if (normalizedPattern === normalizedName) {
        matches.set(pattern, agentId);
        break;
      }

      // Prefix match (e.g., @Cod matches Coder)
      if (normalizedName.startsWith(normalizedPattern) && normalizedPattern.length >= 3) {
        matches.set(pattern, agentId);
        break;
      }
    }
  }

  return matches;
}
