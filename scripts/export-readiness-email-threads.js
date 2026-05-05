#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = '/Users/chrisreyes/.openclaw/workspace';
const OUTPUT_DIR = path.join(WORKSPACE_ROOT, 'readiness-email-export');
const TODOIST_BASE_URL = 'https://api.todoist.com/api/v1';
const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MONTHS = 12;
const DEFAULT_MAX_SUBJECTS = 220;
const DEFAULT_REVIEW_LIMIT = 150;
const DEFAULT_CONCURRENCY = 4;

const MICROSOFT_MAILBOXES = [
  {
    mailbox: 'chris@prestigiocustom.com',
    provider: 'microsoft_graph'
  },
  {
    mailbox: 'stitch@prestigiocustom.com',
    provider: 'microsoft_graph'
  }
];

const GMAIL_MAILBOX = {
  mailbox: 'chris91744@gmail.com',
  provider: 'gmail_api'
};

const EVENT_RULES = [
  {
    type: 'drawing_approval',
    keywords: ['drawing', 'approve', 'approved', 'approval', 'sign off', 'signoff']
  },
  {
    type: 'drawing_revision',
    keywords: ['drawing', 'revision', 'revise', 'redline', 'changes', 'markup']
  },
  {
    type: 'fabric_problem',
    keywords: ['fabric', 'short', 'delay', 'delayed', 'damaged', 'wrong', 'issue', 'problem', 'missing']
  },
  {
    type: 'fabric_status',
    keywords: ['fabric', 'received', 'delivered', 'shipment', 'tracking', 'yardage', 'yards', 'arrived']
  },
  {
    type: 'frame_status',
    keywords: ['frame', 'frames', 'framing']
  },
  {
    type: 'client_item_status',
    keywords: ['pickup', 'drop off', 'dropoff', 'received', 'delivered', 'arrival', 'client item']
  },
  {
    type: 'client_spec_answer',
    keywords: ['confirm', 'confirmed', 'proceed', 'decision', 'dimensions', 'dimension', 'size', 'zipper', 'seam', 'seaming', 'fill', 'insert']
  }
];

const READINESS_KEYWORDS = [
  'drawing',
  'approve',
  'approved',
  'approval',
  'revision',
  'revise',
  'fabric',
  'frame',
  'received',
  'delivered',
  'shipment',
  'tracking',
  'seam',
  'seaming',
  'zipper',
  'fill',
  'insert',
  'dimensions',
  'size',
  'client decision',
  'confirm',
  'proceed'
];

