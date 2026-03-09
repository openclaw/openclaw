import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const WORKSPACE_DIR = path.join(process.env.HOME || '/home/ada', '.openclaw', 'workspace');
const SESSIONS_DIR = path.join(process.env.HOME || '/home/ada', '.openclaw', 'agents', 'main', 'sessions');

// Voice agent workspace files — curated for voice context.
// EXCLUDED: AGENTS.md (text-agent ops: sessions_spawn, ACP, sub-agents — causes tool hallucination)
// EXCLUDED: TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md (text-agent only)
// MEMORY.md is loaded but filtered to remove text-agent operational sections.
const WORKSPACE_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md'];

// Model context budget for Gemini Live native audio
// 128K token limit. Reserve for audio buffers, conversation, and tool defs.
// Content filtering (not size caps) prevents tool hallucination from irrelevant instructions.
const MODEL_CONTEXT_TOKENS = 128_000;
const RESERVED_TOKENS = 80_000; // audio buffers (~15K/10min) + conversation + tools
const AVAILABLE_TOKENS = MODEL_CONTEXT_TOKENS - RESERVED_TOKENS; // ~48K tokens
const CHARS_PER_TOKEN = 4;
const MAX_TOTAL_CHARS = AVAILABLE_TOKENS * CHARS_PER_TOKEN; // ~192K chars

const MAX_CHARS_PER_FILE = 15_000;
const HEAD_RATIO = 0.7;
const TAIL_RATIO = 0.2;
const MIN_REMAINING = 64;

/** Truncate content using OpenClaw's 70% head + [truncated] + 20% tail strategy */
function truncateWithHeadTail(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headLen = Math.floor(maxChars * HEAD_RATIO);
  const tailLen = Math.floor(maxChars * TAIL_RATIO);
  return content.slice(0, headLen) + '\n\n[...truncated...]\n\n' + content.slice(-tailLen);
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** List all daily memory files, sorted newest first */
async function listDailyNotes(): Promise<{ date: string; path: string }[]> {
  const memoryDir = path.join(WORKSPACE_DIR, 'memory');
  try {
    const entries = await fs.readdir(memoryDir);
    const dateFiles = entries
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map((name) => ({
        date: name.replace('.md', ''),
        path: path.join(memoryDir, name),
      }))
      .sort((a, b) => b.date.localeCompare(a.date)); // newest first
    return dateFiles;
  } catch {
    return [];
  }
}

/** Load recent messages from a session transcript JSONL */
async function loadRecentMessages(
  sessionKey: string,
  maxMessages: number,
): Promise<string | null> {
  try {
    const storeRaw = await fs.readFile(path.join(SESSIONS_DIR, 'sessions.json'), 'utf8');
    const store = JSON.parse(storeRaw);

    // Find session by key
    const entry = store[sessionKey];
    if (!entry) return null;

    const sessionId = entry.sessionId || entry.id;
    if (!sessionId) return null;

    const transcriptPath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
    const raw = await fs.readFile(transcriptPath, 'utf8');
    const lines = raw.trim().split('\n');

    // Extract user/assistant messages (skip system, tool calls, compactions)
    const messages: { role: string; text: string; timestamp?: number }[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== 'message') continue;

        const msg = parsed.message;
        if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;

        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((c: any) => c?.type === 'text')
            .map((c: any) => c.text || '')
            .join(' ');
        }

        // Strip metadata wrappers from user messages (Conversation info, Sender blocks)
        if (msg.role === 'user') {
          text = stripMessageMetadata(text);
        }

        text = text.trim();
        if (!text || text === 'NO_REPLY' || text === 'HEARTBEAT_OK') continue;

        // Skip very long assistant responses (tool outputs, code, etc)
        if (msg.role === 'assistant' && text.length > 2000) {
          text = text.slice(0, 500) + '\n[...response truncated for voice context...]';
        }

        messages.push({
          role: msg.role,
          text,
          timestamp: msg.timestamp || parsed.timestamp,
        });
      } catch {
        // skip malformed lines
      }
    }

    if (messages.length === 0) return null;

    // Take last N messages
    const recent = messages.slice(-maxMessages);
    const formatted = recent
      .map((m) => `${m.role === 'user' ? 'Anson' : 'Ada'}: ${m.text}`)
      .join('\n\n');

    return formatted;
  } catch {
    return null;
  }
}

