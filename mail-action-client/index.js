const fs = require('fs');
const os = require('os');
const path = require('path');
const { setTimeout: delay } = require('timers/promises');

// Microsoft mailbox actions can legitimately take much longer than a short
// interactive RPC, especially when subject-based thread resolution fans out
// across multiple Graph searches. Favor patience over false "missing_response"
// failures; the helper still returns immediately once the response lands.
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_THREAD_FETCH_TIMEOUT_MS = 300_000;
const MIN_THREAD_FETCH_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_PRESENTATION_TIMEZONE = 'America/Los_Angeles';
const INTERNAL_DOMAINS = ['prestigiocustom.com'];
const INTERNAL_EMAILS = [
  'stitch@prestigiocustom.com',
  'chris@prestigiocustom.com',
  'chris91744@gmail.com'
];
const formatterCache = new Map();

const ACTION_SUPPORT = {
  microsoft: new Set(['draft', 'reply', 'fetch_thread', 'fetch_thread_by_subject', 'lookup_history', 'download_attachments']),
  gmail: new Set(['draft', 'lookup_history'])
};

let requestCounter = 0;

function defaultWorkspaceDir() {
  return process.env.OPENCLAW_WORKSPACE_DIR || path.join(os.homedir(), '.openclaw', 'workspace');
}

function defaultMailboxes(workspaceDir = defaultWorkspaceDir()) {
  return {
    stitch: {
      key: 'stitch',
      provider: 'microsoft',
      address: 'stitch@prestigiocustom.com',
      dir: path.join(workspaceDir, 'mail'),
      historyEndpoints: ['http://127.0.0.1:3001/thread-by-subject']
    },
    chris: {
      key: 'chris',
      provider: 'microsoft',
      address: 'chris@prestigiocustom.com',
      dir: path.join(workspaceDir, 'mail-chris'),
      historyEndpoints: ['http://127.0.0.1:3002/thread-by-subject']
    },
    gmail: {
      key: 'gmail',
      provider: 'gmail',
      address: 'chris91744@gmail.com',
      dir: path.join(workspaceDir, 'mail-gmail'),
      historyEndpoints: ['http://127.0.0.1:3003/mailbox-history']
    }
  };
}

function sanitizeRequestId(value, fallback = 'mail') {
  const raw = String(value || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || `${fallback}-${Date.now()}`;
}

function nextRequestId(action, now = new Date()) {
  requestCounter += 1;
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '');
  return sanitizeRequestId(`${action}-${stamp}-${process.pid}-${requestCounter}`, 'mail');
}

function normalizeAction(action) {
  const raw = String(action || '').trim();
  switch (raw) {
    case 'fetch-thread':
      return 'fetch_thread';
    case 'fetch-thread-by-subject':
      return 'fetch_thread_by_subject';
    case 'lookup-history':
    case 'mailbox_history':
    case 'mailbox-history':
      return 'lookup_history';
    default:
      return raw;
  }
}

function serviceActionName(action) {
  switch (normalizeAction(action)) {
    case 'fetch_thread':
      return 'fetch-thread';
    case 'fetch_thread_by_subject':
      return 'fetch-thread-by-subject';
    default:
      return normalizeAction(action);
  }
}

function normalizeDraftBody(body) {
  if (typeof body !== 'string') {
    return body;
  }

  let normalized = body.replace(/\r\n/g, '\n');
  normalized = normalized.replace(
    /(\n\s*(?:best|thanks|thank you|thank you!|thanks!|best regards|regards),?\s*)\n+\s*chris\s*$/i,
    '$1'
  );
  return normalized.replace(/\n/g, body.includes('\r\n') ? '\r\n' : '\n');
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeEmailHtml(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '')
    .replace(/\s+(href|src)\s*=\s*javascript:[^\s>]+/gi, '');
}

function supportsHtmlBody(mailbox) {
  return mailbox && mailbox.supportsHtmlBody !== false;
}

function actionRequestPath(mailbox, requestId) {
  return path.join(mailbox.dir, 'action-requests', `${requestId}.json`);
}

function actionResponsePath(mailbox, requestId) {
  return path.join(mailbox.dir, 'action-responses', `${requestId}.json`);
}

function threadDetailPath(mailbox, requestId) {
  return path.join(mailbox.dir, 'thread-details', `${requestId}.json`);
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, filePath);
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function timestampMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function normalizeMailboxKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'stitch' || raw === 'stitch@prestigiocustom.com') return 'stitch';
  if (raw === 'chris' || raw === 'chris@prestigiocustom.com') return 'chris';
  if (raw === 'gmail' || raw === 'chris91744@gmail.com') return 'gmail';
  return raw;
}

function resolveMailbox(mailboxes, mailboxRef) {
  const mailboxKey = normalizeMailboxKey(mailboxRef);
  if (!mailboxKey || !mailboxes[mailboxKey]) {
    throw createError('unknown_mailbox', `Unknown mailbox: ${mailboxRef || '(missing)'}`, { retryable: false });
  }
  return mailboxes[mailboxKey];
}

function isInternalEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return true;
  if (INTERNAL_EMAILS.includes(normalized)) return true;
  return INTERNAL_DOMAINS.some((domain) => normalized.endsWith(`@${domain}`));
}