main().catch((error) => {
  console.error(`[readiness-export] ${error.message}`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv(path.join(REPO_ROOT, '.env'));
  const range = buildDateRange(args.months);
  const outputDir = args.outputDir || OUTPUT_DIR;

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`[readiness-export] scanning Todoist from ${range.since.toISOString()} to ${range.until.toISOString()}`);

  const todoist = createTodoistClient(env);
  const todoistTasks = await fetchTodoistHistoricalTasks(todoist, range);
  const candidateSubjects = buildSubjectCandidates(todoistTasks, args.maxSubjects);

  console.log(`[readiness-export] extracted ${candidateSubjects.length} candidate subjects`);

  const mailboxClients = [
    ...MICROSOFT_MAILBOXES.map((entry) => ({
      mailbox: entry.mailbox,
      provider: entry.provider,
      client: createMicrosoftClient(env, entry.mailbox)
    })),
    {
      mailbox: GMAIL_MAILBOX.mailbox,
      provider: GMAIL_MAILBOX.provider,
      client: createGmailClient(env)
    }
  ];

  const fetchFailures = [];
  const threadRecords = [];

  await runWithConcurrency(candidateSubjects, args.concurrency, async (candidate) => {
    for (const mailboxClient of mailboxClients) {
      try {
        const thread = mailboxClient.provider === 'microsoft_graph'
          ? await mailboxClient.client.fetchThreadBySubject(candidate.subject)
          : await mailboxClient.client.fetchThreadBySubject(candidate.subject);

        if (!thread || !Array.isArray(thread.messages) || thread.messages.length === 0) {
          continue;
        }

        const record = buildThreadRecord({
          mailbox: mailboxClient.mailbox,
          provider: mailboxClient.provider,
          thread,
          candidate
        });
        threadRecords.push(record);
      } catch (error) {
        fetchFailures.push({
          mailbox: mailboxClient.mailbox,
          subject: candidate.subject,
          error: error.message
        });
      }
    }
  });

  const dedupedThreadRecords = dedupeThreadRecords(threadRecords);

  dedupedThreadRecords.sort((a, b) => {
    return new Date(b.latest_timestamp).getTime() - new Date(a.latest_timestamp).getTime();
  });

  const selectedIds = selectReviewSample(dedupedThreadRecords, args.reviewLimit);
  const summary = buildSummary({
    range,
    todoistTasks,
    candidateSubjects,
    threadRecords: dedupedThreadRecords,
    fetchFailures
  });

  writeJsonl(path.join(outputDir, 'threads.jsonl'), dedupedThreadRecords);
  writeCsv(path.join(outputDir, 'threads_review.csv'), dedupedThreadRecords, selectedIds);
  writeSummary(path.join(outputDir, 'export_summary.md'), summary);

  console.log(`[readiness-export] wrote ${dedupedThreadRecords.length} thread rows to ${outputDir}`);
}

function parseArgs(argv) {
  const args = {
    months: DEFAULT_MONTHS,
    maxSubjects: DEFAULT_MAX_SUBJECTS,
    reviewLimit: DEFAULT_REVIEW_LIMIT,
    concurrency: DEFAULT_CONCURRENCY,
    outputDir: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--months') args.months = Number(argv[++i] || DEFAULT_MONTHS);
    else if (arg === '--max-subjects') args.maxSubjects = Number(argv[++i] || DEFAULT_MAX_SUBJECTS);
    else if (arg === '--review-limit') args.reviewLimit = Number(argv[++i] || DEFAULT_REVIEW_LIMIT);
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i] || DEFAULT_CONCURRENCY);
    else if (arg === '--output-dir') args.outputDir = argv[++i] || null;
  }

  if (!Number.isFinite(args.months) || args.months <= 0) args.months = DEFAULT_MONTHS;
  if (!Number.isFinite(args.maxSubjects) || args.maxSubjects <= 0) args.maxSubjects = DEFAULT_MAX_SUBJECTS;
  if (!Number.isFinite(args.reviewLimit) || args.reviewLimit <= 0) args.reviewLimit = DEFAULT_REVIEW_LIMIT;
  if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) args.concurrency = DEFAULT_CONCURRENCY;

  return args;
}