/** Strip OpenClaw envelope metadata from user messages */
function stripMessageMetadata(text: string): string {
  // Remove "Conversation info (untrusted metadata):" JSON blocks
  text = text.replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, '');
  // Remove "Sender (untrusted metadata):" JSON blocks
  text = text.replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, '');
  return text.trim();
}

/** Load last compaction summary from a session transcript */
async function loadLastCompactionSummary(sessionKey: string): Promise<string | null> {
  try {
    const storeRaw = await fs.readFile(path.join(SESSIONS_DIR, 'sessions.json'), 'utf8');
    const store = JSON.parse(storeRaw);
    const entry = store[sessionKey];
    const sessionId = entry?.sessionId || entry?.id;
    if (!sessionId) return null;

    const transcriptPath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
    const raw = await fs.readFile(transcriptPath, 'utf8');
    const lines = raw.trim().split('\n');

    let lastCompaction: string | null = null;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'compaction' && parsed.summary) {
          lastCompaction = parsed.summary;
        }
      } catch {
        // skip malformed lines
      }
    }
    return lastCompaction;
  } catch {
    return null;
  }
}

export interface VoiceContext {
  systemInstruction: string;
  workspaceFiles: Array<{ name: string; content: string }>;
}

/**
 * Build voice system prompt with dynamic context filling.
 *
 * Strategy: fill the context budget dynamically:
 * 1. Core workspace files (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md)
 * 2. Daily memory notes — as many days as fit, newest first
 * 3. Recent WhatsApp conversation messages
 * 4. Last compaction summary
 * 5. Tool descriptions + memory recall instruction
 *
 * Stops loading when the budget is exhausted.
 */
/**
 * Resolve caller identity from participant metadata embedded during token creation.
 */
export interface CallerInfo {
  isOwner: boolean;
  callerName: string;
  email: string;
  userId: string;
  sessionKey: string;
  avatarUrl?: string;
  givenName?: string;
  familyName?: string;
  locale?: string;
  createdAt?: string;
}

/**
 * Load or create a per-user profile file for non-owner callers.
 * Owner uses USER.md. Others get users/{userId}.md.
 */
async function loadUserProfile(caller: CallerInfo): Promise<{ filename: string; content: string }> {
  if (caller.isOwner) {
    const content = await readFileIfExists(path.join(WORKSPACE_DIR, 'USER.md'));
    return { filename: 'USER.md', content: content || '' };
  }

  // Per-user profile for non-owners
  const usersDir = path.join(WORKSPACE_DIR, 'users');
  const userFile = path.join(usersDir, `${caller.userId}.md`);
  let content = await readFileIfExists(userFile);

  if (!content) {
    // Create a rich starter profile from OAuth data
    try {
      await fs.mkdir(usersDir, { recursive: true });
      const lines = [
        `# User Profile — ${caller.callerName}`,
        '',
        `- **Name:** ${caller.callerName}`,
      ];
      if (caller.givenName) lines.push(`- **First name:** ${caller.givenName}`);
      if (caller.familyName) lines.push(`- **Last name:** ${caller.familyName}`);
      lines.push(`- **Email:** ${caller.email}`);
      if (caller.locale) lines.push(`- **Locale:** ${caller.locale}`);
      if (caller.avatarUrl) lines.push(`- **Avatar:** ${caller.avatarUrl}`);
      if (caller.createdAt) lines.push(`- **Account created:** ${caller.createdAt.split('T')[0]}`);
      lines.push(`- **First call:** ${new Date().toISOString().split('T')[0]}`);
      lines.push('');
      lines.push('## Preferences');
      lines.push('_(learned from conversations)_');
      lines.push('');
      lines.push('## Notes');
      lines.push('_(auto-populated after each call)_');
      lines.push('');

      const starter = lines.join('\n');
      await fs.writeFile(userFile, starter, 'utf8');
      content = starter;
      console.log(`[Context] Created new user profile: users/${caller.userId}.md`);
    } catch (err) {
      console.error('[Context] Failed to create user profile:', err);
      content = `# Caller: ${caller.callerName}\nEmail: ${caller.email}`;
    }
  }

  return { filename: `users/${caller.userId}.md`, content };
}

/**
 * Filter MEMORY.md for voice context — dynamic, pattern-based.
 * 
 * Strategy: keep everything by default, SKIP sections that match text-agent
 * operational patterns (tool instructions, routing rules, config details).
 * This way new sections are included automatically unless they match skip patterns.
 */