function parseAddressValue(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(.*?)(?:<([^>]+)>)?$/);
      if (!match) {
        return { name: null, email: null };
      }
      const email = (match[2] || match[1] || '').trim().toLowerCase();
      const name = match[2] ? match[1].trim().replace(/^"|"$/g, '') : null;
      return {
        name: name || null,
        email: email || null
      };
    })
    .filter((contact) => contact.email);
}

function parseAddresses(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(parseAddressValue);
}

function normalizeGraphRecipients(recipients) {
  return (Array.isArray(recipients) ? recipients : [])
    .map((recipient) => {
      const emailAddress = recipient?.emailAddress || {};
      const email = String(emailAddress.address || '').trim().toLowerCase();
      if (!email) return null;
      return {
        name: emailAddress.name || null,
        email
      };
    })
    .filter(Boolean);
}

function laterTimestamp(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function uniq(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function getFormatter(timeZone, options) {
  const key = JSON.stringify([timeZone, options]);
  if (!formatterCache.has(key)) {
    formatterCache.set(key, new Intl.DateTimeFormat('en-US', { timeZone, ...options }));
  }
  return formatterCache.get(key);
}

function localDateKey(date, timeZone) {
  const parts = getFormatter(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || null;
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function formatPresentationTimestamp(value, timeZone = DEFAULT_PRESENTATION_TIMEZONE) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const shortDate = getFormatter(timeZone, {
    month: 'short',
    day: 'numeric'
  }).format(date);
  const datedWithYear = getFormatter(timeZone, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
  const timeLabel = getFormatter(timeZone, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);

  return {
    presentation_timezone: timeZone,
    local_date: localDateKey(date, timeZone),
    local_time: timeLabel,
    date_local_short: shortDate,
    date_local_with_time: `${shortDate} at ${timeLabel}`,
    date_local_full: `${datedWithYear} at ${timeLabel}`
  };
}

function normalizeThreadMessage(message, timeZone = DEFAULT_PRESENTATION_TIMEZONE) {
  const localTimestamp = formatPresentationTimestamp(message?.date, timeZone);
  return {
    ...message,
    date_utc: message?.date || null,
    presentation_timezone: timeZone,
    local_date: localTimestamp?.local_date || null,
    local_time: localTimestamp?.local_time || null,
    date_local_short: localTimestamp?.date_local_short || null,
    date_local_with_time: localTimestamp?.date_local_with_time || null,
    date_local_full: localTimestamp?.date_local_full || null
  };
}

function normalizeThreadMessages(messages, timeZone = DEFAULT_PRESENTATION_TIMEZONE) {
  return (Array.isArray(messages) ? messages : []).map((message) => normalizeThreadMessage(message, timeZone));
}

function baseSubject(subject) {
  return String(subject || '').replace(/^(Re|Fw|Fwd):\s*/gi, '').trim();
}

function normalizeSearchText(value) {
  return baseSubject(value)
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildHistoryAliases(request) {
  return uniq(
    []
      .concat(request.search ? [request.search] : [])
      .concat(request.subject ? [request.subject] : [])
      .concat(Array.isArray(request.aliases) ? request.aliases : [])
      .map(normalizeSearchText)
      .filter(Boolean)
  );
}

function buildParticipantQuery(request) {
  return uniq(
    (Array.isArray(request.participants) ? request.participants : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((email) => email && !isInternalEmail(email))
  );
}

function computeMailboxConfidence(recipientCount, hitCount, lastSeen, aliasCount) {
  let confidence = 0.52;
  confidence += Math.min(0.16, recipientCount * 0.04);
  confidence += Math.min(0.12, hitCount * 0.04);
  confidence += Math.min(0.08, aliasCount * 0.02);

  if (lastSeen) {
    const daysAgo = (Date.now() - new Date(lastSeen).getTime()) / (24 * 60 * 60 * 1000);
    if (daysAgo <= 30) confidence += 0.12;
    else if (daysAgo <= 90) confidence += 0.08;
    else if (daysAgo <= 365) confidence += 0.04;
  }

  return Math.max(0.2, Math.min(0.92, Number(confidence.toFixed(2))));
}

function compareRecipients(left, right) {
  const leftSeen = new Date(left.last_seen || 0).getTime();
  const rightSeen = new Date(right.last_seen || 0).getTime();
  if (right.score !== left.score) return right.score - left.score;
  return rightSeen - leftSeen;
}

function compareHistoryResults(left, right) {
  if ((right.confidence || 0) !== (left.confidence || 0)) {
    return (right.confidence || 0) - (left.confidence || 0);
  }
  if ((right.recipients?.length || 0) !== (left.recipients?.length || 0)) {
    return (right.recipients?.length || 0) - (left.recipients?.length || 0);
  }
  return new Date(right.recipients?.[0]?.last_seen || 0).getTime()
    - new Date(left.recipients?.[0]?.last_seen || 0).getTime();
}

function summarizeRecipientResolution(resolution) {
  if (!resolution || typeof resolution !== 'object') {
    return null;
  }

  return {
    found_in: resolution.found_in || null,
    provider: resolution.provider || null,
    mailbox: resolution.mailbox || null,
    confidence: typeof resolution.confidence === 'number'
      ? Number(resolution.confidence.toFixed(2))
      : null,
    matched_project: resolution.matched_project || null,
    matched_item: resolution.matched_item || null,
    matched_thread_subjects: Array.isArray(resolution.matched_thread_subjects)
      ? resolution.matched_thread_subjects
      : [],
    matched_recipients: Array.isArray(resolution.matched_recipients)
      ? resolution.matched_recipients
      : [],
    history_winner_reason: resolution.history_winner_reason || resolution.winner_reason || null
  };
}

function formatRecipientSource(summary) {
  if (!summary) return 'explicit recipients';
  if (summary.found_in === 'project_contacts') return 'Prestigio app project contacts';
  if (summary.found_in === 'mailbox_history' && summary.provider === 'microsoft') {
    return 'Microsoft mailbox history';
  }
  if (summary.found_in === 'mailbox_history' && summary.provider === 'gmail') {
    return 'Gmail mailbox history';
  }
  if (summary.found_in === 'none') return 'no resolved recipient source';
  return summary.found_in;
}

function createError(code, message, extra = {}) {
  return {
    code,
    message,
    retryable: extra.retryable === true,
    details: extra.details || null
  };
}

function createNormalizedResponse(base, overrides = {}) {
  return {
    ok: false,
    matched: false,
    requestId: base.requestId || null,
    action: base.action || null,
    provider: base.provider || null,
    mailbox: base.mailbox || null,
    presentation_timezone: overrides.presentation_timezone || DEFAULT_PRESENTATION_TIMEZONE,
    summary: overrides.summary || null,
    plain_language_summary: overrides.summary || null,
    result: overrides.result || null,
    recipientResolution: overrides.recipientResolution || null,
    recipientResolutionSummary: overrides.recipientResolutionSummary || null,
    found_in: overrides.found_in || null,
    aliases_tried: overrides.aliases_tried || [],
    confidence: typeof overrides.confidence === 'number' ? overrides.confidence : null,
    matched_thread_subjects: overrides.matched_thread_subjects || [],
    matched_recipients: overrides.matched_recipients || [],
    error: overrides.error || null,
    raw: overrides.raw || null
  };
}

function normalizeProvenance(recipientResolution) {
  const summary = summarizeRecipientResolution(recipientResolution);
  return {
    recipientResolution: recipientResolution || null,
    recipientResolutionSummary: summary,
    found_in: summary?.found_in || null,
    aliases_tried: Array.isArray(recipientResolution?.aliases_tried) ? recipientResolution.aliases_tried : [],
    confidence: typeof recipientResolution?.confidence === 'number' ? recipientResolution.confidence : null,
    matched_thread_subjects: summary?.matched_thread_subjects || [],
    matched_recipients: summary?.matched_recipients || []
  };
}

function validateSupportedAction(provider, action) {
  const normalizedAction = normalizeAction(action);
  const supported = ACTION_SUPPORT[provider];
  return supported && supported.has(normalizedAction);
}

function resolveTimeoutMs(action, explicitTimeoutMs) {
  const normalizedAction = normalizeAction(action);
  if (normalizedAction === 'fetch_thread' || normalizedAction === 'fetch_thread_by_subject') {
    if (Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0) {
      // Graph thread searches often complete just after 20s. A floor avoids
      // false misses that trigger slower sibling-mailbox rescue paths.
      return Math.max(explicitTimeoutMs, MIN_THREAD_FETCH_TIMEOUT_MS);
    }
    return DEFAULT_THREAD_FETCH_TIMEOUT_MS;
  }

  if (Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0) {
    return explicitTimeoutMs;
  }

  return DEFAULT_TIMEOUT_MS;
}

async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  return response.json();
}

function normalizeDraftResult(action, request, response, mailbox) {
  const raw = response?.result || {};
  const actualRecipientObjects = normalizeGraphRecipients(raw.toRecipients);
  const actualCcRecipientObjects = normalizeGraphRecipients(raw.ccRecipients);
  const actualTo = actualRecipientObjects.map((recipient) => recipient.email);
  const actualCc = actualCcRecipientObjects.map((recipient) => recipient.email);

  if (mailbox.provider === 'microsoft') {
    return {
      draft_id: raw.id || null,
      subject: raw.subject || request.subject || null,
      thread_id: raw.conversationId || null,
      web_link: raw.webLink || null,
      to: actualTo.length > 0 ? actualTo : (Array.isArray(request.to) ? request.to.slice() : []),
      cc: actualCc.length > 0 ? actualCc : (Array.isArray(request.cc) ? request.cc.slice() : []),
      toRecipients: actualRecipientObjects,
      ccRecipients: actualCcRecipientObjects,
      replyRecipientGuard: response?.replyRecipientGuard || null,
      draft_type: action === 'reply' ? 'reply' : 'new'
    };
  }

  return {
    draft_id: raw.id || null,
    subject: request.subject || null,
    thread_id: raw.message?.threadId || null,
    message_id: raw.message?.id || null,
    web_link: null,
    to: Array.isArray(request.to) ? request.to.slice() : [],
    cc: Array.isArray(request.cc) ? request.cc.slice() : [],
    toRecipients: (Array.isArray(request.to) ? request.to : []).map((email) => ({ name: null, email })),
    ccRecipients: (Array.isArray(request.cc) ? request.cc : []).map((email) => ({ name: null, email })),
    replyRecipientGuard: null,
    draft_type: 'new'
  };
}

function normalizeMailboxFilePath(value, mailbox) {
  var raw = String(value || '').trim();
  if (!raw) return null;
  if (mailbox && mailbox.dir && (raw === '/mail-output' || raw.startsWith('/mail-output/'))) {
    return path.join(mailbox.dir, raw.slice('/mail-output'.length));
  }
  return raw;
}

function normalizeAttachmentDownloadResult(response, mailbox) {
  var raw = response && response.result && typeof response.result === 'object'
    ? response.result
    : {};
  return {
    message_id: raw.messageId || raw.message_id || null,
    attachment_count: Array.isArray(raw.attachments) ? raw.attachments.length : 0,
    total_bytes: Number(raw.totalBytes || raw.total_bytes || 0),
    output_dir: normalizeMailboxFilePath(raw.outputDir || raw.output_dir, mailbox),
    attachments: Array.isArray(raw.attachments)
      ? raw.attachments.map(function(attachment) {
        return {
          ...attachment,
          path: normalizeMailboxFilePath(attachment.path, mailbox)
        };
      })
      : [],
    skipped: Array.isArray(raw.skipped) ? raw.skipped : []
  };
}

function normalizeThreadResult(response, detail, options = {}) {
  const presentationTimeZone = options.presentationTimeZone || DEFAULT_PRESENTATION_TIMEZONE;
  if (response?.result?.ambiguous || detail?.ambiguous) {
    return {
      ambiguous: true,
      subject: detail?.requestedSubject || response?.result?.subject || detail?.subject || null,
      message_count: 0,
      conversation_id: null,
      messages: [],
      presentation_timezone: presentationTimeZone,
      candidates: Array.isArray(detail?.candidates)
        ? detail.candidates
        : Array.isArray(response?.result?.candidates)
          ? response.result.candidates
          : [],
      ambiguity_message: detail?.ambiguityMessage || response?.result?.ambiguityMessage || 'I found multiple likely threads and did not choose one automatically.'
    };
  }

  return {
    subject: response?.result?.subject || detail?.subject || null,
    message_count: response?.result?.messageCount || detail?.messageCount || (detail?.messages || []).length,
    conversation_id: response?.result?.conversationId || detail?.conversationId || null,
    presentation_timezone: presentationTimeZone,
    messages: normalizeThreadMessages(Array.isArray(detail?.messages) ? detail.messages : [], presentationTimeZone)
  };
}

function buildSuccessSummary(action, mailbox, normalizedResult, provenance) {
  const source = formatRecipientSource(provenance.recipientResolutionSummary);
  if (action === 'draft' || action === 'reply') {
    const subject = normalizedResult.subject || '(no subject)';
    const recipients = normalizedResult.to && normalizedResult.to.length > 0
      ? normalizedResult.to.join(', ')
      : 'no explicit recipients';
    const prefix = action === 'reply' ? 'Created reply draft' : 'Created draft';
    const detail = provenance.recipientResolutionSummary
      ? ` Recipient evidence came from ${source}.`
      : '';
    return `${prefix} "${subject}" in ${mailbox.address} to ${recipients}.${detail}`.trim();
  }

  if (action === 'fetch_thread' || action === 'fetch_thread_by_subject') {
    return `Fetched ${normalizedResult.message_count} message(s) from ${mailbox.address} for "${normalizedResult.subject || '(no subject)'}".`;
  }

  if (action === 'download_attachments') {
    return `Downloaded ${normalizedResult.attachment_count || 0} attachment(s) from ${mailbox.address}.`;
  }

  return `Completed ${action} for ${mailbox.address}.`;
}

function buildHistorySummary(result, searchedMailboxes, runnerUp) {
  if (!result || !Array.isArray(result.recipients) || result.recipients.length === 0) {
    return `No mailbox-history match found across ${searchedMailboxes.join(', ')}.`;
  }

  const base = `${result.provider === 'gmail' ? 'Gmail' : 'Microsoft'} mailbox history in ${result.mailbox} found ${result.recipients.length} likely recipient(s)`;
  const subject = result.matched_thread_subjects?.[0];
  const subjectPart = subject ? ` from "${subject}"` : '';
  const winnerPart = result.winner_reason
    ? `. ${result.winner_reason}.`
    : runnerUp
      ? `. ${result.provider} outranked ${runnerUp.provider}.`
      : '.';
  return `${base}${subjectPart}${winnerPart}`;
}

function buildErrorSummary(action, mailbox, error) {
  const target = mailbox ? `${mailbox.address}` : 'the mail helper';
  switch (error.code) {
    case 'ambiguous_thread':
      return error.message;
    case 'timeout':
      return `Timed out waiting for ${action} on ${target}.`;
    case 'missing_response':
      return `No response file appeared for ${action} on ${target}.`;
    case 'stale_response':
      return `The ${action} response for ${target} looked stale, so it was ignored.`;
    case 'request_id_mismatch':
      return `The ${action} response for ${target} had the wrong requestId, so it was rejected.`;
    case 'unsupported_action':
      return error.message;
    default:
      return error.message;
  }
}

function isStaleFile(stat, startedAtMs) {
  return Boolean(stat) && stat.mtimeMs < startedAtMs;
}

function validateActionResponse(response, stat, context) {
  if (!response || typeof response !== 'object') {
    return createError('invalid_response', 'Response file was not valid JSON', { retryable: false });
  }

  if (response.requestId && response.requestId !== context.requestId) {
    return createError('request_id_mismatch', `Expected requestId ${context.requestId} but got ${response.requestId}`, { retryable: false });
  }

  if (response.requestedAt && response.requestedAt !== context.requestedAt) {
    return createError('stale_response', `Expected requestedAt ${context.requestedAt} but got ${response.requestedAt}`, { retryable: false });
  }

  if (isStaleFile(stat, context.startedAtMs)) {
    return createError('stale_response', 'Response file was older than the current request', { retryable: false });
  }

  const completedAt = timestampMs(response.completedAt || response.completed_at || response.responded_at);
  if (completedAt && completedAt < context.startedAtMs) {
    return createError('stale_response', 'Response completion time predates the current request', { retryable: false });
  }

  return null;
}

async function pollForAction(mailbox, request, context, options = {}) {
  const timeoutMs = resolveTimeoutMs(request.action, options.timeoutMs);
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const responsePath = actionResponsePath(mailbox, context.requestId);
  const detailPath = threadDetailPath(mailbox, context.requestId);
  const deadline = Date.now() + timeoutMs;
  const needsThreadDetail = request.action === 'fetch_thread' || request.action === 'fetch_thread_by_subject';
  let sawResponseFile = false;

  while (Date.now() <= deadline) {
    if (fileExists(responsePath)) {
      sawResponseFile = true;
      const stat = fs.statSync(responsePath);
      const response = readJson(responsePath);
      const validationError = validateActionResponse(response, stat, context);
      if (validationError) {
        return { ok: false, error: validationError, raw: { actionResponse: response } };
      }

      if (response.success === false) {
        return { ok: false, error: createError('service_error', response.error || 'Mail service returned an error', { retryable: false }), raw: { actionResponse: response } };
      }

      if (needsThreadDetail) {
        if (fileExists(detailPath)) {
          const detailStat = fs.statSync(detailPath);
          if (isStaleFile(detailStat, context.startedAtMs)) {
            return {
              ok: false,
              error: createError('stale_response', 'Thread detail file was older than the current request', { retryable: false }),
              raw: { actionResponse: response }
            };
          }
          return {
            ok: true,
            actionResponse: response,
            threadDetail: readJson(detailPath)
          };
        }
      } else {
        return {
          ok: true,
          actionResponse: response,
          threadDetail: null
        };
      }
    }

    await delay(pollIntervalMs);
  }

  if (!sawResponseFile) {
    return {
      ok: false,
      error: createError('missing_response', `No response file appeared for ${request.action}`, {
        retryable: true,
        details: { responsePath, detailPath: needsThreadDetail ? detailPath : null }
      })
    };
  }

  return {
    ok: false,
    error: createError('timeout', `Timed out after ${timeoutMs}ms waiting for ${request.action}`, {
      retryable: true,
      details: { responsePath, detailPath: needsThreadDetail ? detailPath : null }
    })
  };
}

function buildActionRequest(input, requestId, requestedAt) {
  const request = {
    ...input,
    action: serviceActionName(input.action),
    requestId,
    requested_at: requestedAt
  };
  if (request.action === 'draft' || request.action === 'reply') {
    request.body = normalizeDraftBody(request.body);
    request.bodyText = normalizeDraftBody(request.bodyText);
    if (typeof request.bodyHtml === 'string') {
      request.bodyHtml = sanitizeEmailHtml(request.bodyHtml);
    }
    if (!supportsHtmlBody(input.__mailbox) && typeof request.bodyHtml === 'string') {
      request.body = request.bodyText || htmlToText(request.bodyHtml);
      delete request.bodyText;
      delete request.bodyHtml;
      delete request.bodyType;
    }
  }
  delete request.timeoutMs;
  delete request.pollIntervalMs;
  delete request.provider;
  delete request.__mailbox;
  if (request.action === 'lookup_history') {
    delete request.mailbox;
  }
  return request;
}

async function executeActionRequest(input, options = {}) {
  const mailboxes = options.mailboxes || defaultMailboxes(options.workspaceDir);
  const action = normalizeAction(input.action);
  const mailbox = resolveMailbox(mailboxes, input.mailbox);
  const presentationTimeZone = input.presentationTimeZone || options.presentationTimeZone || DEFAULT_PRESENTATION_TIMEZONE;

  if (!validateSupportedAction(mailbox.provider, action)) {
    const error = createError(
      'unsupported_action',
      `${mailbox.provider === 'gmail' ? 'Gmail' : 'Microsoft'} does not support ${action} through the mail helper.`,
      { retryable: false }
    );
    return createNormalizedResponse({
      requestId: null,
      action,
      provider: mailbox.provider,
      mailbox: mailbox.address
    }, {
      presentation_timezone: presentationTimeZone,
      summary: buildErrorSummary(action, mailbox, error),
      error
    });
  }

  const now = options.now || new Date();
  const requestId = sanitizeRequestId(
    options.requestIdFactory ? options.requestIdFactory(action, mailbox) : nextRequestId(action, now),
    'mail'
  );
  const startedAtMs = now.getTime();
  const requestedAt = now.toISOString();
  const request = buildActionRequest({ ...input, __mailbox: mailbox }, requestId, requestedAt);
  const requestPath = actionRequestPath(mailbox, requestId);
  const responsePath = actionResponsePath(mailbox, requestId);
  const detailPath = threadDetailPath(mailbox, requestId);

  if (fileExists(responsePath) || ((action === 'fetch_thread' || action === 'fetch_thread_by_subject') && fileExists(detailPath))) {
    const error = createError('stale_response', `A pre-existing response file already exists for requestId ${requestId}`, {
      retryable: false,
      details: { responsePath, detailPath: fileExists(detailPath) ? detailPath : null }
    });
    return createNormalizedResponse({
      requestId,
      action,
      provider: mailbox.provider,
      mailbox: mailbox.address
    }, {
      presentation_timezone: presentationTimeZone,
      summary: buildErrorSummary(action, mailbox, error),
      error
    });
  }

  writeJsonAtomic(requestPath, request);

  const polled = await pollForAction(mailbox, { action }, {
    requestId,
    requestedAt,
    startedAtMs
  }, {
    timeoutMs: input.timeoutMs || options.timeoutMs,
    pollIntervalMs: input.pollIntervalMs || options.pollIntervalMs
  });

  const provenance = normalizeProvenance(input.recipientResolution || polled.actionResponse?.recipientResolution);

  if (!polled.ok) {
    return createNormalizedResponse({
      requestId,
      action,
      provider: mailbox.provider,
      mailbox: mailbox.address
    }, {
      presentation_timezone: presentationTimeZone,
      summary: buildErrorSummary(action, mailbox, polled.error),
      error: polled.error,
      recipientResolution: provenance.recipientResolution,
      recipientResolutionSummary: provenance.recipientResolutionSummary,
      found_in: provenance.found_in,
      aliases_tried: provenance.aliases_tried,
      confidence: provenance.confidence,
      matched_thread_subjects: provenance.matched_thread_subjects,
      matched_recipients: provenance.matched_recipients,
      raw: polled.raw || null
    });
  }

  const normalizedResult = action === 'draft' || action === 'reply'
    ? normalizeDraftResult(action, request, polled.actionResponse, mailbox)
    : action === 'download_attachments'
      ? normalizeAttachmentDownloadResult(polled.actionResponse, mailbox)
      : normalizeThreadResult(polled.actionResponse, polled.threadDetail, { presentationTimeZone });

  if ((action === 'fetch_thread' || action === 'fetch_thread_by_subject') && normalizedResult.ambiguous) {
    const error = createError(
      'ambiguous_thread',
      normalizedResult.ambiguity_message,
      {
        retryable: false,
        details: {
          subject: normalizedResult.subject,
          candidates: normalizedResult.candidates
        }
      }
    );
    return createNormalizedResponse({
      requestId,
      action,
      provider: mailbox.provider,
      mailbox: mailbox.address
    }, {
      presentation_timezone: presentationTimeZone,
      summary: buildErrorSummary(action, mailbox, error),
      error,
      result: normalizedResult,
      recipientResolution: provenance.recipientResolution,
      recipientResolutionSummary: provenance.recipientResolutionSummary,
      found_in: provenance.found_in,
      aliases_tried: provenance.aliases_tried,
      confidence: provenance.confidence,
      matched_thread_subjects: provenance.matched_thread_subjects,
      matched_recipients: provenance.matched_recipients,
      raw: {
        actionResponse: polled.actionResponse,
        threadDetail: polled.threadDetail
      }
    });
  }

  const summary = buildSuccessSummary(action, mailbox, normalizedResult, provenance);

  return {
    ok: true,
    matched: true,
    requestId,
    action,
    provider: mailbox.provider,
    mailbox: mailbox.address,
    presentation_timezone: presentationTimeZone,
    summary,
    plain_language_summary: summary,
    result: normalizedResult,
    recipientResolution: provenance.recipientResolution,
    recipientResolutionSummary: provenance.recipientResolutionSummary,
    found_in: provenance.found_in,
    aliases_tried: provenance.aliases_tried,
    confidence: provenance.confidence,
    matched_thread_subjects: provenance.matched_thread_subjects,
    matched_recipients: provenance.matched_recipients,
    error: null,
    raw: {
      actionResponse: polled.actionResponse,
      threadDetail: polled.threadDetail
    }
  };
}

function extractRecipientsFromThreadMessages(messages, provider, mailboxAddress) {
  const recipientMap = new Map();
  let bestLastSeen = null;

  messages.forEach((message, index) => {
    const isLatest = index === messages.length - 1;
    const isRecent = index >= messages.length - 2;
    [message.from, message.to, message.cc]
      .flatMap(parseAddresses)
      .filter((contact) => contact.email && !isInternalEmail(contact.email))
      .forEach((contact) => {
        const key = contact.email.toLowerCase();
        const current = recipientMap.get(key) || {
          name: contact.name,
          email: contact.email,
          score: 0,
          last_seen: message.date || null
        };

        current.name = current.name || contact.name || null;
        current.score += 2 + (isLatest ? 4 : (isRecent ? 2 : 1));
        current.last_seen = laterTimestamp(current.last_seen, message.date || null);
        recipientMap.set(key, current);
        bestLastSeen = laterTimestamp(bestLastSeen, current.last_seen);
      });
  });

  const recipients = Array.from(recipientMap.values())
    .sort(compareRecipients)
    .map((recipient) => ({
      name: recipient.name,
      email: recipient.email,
      found_in: 'mailbox_history',
      provider,
      mailbox: mailboxAddress,
      last_seen: recipient.last_seen
    }));

  return { recipients, bestLastSeen };
}

async function lookupMicrosoftHistory(mailbox, request, options = {}) {
  const aliases = buildHistoryAliases(request);
  const hits = [];
  const recipientMap = new Map();
  const matchedThreadSubjects = [];
  let bestLastSeen = null;
  const post = options.postJson || postJson;

  for (const alias of aliases) {
    for (const endpoint of mailbox.historyEndpoints || []) {
      let thread = null;
      try {
        thread = await post(endpoint, { subject: alias }, { timeoutMs: request.timeoutMs || options.timeoutMs });
      } catch (_) {
        continue;
      }

      if (!thread || !Array.isArray(thread.messages) || thread.messages.length === 0) {
        continue;
      }

      const extracted = extractRecipientsFromThreadMessages(thread.messages, 'microsoft', mailbox.address);
      if (extracted.recipients.length === 0) {
        continue;
      }

      hits.push({
        mailbox: mailbox.address,
        provider: 'microsoft',
        alias,
        subject: thread.subject || alias,
        conversation_id: thread.conversationId || null,
        count: extracted.recipients.length
      });
      matchedThreadSubjects.push(thread.subject || alias);
      bestLastSeen = laterTimestamp(bestLastSeen, extracted.bestLastSeen);

      extracted.recipients.forEach((recipient) => {
        const key = recipient.email.toLowerCase();
        const current = recipientMap.get(key);
        if (!current) {
          recipientMap.set(key, { ...recipient, score: 1 });
          return;
        }
        current.last_seen = laterTimestamp(current.last_seen, recipient.last_seen);
      });
    }
  }

  const recipients = Array.from(recipientMap.values());
  if (recipients.length === 0) {
    return {
      provider: 'microsoft',
      mailbox: mailbox.address,
      found_in: 'mailbox_history',
      aliases_tried: aliases,
      confidence: 0,
      matched_thread_subjects: [],
      matched_recipients: [],
      recipients: [],
      hits: [],
      winner_reason: null
    };
  }

  recipients.sort((left, right) => new Date(right.last_seen || 0).getTime() - new Date(left.last_seen || 0).getTime());
  return {
    provider: 'microsoft',
    mailbox: mailbox.address,
    found_in: 'mailbox_history',
    aliases_tried: aliases,
    confidence: computeMailboxConfidence(recipients.length, hits.length, bestLastSeen, aliases.length),
    matched_thread_subjects: uniq(matchedThreadSubjects),
    matched_recipients: recipients.map((recipient) => recipient.email),
    recipients,
    hits,
    winner_reason: uniq(matchedThreadSubjects)[0]
      ? `matched "${uniq(matchedThreadSubjects)[0]}" in ${mailbox.address}`
      : null
  };
}

async function lookupGmailHistory(mailbox, request, options = {}) {
  const post = options.postJson || postJson;
  let result = null;

  for (const endpoint of mailbox.historyEndpoints || []) {
    try {
      result = await post(endpoint, {
        search: request.search || request.subject || '',
        aliases: buildHistoryAliases(request),
        participants: buildParticipantQuery(request)
      }, { timeoutMs: request.timeoutMs || options.timeoutMs });
      break;
    } catch (_) {
      // best effort
    }
  }

  if (!result) {
    return {
      provider: 'gmail',
      mailbox: mailbox.address,
      found_in: 'mailbox_history',
      aliases_tried: buildHistoryAliases(request),
      confidence: 0,
      matched_thread_subjects: [],
      matched_recipients: [],
      recipients: [],
      candidates: [],
      winner_reason: null
    };
  }

  return {
    provider: 'gmail',
    mailbox: result.mailbox || mailbox.address,
    found_in: result.found_in || 'mailbox_history',
    aliases_tried: Array.isArray(result.aliases_tried) ? result.aliases_tried : buildHistoryAliases(request),
    confidence: typeof result.confidence === 'number' ? result.confidence : 0,
    matched_thread_subjects: Array.isArray(result.matched_thread_subjects) ? result.matched_thread_subjects : [],
    matched_recipients: Array.isArray(result.matched_recipients) ? result.matched_recipients : [],
    recipients: Array.isArray(result.recipients) ? result.recipients : [],
    candidates: Array.isArray(result.candidates) ? result.candidates : [],
    winner_reason: result.winner_reason || null
  };
}

function selectHistoryMailboxes(mailboxes, request) {
  if (request.mailbox) {
    return [resolveMailbox(mailboxes, request.mailbox)];
  }

  const provider = String(request.provider || 'auto').trim().toLowerCase();
  const all = Object.values(mailboxes);
  if (provider === 'auto') return all;
  return all.filter((mailbox) => mailbox.provider === provider);
}

async function executeHistoryLookup(request, options = {}) {
  const mailboxes = options.mailboxes || defaultMailboxes(options.workspaceDir);
  const presentationTimeZone = request.presentationTimeZone || options.presentationTimeZone || DEFAULT_PRESENTATION_TIMEZONE;
  const targets = selectHistoryMailboxes(mailboxes, request);
  if (targets.length === 0) {
    const error = createError('unknown_provider', `Unknown provider: ${request.provider || '(missing)'}`, { retryable: false });
    return createNormalizedResponse({
      requestId: null,
      action: 'lookup_history',
      provider: null,
      mailbox: null
    }, {
      presentation_timezone: presentationTimeZone,
      summary: buildErrorSummary('lookup_history', null, error),
      error
    });
  }

  const results = [];
  for (const mailbox of targets) {
    const result = mailbox.provider === 'gmail'
      ? await lookupGmailHistory(mailbox, request, options)
      : await lookupMicrosoftHistory(mailbox, request, options);
    if (result.recipients.length > 0) {
      results.push(result);
    }
  }

  results.sort(compareHistoryResults);
  const winner = results[0] || null;
  const runnerUp = results[1] || null;

  if (!winner) {
    const summary = `No mailbox-history match found across ${targets.map((target) => target.address).join(', ')}.`;
    return {
      ok: true,
      matched: false,
      requestId: null,
      action: 'lookup_history',
      provider: request.provider || (request.mailbox ? resolveMailbox(mailboxes, request.mailbox).provider : 'auto'),
      mailbox: request.mailbox ? resolveMailbox(mailboxes, request.mailbox).address : null,
      presentation_timezone: presentationTimeZone,
      summary,
      plain_language_summary: summary,
      result: {
        recipients: [],
        candidates: [],
        searched_mailboxes: targets.map((target) => target.address)
      },
      recipientResolution: null,
      recipientResolutionSummary: null,
      found_in: null,
      aliases_tried: buildHistoryAliases(request),
      confidence: 0,
      matched_thread_subjects: [],
      matched_recipients: [],
      error: null,
      raw: {
        searched_mailboxes: targets.map((target) => target.address)
      }
    };
  }

  const summary = buildHistorySummary(winner, targets.map((target) => target.address), runnerUp);
  const recipientResolution = {
    provider: winner.provider,
    mailbox: winner.mailbox,
    found_in: winner.found_in || 'mailbox_history',
    aliases_tried: winner.aliases_tried || buildHistoryAliases(request),
    confidence: winner.confidence,
    matched_thread_subjects: winner.matched_thread_subjects || [],
    matched_recipients: winner.matched_recipients || [],
    history_winner_reason: winner.winner_reason || null,
    recipients: winner.recipients
  };
  const provenance = normalizeProvenance(recipientResolution);

  return {
    ok: true,
    matched: true,
    requestId: null,
    action: 'lookup_history',
    provider: winner.provider,
    mailbox: winner.mailbox,
    presentation_timezone: presentationTimeZone,
    summary,
    plain_language_summary: summary,
    result: {
      recipients: winner.recipients,
      candidates: results.map((result) => ({
        provider: result.provider,
        mailbox: result.mailbox,
        confidence: result.confidence,
        matched_thread_subjects: result.matched_thread_subjects,
        matched_recipients: result.matched_recipients
      })),
      searched_mailboxes: targets.map((target) => target.address)
    },
    recipientResolution,
    recipientResolutionSummary: provenance.recipientResolutionSummary,
    found_in: provenance.found_in,
    aliases_tried: provenance.aliases_tried,
    confidence: provenance.confidence,
    matched_thread_subjects: provenance.matched_thread_subjects,
    matched_recipients: provenance.matched_recipients,
    error: null,
    raw: {
      winner,
      candidates: results
    }
  };
}

async function executeMailAction(request, options = {}) {
  const action = normalizeAction(request?.action);
  if (!action) {
    const error = createError('invalid_request', 'action is required', { retryable: false });
    return createNormalizedResponse({
      requestId: null,
      action: null,
      provider: null,
      mailbox: null
    }, {
      summary: error.message,
      error
    });
  }

  if (action === 'lookup_history') {
    return executeHistoryLookup({ ...request, action }, options);
  }

  return executeActionRequest({ ...request, action }, options);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_THREAD_FETCH_TIMEOUT_MS,
  MIN_THREAD_FETCH_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PRESENTATION_TIMEZONE,
  ACTION_SUPPORT,
  defaultMailboxes,
  nextRequestId,
  normalizeAction,
  serviceActionName,
  summarizeRecipientResolution,
  executeMailAction,
  __test: {
    normalizeMailboxKey,
    resolveMailbox,
    actionRequestPath,
    actionResponsePath,
    threadDetailPath,
    buildHistoryAliases,
    buildParticipantQuery,
    lookupMicrosoftHistory,
    lookupGmailHistory,
    validateActionResponse,
    resolveTimeoutMs,
    formatPresentationTimestamp,
    normalizeDraftBody,
    htmlToText,
    sanitizeEmailHtml,
    supportsHtmlBody,
    buildActionRequest,
    normalizeDraftResult,
    normalizeThreadMessage,
    normalizeThreadMessages,
    normalizeThreadResult
  }
};