function loadEnv(filePath) {
  const env = {};
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function buildDateRange(months) {
  const until = new Date();
  const since = new Date(until);
  since.setMonth(since.getMonth() - months);
  return { since, until };
}

function createTodoistClient(env) {
  const token = env.TODOIST_API_KEY;
  if (!token) {
    throw new Error('TODOIST_API_KEY missing from local .env');
  }

  async function get(endpoint) {
    const response = await fetch(`${TODOIST_BASE_URL}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(`Todoist GET ${endpoint}: ${response.status}`);
    }
    return response.json();
  }

  async function getAll(endpoint) {
    let cursor = null;
    const rows = [];
    const separator = endpoint.includes('?') ? '&' : '?';

    do {
      const url = cursor ? `${endpoint}${separator}cursor=${encodeURIComponent(cursor)}` : endpoint;
      const payload = await get(url);
      if (Array.isArray(payload.results)) {
        rows.push(...payload.results);
        cursor = payload.next_cursor || null;
      } else if (Array.isArray(payload.items)) {
        rows.push(...payload.items);
        cursor = payload.next_cursor || null;
      } else if (Array.isArray(payload)) {
        rows.push(...payload);
        cursor = null;
      } else {
        cursor = null;
      }
    } while (cursor);

    return rows;
  }

  async function getCompletedByWindow(sinceIso, untilIso) {
    const rows = [];
    let cursor = null;

    do {
      let endpoint = `/tasks/completed/by_completion_date?since=${encodeURIComponent(sinceIso)}&until=${encodeURIComponent(untilIso)}&limit=200`;
      if (cursor) {
        endpoint += `&cursor=${encodeURIComponent(cursor)}`;
      }
      const payload = await get(endpoint);
      rows.push(...(payload.items || []));
      cursor = payload.next_cursor || null;
    } while (cursor);

    return rows;
  }

  return {
    getAll,
    getCompletedByWindow
  };
}

async function fetchTodoistHistoricalTasks(todoist, range) {
  const [activeTasks, projects, completedTasks] = await Promise.all([
    todoist.getAll('/tasks'),
    todoist.getAll('/projects'),
    fetchCompletedTasks(todoist, range)
  ]);

  const projectNameById = {};
  for (const project of projects) {
    projectNameById[String(project.id)] = project.name;
  }

  const active = activeTasks
    .filter((task) => new Date(task.created_at).getTime() >= range.since.getTime())
    .map((task) => ({
      id: String(task.id),
      status: 'active',
      content: task.content || '',
      description: task.description || '',
      created_at: task.created_at || null,
      completed_at: null,
      project_id: String(task.project_id || ''),
      project_name: projectNameById[String(task.project_id || '')] || 'Unknown'
    }));

  const completed = completedTasks.map((task) => ({
    id: String(task.id),
    status: 'completed',
    content: task.content || '',
    description: task.description || '',
    created_at: task.added_at || null,
    completed_at: task.completed_at || null,
    project_id: String(task.project_id || ''),
    project_name: projectNameById[String(task.project_id || '')] || 'Unknown'
  }));

  return [...active, ...completed];
}

async function fetchCompletedTasks(todoist, range) {
  const windows = [];
  let cursor = new Date(range.since);

  while (cursor < range.until) {
    const end = new Date(Math.min(cursor.getTime() + (89 * DAY_MS), range.until.getTime()));
    windows.push({
      since: new Date(cursor),
      until: new Date(end)
    });
    cursor = new Date(end.getTime() + DAY_MS);
  }

  const rows = [];
  for (const window of windows) {
    const batch = await todoist.getCompletedByWindow(window.since.toISOString(), window.until.toISOString());
    rows.push(...batch);
  }
  return rows;
}

function buildSubjectCandidates(tasks, maxSubjects) {
  const bySubject = new Map();

  for (const task of tasks) {
    const subject = extractSubjectFromTask(task.description);
    if (!subject) continue;

    const normalized = normalizeSubject(subject);
    if (!normalized) continue;

    const keywordMatches = findReadinessKeywords(`${subject}\n${task.content}\n${task.description}`);
    const score = keywordMatches.length * 2 + (task.status === 'active' ? 1 : 0);

    const existing = bySubject.get(normalized);
    const taskRef = {
      id: task.id,
      status: task.status,
      content: task.content,
      project_name: task.project_name,
      created_at: task.created_at,
      completed_at: task.completed_at
    };

    if (!existing) {
      bySubject.set(normalized, {
        subject,
        normalized_subject: normalized,
        readiness_keywords_matched: keywordMatches,
        score,
        latest_task_at: task.completed_at || task.created_at || null,
        todoist_task_refs: [taskRef]
      });
      continue;
    }

    existing.score = Math.max(existing.score, score);
    existing.readiness_keywords_matched = uniq(existing.readiness_keywords_matched.concat(keywordMatches));
    existing.todoist_task_refs.push(taskRef);
    const taskTimestamp = new Date(task.completed_at || task.created_at || 0).getTime();
    const existingTimestamp = new Date(existing.latest_task_at || 0).getTime();
    if (taskTimestamp > existingTimestamp) {
      existing.latest_task_at = task.completed_at || task.created_at || null;
      existing.subject = subject;
    }
  }

  const candidates = [...bySubject.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.latest_task_at || 0).getTime() - new Date(a.latest_task_at || 0).getTime();
    });

  const withKeywords = candidates.filter((candidate) => candidate.readiness_keywords_matched.length > 0);
  const withoutKeywords = candidates.filter((candidate) => candidate.readiness_keywords_matched.length === 0);
  const selected = withKeywords.concat(withoutKeywords).slice(0, maxSubjects);

  return selected;
}

function extractSubjectFromTask(description) {
  if (!description) return null;
  const match = description.match(/^Subject:\s*(.+)$/im);
  if (!match) return null;
  const subject = match[1].trim();
  return subject || null;
}

function baseSubject(subject) {
  return String(subject || '')
    .replace(/^(re|fw|fwd):\s*/i, '')
    .trim();
}

function normalizeSubject(subject) {
  return baseSubject(subject)
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findReadinessKeywords(text) {
  const haystack = String(text || '').toLowerCase();
  return READINESS_KEYWORDS.filter((keyword) => haystack.includes(keyword));
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function createMicrosoftClient(env, mailbox) {
  const tenantId = env.MS_TENANT_ID;
  const clientId = env.MS_CLIENT_ID;
  const clientSecret = env.MS_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(`Missing Microsoft Graph credentials for ${mailbox}`);
  }

  let tokenCache = { token: null, expiresAt: 0 };

  async function getAccessToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt - 300000) {
      return tokenCache.token;
    }

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    });

    const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!response.ok) {
      throw new Error(`Graph token failed for ${mailbox}: ${response.status}`);
    }

    const data = await response.json();
    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in * 1000)
    };
    return tokenCache.token;
  }

  async function graphGet(endpoint) {
    const token = await getAccessToken();
    const response = await fetch(`${GRAPH_BASE_URL}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Graph ${mailbox}: ${response.status}`);
    }

    return response.json();
  }

  async function fetchThreadBySubject(subject) {
    const searchSubject = buildMicrosoftSearchSubject(subject);
    if (!searchSubject) return null;

    const data = await graphGet(
      `/users/${mailbox}/messages` +
      `?$search="${encodeURIComponent(searchSubject)}"` +
      '&$top=50' +
      '&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,hasAttachments'
    );

    const rows = data.value || [];
    if (rows.length === 0) return null;

    const grouped = new Map();
    for (const row of rows) {
      const conversationId = row.conversationId || row.id;
      if (!grouped.has(conversationId)) grouped.set(conversationId, []);
      grouped.get(conversationId).push(row);
    }

    const normalizedTarget = normalizeSubject(subject);
    const bestConversation = [...grouped.entries()]
      .map(([conversationId, messages]) => ({
        conversationId,
        messages,
        score: scoreThreadSubjectMatch(
          normalizedTarget,
          messages.map((message) => message.subject)
        )
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.messages.length !== a.messages.length) return b.messages.length - a.messages.length;
        return new Date(getLatestGraphDate(b.messages)).getTime() - new Date(getLatestGraphDate(a.messages)).getTime();
      })[0];

    const messages = bestConversation.messages
      .slice()
      .sort((a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime))
      .map((message) => ({
        id: message.id,
        subject: message.subject || '',
        from: formatGraphAddress(message.from),
        to: (message.toRecipients || []).map((recipient) => formatGraphEmail(recipient.emailAddress)),
        cc: (message.ccRecipients || []).map((recipient) => formatGraphEmail(recipient.emailAddress)),
        date: message.receivedDateTime,
        body: cleanEmailBody(message.body ? message.body.content : '', message.body ? message.body.contentType : 'html'),
        preview: message.bodyPreview || '',
        hasAttachments: Boolean(message.hasAttachments)
      }));

    return {
      thread_id: bestConversation.conversationId,
      subject: subject,
      fetched_subject: searchSubject,
      messages
    };
  }

  return { fetchThreadBySubject };
}

function buildMicrosoftSearchSubject(subject) {
  return baseSubject(subject)
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');
}

function getLatestGraphDate(messages) {
  return messages.reduce((latest, message) => {
    return new Date(message.receivedDateTime).getTime() > new Date(latest).getTime()
      ? message.receivedDateTime
      : latest;
  }, messages[0].receivedDateTime);
}

function formatGraphEmail(emailAddress) {
  if (!emailAddress) return '';
  if (emailAddress.name) return `${emailAddress.name} <${emailAddress.address}>`;
  return emailAddress.address || '';
}

function formatGraphAddress(from) {
  if (!from || !from.emailAddress) return '';
  return formatGraphEmail(from.emailAddress);
}

function createGmailClient(env) {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const tokenFile = path.join(WORKSPACE_ROOT, 'mail-gmail', '.gmail-token.json');
  if (!clientId || !clientSecret) {
    throw new Error('Missing Gmail OAuth credentials');
  }
  if (!fs.existsSync(tokenFile)) {
    throw new Error('Missing local Gmail refresh token file');
  }

  const tokenData = {
    accessToken: null,
    refreshToken: JSON.parse(fs.readFileSync(tokenFile, 'utf8')).refreshToken,
    expiresAt: 0
  };

  async function getAccessToken() {
    if (tokenData.accessToken && Date.now() < tokenData.expiresAt - 300000) {
      return tokenData.accessToken;
    }

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokenData.refreshToken,
      grant_type: 'refresh_token'
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!response.ok) {
      throw new Error(`Gmail token refresh failed: ${response.status}`);
    }

    const data = await response.json();
    tokenData.accessToken = data.access_token;
    tokenData.expiresAt = Date.now() + (data.expires_in * 1000);
    return tokenData.accessToken;
  }

  async function gmailGet(endpoint) {
    const token = await getAccessToken();
    const response = await fetch(`${GMAIL_BASE_URL}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Gmail API: ${response.status}`);
    }

    return response.json();
  }

  async function fetchThreadBySubject(subject) {
    const searchSubject = buildGmailSearchSubject(subject);
    if (!searchSubject) return null;

    const list = await gmailGet(`/messages?maxResults=10&q=${encodeURIComponent(`in:anywhere subject:"${searchSubject}"`)}`);
    const messages = list.messages || [];
    if (messages.length === 0) return null;

    const threadIds = uniq(messages.map((message) => message.threadId).filter(Boolean)).slice(0, 5);
    const threads = [];

    for (const threadId of threadIds) {
      const thread = await gmailGet(`/threads/${threadId}?format=full`);
      const mappedMessages = (thread.messages || [])
        .map((message) => mapGmailMessage(message))
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      threads.push({
        thread_id: thread.id,
        subject,
        messages: mappedMessages,
        score: scoreThreadSubjectMatch(normalizeSubject(subject), mappedMessages.map((message) => message.subject))
      });
    }

    threads.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.messages.length !== a.messages.length) return b.messages.length - a.messages.length;
      return new Date(b.messages[b.messages.length - 1].date).getTime() - new Date(a.messages[a.messages.length - 1].date).getTime();
    });

    return threads[0] || null;
  }

  return { fetchThreadBySubject };
}

function buildGmailSearchSubject(subject) {
  return baseSubject(subject)
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 8)
    .join(' ');
}

function mapGmailMessage(message) {
  const headers = message.payload ? message.payload.headers || [] : [];
  const body = extractGmailBody(message.payload);
  return {
    id: message.id,
    subject: getHeader(headers, 'Subject'),
    from: getHeader(headers, 'From'),
    to: splitHeaderAddresses(getHeader(headers, 'To')),
    cc: splitHeaderAddresses(getHeader(headers, 'Cc')),
    date: getHeader(headers, 'Date') || new Date(Number(message.internalDate || 0)).toISOString(),
    body: cleanEmailBody(body.content, body.contentType),
    preview: message.snippet || '',
    hasAttachments: hasGmailAttachments(message.payload)
  };
}

function getHeader(headers, name) {
  const header = headers.find((entry) => String(entry.name || '').toLowerCase() === name.toLowerCase());
  return header ? header.value : '';
}

function splitHeaderAddresses(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hasGmailAttachments(payload) {
  if (!payload) return false;
  if (Array.isArray(payload.parts)) {
    return payload.parts.some((part) => (part.filename || '').length > 0 || hasGmailAttachments(part));
  }
  return false;
}

function extractGmailBody(payload) {
  if (!payload) return { content: '', contentType: 'text/plain' };

  if (payload.body && payload.body.data) {
    return {
      content: Buffer.from(payload.body.data, 'base64url').toString('utf8'),
      contentType: payload.mimeType || 'text/plain'
    };
  }

  if (!Array.isArray(payload.parts)) {
    return { content: '', contentType: payload.mimeType || 'text/plain' };
  }

  const preferred = findPreferredGmailPart(payload.parts);
  if (!preferred) return { content: '', contentType: payload.mimeType || 'text/plain' };

  return {
    content: Buffer.from(preferred.body.data || '', 'base64url').toString('utf8'),
    contentType: preferred.mimeType || 'text/plain'
  };
}

function findPreferredGmailPart(parts) {
  for (const mimeType of ['text/plain', 'text/html']) {
    const direct = parts.find((part) => part.mimeType === mimeType && part.body && part.body.data);
    if (direct) return direct;
  }

  for (const part of parts) {
    if (Array.isArray(part.parts)) {
      const nested = findPreferredGmailPart(part.parts);
      if (nested) return nested;
    }
  }

  return null;
}

function cleanEmailBody(content, contentType) {
  let value = String(content || '');

  if (!value) return '';

  if (String(contentType || '').toLowerCase().includes('html')) {
    value = value
      .replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, ' ')
      .replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*?<\/div>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  value = value
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('>'))
    .join('\n');

  const markers = [
    /^\s*On .+ wrote:\s*$/im,
    /^\s*From:\s.+$/im,
    /^\s*Sent:\s.+$/im,
    /^\s*Subject:\s.+$/im,
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im
  ];

  for (const marker of markers) {
    const match = value.match(marker);
    if (match && typeof match.index === 'number') {
      value = value.slice(0, match.index);
    }
  }

  return value.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
}

function scoreThreadSubjectMatch(normalizedTarget, subjects) {
  const normalizedSubjects = subjects.map((subject) => normalizeSubject(subject));
  let score = 0;
  for (const subject of normalizedSubjects) {
    if (subject === normalizedTarget) score += 3;
    else if (subject.includes(normalizedTarget) || normalizedTarget.includes(subject)) score += 1;
  }
  return score;
}

function buildThreadRecord({ mailbox, provider, thread, candidate }) {
  const participants = uniq(
    thread.messages.flatMap((message) => [message.from, ...(message.to || []), ...(message.cc || [])]).filter(Boolean)
  );
  const latestMessage = thread.messages[thread.messages.length - 1];
  const combinedText = [
    candidate.subject,
    ...thread.messages.slice(-3).map((message) => `${message.subject}\n${message.body}\n${message.preview}`)
  ].join('\n');
  const readinessKeywordsMatched = uniq(candidate.readiness_keywords_matched.concat(findReadinessKeywords(combinedText)));
  const eventType = guessEventType(combinedText, readinessKeywordsMatched);
  const cleanLatestText = pickLatestMeaningfulText(thread.messages);
  const cleanThreadExcerpt = buildThreadExcerpt(thread.messages);
  const confidence = scoreConfidence({
    readinessKeywordsMatched,
    eventType,
    messageCount: thread.messages.length,
    latestText: cleanLatestText,
    subjectMatched: scoreThreadSubjectMatch(candidate.normalized_subject, thread.messages.map((message) => message.subject)) > 0
  });

  return {
    mailbox,
    subject: latestMessage.subject || candidate.subject,
    normalized_subject: candidate.normalized_subject,
    thread_id: thread.thread_id,
    latest_timestamp: latestMessage.date,
    participants,
    todoist_task_refs: candidate.todoist_task_refs,
    clean_latest_text: cleanLatestText,
    clean_thread_excerpt: cleanThreadExcerpt,
    candidate_event_type_guess: eventType,
    readiness_keywords_matched: readinessKeywordsMatched,
    confidence,
    source_provider: provider
  };
}

function pickLatestMeaningfulText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i].body || messages[i].preview || '';
    if (candidate && candidate.trim()) {
      return truncate(candidate.trim(), 1400);
    }
  }
  return '';
}

function buildThreadExcerpt(messages) {
  const pieces = [];
  for (let i = messages.length - 1; i >= 0 && pieces.length < 3; i -= 1) {
    const text = messages[i].body || messages[i].preview || '';
    if (text && text.trim()) {
      pieces.push(text.trim());
    }
  }
  return truncate(pieces.join(' || '), 2000);
}

function truncate(value, length) {
  const text = String(value || '');
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1)}…`;
}

function guessEventType(text, matchedKeywords) {
  const haystack = String(text || '').toLowerCase();

  for (const rule of EVENT_RULES) {
    const hits = rule.keywords.filter((keyword) => haystack.includes(keyword));
    if (hits.length >= 2) return rule.type;
    if (hits.length === 1 && matchedKeywords.length >= 3) return rule.type;
  }

  if (matchedKeywords.length === 0) return 'not_readiness_relevant';
  return 'unclear';
}

function scoreConfidence({ readinessKeywordsMatched, eventType, messageCount, latestText, subjectMatched }) {
  let score = 0.2;
  score += Math.min(0.4, readinessKeywordsMatched.length * 0.08);
  score += Math.min(0.15, Math.max(0, messageCount - 1) * 0.03);
  if (latestText && latestText.length > 80) score += 0.1;
  if (subjectMatched) score += 0.1;
  if (eventType !== 'unclear' && eventType !== 'not_readiness_relevant') score += 0.1;
  return Number(Math.min(0.99, score).toFixed(2));
}

function dedupeThreadRecords(records) {
  const merged = new Map();

  for (const record of records) {
    const key = makeRecordKey(record);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...record,
        todoist_task_refs: dedupeTaskRefs(record.todoist_task_refs || []),
        readiness_keywords_matched: uniq(record.readiness_keywords_matched || [])
      });
      continue;
    }

    existing.todoist_task_refs = dedupeTaskRefs(existing.todoist_task_refs.concat(record.todoist_task_refs || []));
    existing.readiness_keywords_matched = uniq(
      existing.readiness_keywords_matched.concat(record.readiness_keywords_matched || [])
    );

    if (new Date(record.latest_timestamp).getTime() > new Date(existing.latest_timestamp).getTime()) {
      existing.subject = record.subject;
      existing.latest_timestamp = record.latest_timestamp;
      existing.clean_latest_text = record.clean_latest_text;
      existing.clean_thread_excerpt = record.clean_thread_excerpt;
      existing.participants = record.participants;
    }

    if (record.confidence > existing.confidence) {
      existing.candidate_event_type_guess = record.candidate_event_type_guess;
      existing.confidence = record.confidence;
    }
  }

  return [...merged.values()];
}

