#!/usr/bin/env node

/**
 * discord-context CLI
 *
 * Commands:
 *   poll [--guild <id>] [--forum <id>] [--workspace <path>]
 *   context [threadId] [--workspace <path>] [--json]
 *   link <threadId> <qmdName> [--workspace <path>]
 */

const fs = require('fs');
const path = require('path');

function printHelp() {
  console.log(`discord-context

Usage:
  discord-context poll [--guild <id>] [--forum <id>] [--workspace <path>]
  discord-context context [threadId] [--workspace <path>] [--json]
  discord-context link <threadId> <qmdName> [--workspace <path>]

Environment:
  DISCORD_TOKEN            Discord bot token (required for poll)
  DISCORD_GUILD_ID         Default guild id for poll
  DISCORD_FORUM_CHANNEL_ID Default forum channel id for poll
  OPENCLAW_WORKSPACE       Workspace root (default: ~/.openclaw/workspace)

Examples:
  discord-context poll --guild 123 --forum 456
  discord-context context
  discord-context context 1472595645192867983
  discord-context link 1472595645192867983 skills
`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith('-')) {
      // Keep short flags minimal for safety; none currently used.
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function resolveWorkspace(flags) {
  if (flags.workspace) return path.resolve(String(flags.workspace));
  if (process.env.OPENCLAW_WORKSPACE) return path.resolve(process.env.OPENCLAW_WORKSPACE);
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.resolve(home, '.openclaw', 'workspace');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function isValidId(v) {
  return /^[0-9]{10,30}$/.test(String(v || ''));
}

function slugifyName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, ' ') // remove emoji/symbols/punctuation
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function getMemoryPaths(workspace) {
  const memoryDir = path.join(workspace, 'memory');
  const cacheDir = path.join(memoryDir, 'discord-cache');
  ensureDir(cacheDir);
  return { memoryDir, cacheDir };
}

function listMemoryMd(memoryDir) {
  if (!fs.existsSync(memoryDir)) return [];
  return fs
    .readdirSync(memoryDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(memoryDir, f));
}

function findContextFile(memoryDir, threadName) {
  const slug = slugifyName(threadName);
  if (slug) {
    const exact = path.join(memoryDir, `${slug}.md`);
    if (fs.existsSync(exact)) return exact;
  }

  const lowered = String(threadName || '').toLowerCase();
  const files = listMemoryMd(memoryDir);

  // filename contains name tokens
  const byFilename = slug ? files.find((f) => path.basename(f).toLowerCase().includes(slug)) : null;

  // content contains thread name
  for (const f of files) {
    try {
      const txt = fs.readFileSync(f, 'utf8').toLowerCase();
      if (lowered && txt.includes(lowered)) return f;
    } catch {
      // skip unreadable file
    }
  }
  return null;
}

async function discordFetchActiveThreads(guildId, token) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/threads/active`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bot ${token}`,
      'User-Agent': 'discord-context-skill/0.3.0',
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Discord API returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Discord API error ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function cmdPoll(flags) {
  const workspace = resolveWorkspace(flags);
  const { memoryDir, cacheDir } = getMemoryPaths(workspace);

  const guildId = String(flags.guild || process.env.DISCORD_GUILD_ID || '');
  const forumId = String(flags.forum || process.env.DISCORD_FORUM_CHANNEL_ID || '');
  const token = process.env.DISCORD_TOKEN || '';

  if (!token) throw new Error('DISCORD_TOKEN is required for poll');
  if (!isValidId(guildId)) throw new Error('Valid guild id required (--guild or DISCORD_GUILD_ID)');
  if (!isValidId(forumId)) throw new Error('Valid forum id required (--forum or DISCORD_FORUM_CHANNEL_ID)');

  const data = await discordFetchActiveThreads(guildId, token);
  const threads = Array.isArray(data.threads) ? data.threads.filter((t) => t.parent_id === forumId) : [];

  let newThreads = 0;
  let updatedThreads = 0;
  const notices = [];

  for (const t of threads) {
    const threadId = String(t.id || '');
    const threadName = String(t.name || '');
    const lastMsg = String(t.last_message_id || '');
    if (!isValidId(threadId)) continue;

    const cacheFile = path.join(cacheDir, `thread-${threadId}.json`);
    const contextFile = path.join(cacheDir, `thread-${threadId}-context.txt`);
    const prev = readJsonSafe(cacheFile) || {};
    const isNew = !fs.existsSync(cacheFile);
    const isUpdated = !isNew && String(prev.last_message_id || '') !== lastMsg && !!lastMsg;

    if (!isNew && !isUpdated) continue;

    const matched = findContextFile(memoryDir, threadName);
    const payload = {
      thread_id: threadId,
      thread_name: threadName,
      last_message_id: lastMsg,
      context_found: Boolean(matched),
      context_file: matched || null,
      auto_discovered: true,
      updated_at: new Date().toISOString(),
    };

    writeJson(cacheFile, payload);

    if (matched) {
      const ctx = fs.readFileSync(matched, 'utf8');
      fs.writeFileSync(contextFile, ctx, 'utf8');
    } else if (fs.existsSync(contextFile)) {
      fs.rmSync(contextFile);
    }

    if (isNew) {
      newThreads++;
      notices.push(`new: ${threadName}${matched ? ` -> ${path.basename(matched)}` : ' (no context file)'}`);
    } else {
      updatedThreads++;
      notices.push(`updated: ${threadName}${matched ? '' : ' (no context file)'}`);
    }
  }

  console.log(`poll complete`);
  console.log(`threads scanned: ${threads.length}`);
  console.log(`new threads: ${newThreads}`);
  console.log(`updated threads: ${updatedThreads}`);
  if (notices.length) {
    console.log('changes:');
    for (const n of notices) console.log(`- ${n}`);
  }
}

function cmdContext(positional, flags) {
  const workspace = resolveWorkspace(flags);
  const { cacheDir } = getMemoryPaths(workspace);
  const threadId = positional[1];

  const files = fs.existsSync(cacheDir)
    ? fs
        .readdirSync(cacheDir)
        .filter((f) => f.startsWith('thread-') && f.endsWith('.json'))
        .sort()
    : [];

  if (!threadId) {
    const rows = files.map((f) => {
      const p = path.join(cacheDir, f);
      const j = readJsonSafe(p) || {};
      return {
        thread_id: String(j.thread_id || f.replace(/^thread-|\.json$/g, '')),
        thread_name: String(j.thread_name || ''),
        context_found: Boolean(j.context_found),
      };
    });

    if (flags.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    if (!rows.length) {
      console.log('No cached threads');
      return;
    }

    console.log('Cached threads:');
    for (const r of rows) {
      console.log(`- ${r.thread_id} (${r.thread_name || 'unknown'})${r.context_found ? '' : ' [no context]'}`);
    }
    return;
  }

  if (!isValidId(threadId)) throw new Error('Invalid thread id');

  const contextPath = path.join(cacheDir, `thread-${threadId}-context.txt`);
  const cachePath = path.join(cacheDir, `thread-${threadId}.json`);

  const meta = readJsonSafe(cachePath);
  if (!meta) {
    console.log(`No cache metadata for thread ${threadId}`);
    return;
  }

  if (flags.json) {
    const out = { ...meta, context: fs.existsSync(contextPath) ? fs.readFileSync(contextPath, 'utf8') : null };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`Thread: ${meta.thread_name || threadId}`);
  console.log(`Context file: ${meta.context_file || 'none'}`);
  if (!fs.existsSync(contextPath)) {
    console.log('No cached context text');
    return;
  }
  console.log('---');
  process.stdout.write(fs.readFileSync(contextPath, 'utf8'));
}

function cmdLink(positional, flags) {
  const workspace = resolveWorkspace(flags);
  const { memoryDir, cacheDir } = getMemoryPaths(workspace);

  const threadId = positional[1];
  const qmdName = positional[2];

  if (!isValidId(threadId)) throw new Error('Valid thread id required');
  if (!qmdName) throw new Error('qmdName required');
  if (!/^[a-zA-Z0-9_-]+$/.test(qmdName)) throw new Error('qmdName must match [a-zA-Z0-9_-]+');

  const qmdPath = path.join(memoryDir, `${qmdName}.md`);
  if (!fs.existsSync(qmdPath)) throw new Error(`QMD not found: ${qmdPath}`);

  const cachePath = path.join(cacheDir, `thread-${threadId}.json`);
  const contextPath = path.join(cacheDir, `thread-${threadId}-context.txt`);

  const prev = readJsonSafe(cachePath) || { thread_id: threadId, thread_name: qmdName };
  const payload = {
    ...prev,
    thread_id: threadId,
    context_found: true,
    context_file: qmdPath,
    manually_linked: true,
    updated_at: new Date().toISOString(),
  };

  writeJson(cachePath, payload);
  fs.copyFileSync(qmdPath, contextPath);

  console.log(`linked ${threadId} -> ${path.basename(qmdPath)}`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (!cmd || cmd === 'help' || flags.help || flags.h) {
    printHelp();
    return;
  }

  if (cmd === 'poll') {
    await cmdPoll(flags);
    return;
  }
  if (cmd === 'context') {
    cmdContext(positional, flags);
    return;
  }
  if (cmd === 'link') {
    cmdLink(positional, flags);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