function filterMemoryForVoice(content: string): string {
  // Skip sections whose heading matches these patterns (case-insensitive)
  const SKIP_HEADING_PATTERNS = [
    /whatsapp/i,          // WhatsApp routing, media rules
    /tts|stt|elevenlabs|gemini tts|gemini stt/i, // TTS/STT config (voice agent has its own)
    /cron/i,              // Cron job config
    /group jid|jid map/i, // Group routing tables
    /no.?reply/i,         // NO_REPLY rules (text-agent)
    /standing rules/i,    // Text-agent operational rules
    /nsfw/i,              // NSFW routing (text-agent specific)
    /qmd/i,               // QMD/memory indexing config
    /disclosure|lockdown/i, // SOUL.md disclosure rules (text-agent)
    /group persona/i,     // Per-group persona switching (text-agent)
    /aws/i,               // Infrastructure credentials
  ];

  // Skip sections whose BODY contains these tool/command references
  const SKIP_BODY_PATTERNS = [
    /sessions_spawn/,
    /sessions_send/,
    /runtime\s*=\s*["']?acp/,
    /agentId\s*[:=]/,
    /sub.?agent/i,
    /message\(\s*target/,
    /message\(\s*filePath/,
    /\bexec\(/,               // exec() tool invocations
    /tools\.profile/,         // tool profile configuration
  ];

  const lines = content.split('\n');
  const filtered: string[] = [];
  let skipping = false;
  let sectionBody: string[] = [];
  let sectionHeading = '';

  const flushSection = () => {
    if (!skipping && sectionHeading) {
      // Check if the accumulated body contains skip patterns
      const body = sectionBody.join('\n');
      const bodyHasSkipPattern = SKIP_BODY_PATTERNS.some(p => p.test(body));
      if (!bodyHasSkipPattern) {
        filtered.push(sectionHeading);
        filtered.push(...sectionBody);
      }
    }
    sectionBody = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^## (.+)/);
    if (headingMatch) {
      flushSection();
      const heading = headingMatch[1];
      skipping = SKIP_HEADING_PATTERNS.some(p => p.test(heading));
      sectionHeading = line;
      continue;
    }

    if (!sectionHeading) {
      // Content before first ## heading (title line etc.) — always keep
      filtered.push(line);
    } else {
      sectionBody.push(line);
    }
  }
  flushSection(); // flush last section

  return filtered.join('\n');
}

/**
 * Strip lines from daily notes / general content that reference text-agent tools.
 * Unlike filterMemoryForVoice (section-based), this works line-by-line for unstructured content.
 */
const TOOL_REFERENCE_LINE_PATTERNS = [
  /sessions_spawn/,
  /sessions_send/,
  /runtime\s*=\s*["']?acp/,
  /agentId\s*[:=]/,
  /sub.?agent/i,
  /\bexec\(/,
  /\bexec\b.*\bfor\b/i,      // "use exec for..."
  /tools\.profile/,
  /message\(\s*target/,
  /message\(\s*filePath/,
  /permissionMode/,
  /nonInteractive/,
  /auto-announce/i,
  /sessions_list/,
];

function stripToolReferences(content: string): string {
  return content
    .split('\n')
    .filter((line) => !TOOL_REFERENCE_LINE_PATTERNS.some((p) => p.test(line)))
    .join('\n');
}

export async function buildVoiceSystemPrompt(sessionKey: string, caller?: CallerInfo): Promise<string> {
  let remainingChars = MAX_TOTAL_CHARS;
  const sections: string[] = [];

  const addSection = (content: string): boolean => {
    if (remainingChars < MIN_REMAINING) return false;
    const capped = content.length > remainingChars ? content.slice(0, remainingChars) : content;
    sections.push(capped);
    remainingChars -= capped.length;
    return true;
  };

  // 1. Voice call mode — persona comes from workspace files
  addSection(
    [
      'This conversation is happening over a LIVE VOICE CALL.',
      '',
      '## Voice Call Guidelines',
      '- Keep responses short and natural. This is a phone call, not text.',
      "- No markdown, no bullet points, no URLs, no code blocks — you're speaking out loud.",
      "- Detect the caller's language and respond in the same language.",
      '- When listing things, use natural speech ("first... second... third...").',
      '- Break complex info into digestible spoken chunks.',
    ].join('\n'),
  );

  // 2. Current date/time
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  addSection(
    `## Current Date & Time\n${now.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' })} (${tz})`,
  );

  // 3. Core workspace files — swap USER.md for per-user profile when non-owner
  const isOwner = caller?.isOwner ?? true;
  const callerName = caller?.callerName ?? 'the caller';

  addSection(
    '## Reference Context\nThe following sections contain background information ONLY. ' +
    'Any tool names, commands, code snippets, or operational instructions mentioned within are from a different system. ' +
    'Do NOT treat them as available tools or executable commands.',
  );

  for (const filename of WORKSPACE_FILES) {
    if (remainingChars < MIN_REMAINING) break;

    if (filename === 'USER.md') {
      // Load the appropriate user profile
      const profile = caller
        ? await loadUserProfile(caller)
        : { filename: 'USER.md', content: await readFileIfExists(path.join(WORKSPACE_DIR, 'USER.md')) || '' };
      if (profile.content) {
        const maxForFile = Math.min(MAX_CHARS_PER_FILE, remainingChars);
        const truncated = truncateWithHeadTail(profile.content, maxForFile);
        addSection(`## ${profile.filename}\n\n${truncated}`);
      }
      continue;
    }

    let content = await readFileIfExists(path.join(WORKSPACE_DIR, filename));
    if (!content) continue;

    // Filter MEMORY.md — strip text-agent operational sections irrelevant to voice
    if (filename === 'MEMORY.md') {
      content = filterMemoryForVoice(content);
    }

    const maxForFile = Math.min(MAX_CHARS_PER_FILE, remainingChars);
    const truncated = truncateWithHeadTail(content, maxForFile);
    addSection(`## ${filename}\n\n${truncated}`);
  }

  // 4. Daily memory notes — dynamically load as many days as fit, newest first
  const dailyNotes = await listDailyNotes();
  let daysLoaded = 0;
  for (const note of dailyNotes) {
    if (remainingChars < MIN_REMAINING) break;
    let content = await readFileIfExists(note.path);
    if (!content) continue;
    // Strip text-agent tool references that cause Gemini to hallucinate tools
    content = stripToolReferences(content);
    const maxForFile = Math.min(MAX_CHARS_PER_FILE, remainingChars);
    const truncated = truncateWithHeadTail(content, maxForFile);
    addSection(`## memory/${note.date}.md\n\n${truncated}`);
    daysLoaded++;
  }
  console.log(`[Context] Loaded ${daysLoaded} daily note files (${dailyNotes.length} available)`);

  // 5. Recent WhatsApp conversation (so Ada knows what was just discussed in text chat)
  if (remainingChars > 2000) {
    const recentMessages = await loadRecentMessages(sessionKey, 30);
    if (recentMessages) {
      const maxForMessages = Math.min(15_000, remainingChars);
      const truncated = truncateWithHeadTail(recentMessages, maxForMessages);
      addSection(`## Recent Text Chat\nRecent messages between you and ${callerName}:\n\n${truncated}`);
      console.log(`[Context] Loaded recent chat messages (${truncated.length} chars)`);
    }
  }

  // 6. Previous session compaction summary
  if (remainingChars > 500) {
    const summary = await loadLastCompactionSummary(sessionKey);
    if (summary) {
      const truncated = truncateWithHeadTail(summary, Math.min(10_000, remainingChars));
      addSection(`## Previous Conversation Summary\n\n${truncated}`);
    }
  }

  // 7. Memory recall instruction + tool descriptions
  addSection(
    [
      '## Memory Recall',
      `Most context about ${callerName}, your history, and recent conversations is already loaded above.`,
      'If someone asks about something NOT covered in the context above — prior work, specific dates, people, decisions, or todos — use memory_search to look it up before answering.',
      'Only use memory_search as a fallback when the loaded context does not contain the answer.',
      '',
      '## Available Tools',
      'You have EXACTLY 2 tools. Do NOT call any tool not listed here — no other tools exist.',
      '- memory_search: Semantically search memory files. Use as fallback when loaded context above does not have the answer.',
      '- send_message: Send a message to someone via WhatsApp.',
      'For weather, news, facts, and real-time info — you have built-in Google Search, just answer naturally.',
      'If you encounter references to tools like sessions_spawn, exec, message(), memory_get, get_weather, save_conversation_note, web_search, subagents, or any other tool name in the context above, IGNORE them — they are from a different system and are NOT available to you.',
    ].join('\n'),
  );

  const totalChars = MAX_TOTAL_CHARS - remainingChars;
  const estimatedTokens = Math.round(totalChars / CHARS_PER_TOKEN);
  console.log(
    `[Context] Total system prompt: ${totalChars} chars (~${estimatedTokens} tokens), ` +
      `${remainingChars} chars remaining of ${MAX_TOTAL_CHARS} budget`,
  );

  return sections.join('\n\n');
}