function dedupeTaskRefs(taskRefs) {
  const seen = new Map();
  for (const taskRef of taskRefs) {
    if (!taskRef || !taskRef.id) continue;
    seen.set(String(taskRef.id), taskRef);
  }
  return [...seen.values()];
}

function selectReviewSample(records, limit) {
  const grouped = new Map();
  for (const record of records) {
    if (!grouped.has(record.candidate_event_type_guess)) {
      grouped.set(record.candidate_event_type_guess, []);
    }
    grouped.get(record.candidate_event_type_guess).push(record);
  }

  for (const group of grouped.values()) {
    group.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return new Date(b.latest_timestamp).getTime() - new Date(a.latest_timestamp).getTime();
    });
  }

  const selected = new Set();
  const groups = [...grouped.entries()].filter(([, rows]) => rows.length > 0);
  const baseQuota = groups.length > 0 ? Math.max(5, Math.floor(limit / groups.length)) : 0;

  for (const [, rows] of groups) {
    for (const row of rows.slice(0, baseQuota)) {
      if (selected.size >= limit) break;
      selected.add(makeRecordKey(row));
    }
  }

  if (selected.size < limit) {
    const remaining = records
      .slice()
      .sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return new Date(b.latest_timestamp).getTime() - new Date(a.latest_timestamp).getTime();
      });

    for (const row of remaining) {
      if (selected.size >= limit) break;
      selected.add(makeRecordKey(row));
    }
  }

  return selected;
}

function makeRecordKey(record) {
  return `${record.mailbox}::${record.thread_id}`;
}

function buildSummary({ range, todoistTasks, candidateSubjects, threadRecords, fetchFailures }) {
  const countsByType = {};
  for (const record of threadRecords) {
    countsByType[record.candidate_event_type_guess] = (countsByType[record.candidate_event_type_guess] || 0) + 1;
  }

  const failuresByMailbox = {};
  for (const failure of fetchFailures) {
    failuresByMailbox[failure.mailbox] = (failuresByMailbox[failure.mailbox] || 0) + 1;
  }

  return {
    since: range.since.toISOString(),
    until: range.until.toISOString(),
    todoistTaskCount: todoistTasks.length,
    subjectCount: candidateSubjects.length,
    fetchedThreadCount: threadRecords.length,
    countsByType,
    failuresByMailbox,
    fetchFailures
  };
}

function writeJsonl(filePath, records) {
  const lines = records.map((record) => JSON.stringify(record));
  fs.writeFileSync(filePath, `${lines.join('\n')}${lines.length ? '\n' : ''}`);
}

function writeCsv(filePath, records, selectedIds) {
  const header = [
    'selected',
    'mailbox',
    'subject',
    'latest_timestamp',
    'candidate_event_type_guess',
    'confidence',
    'readiness_keywords_matched',
    'short_excerpt'
  ];

  const lines = [header.join(',')];
  for (const record of records) {
    const row = [
      selectedIds.has(makeRecordKey(record)) ? 'yes' : '',
      record.mailbox,
      record.subject,
      record.latest_timestamp,
      record.candidate_event_type_guess,
      String(record.confidence),
      record.readiness_keywords_matched.join('; '),
      flattenForCsv(truncate(record.clean_latest_text || record.clean_thread_excerpt || '', 220))
    ].map(csvEscape);
    lines.push(row.join(','));
  }

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function csvEscape(value) {
  const text = String(value == null ? '' : value);
  return `"${text.replace(/"/g, '""')}"`;
}

function flattenForCsv(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function writeSummary(filePath, summary) {
  const lines = [
    '# Readiness Email Export Summary',
    '',
    `- Date range used: ${summary.since} to ${summary.until}`,
    `- Number of Todoist tasks scanned: ${summary.todoistTaskCount}`,
    `- Number of subjects extracted: ${summary.subjectCount}`,
    `- Number of threads successfully fetched: ${summary.fetchedThreadCount}`,
    '',
    '## Counts By Guessed Event Type',
    ''
  ];

  const typeEntries = Object.entries(summary.countsByType).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of typeEntries) {
    lines.push(`- ${type}: ${count}`);
  }

  lines.push('', '## Mailbox Issues', '');

  if (summary.fetchFailures.length === 0) {
    lines.push('- None');
  } else {
    for (const [mailbox, count] of Object.entries(summary.failuresByMailbox)) {
      lines.push(`- ${mailbox}: ${count} fetch failures`);
    }
  }

  lines.push('', '## Fetch Failure Samples', '');

  if (summary.fetchFailures.length === 0) {
    lines.push('- None');
  } else {
    for (const failure of summary.fetchFailures.slice(0, 25)) {
      lines.push(`- ${failure.mailbox} — ${failure.subject}: ${failure.error}`);
    }
  }

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

async function runWithConcurrency(items, limit, worker) {
  const queue = items.slice();
  const runners = [];

  async function runNext() {
    const item = queue.shift();
    if (!item) return;
    await worker(item);
    await runNext();
  }

  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    runners.push(runNext());
  }

  await Promise.all(runners);
}
