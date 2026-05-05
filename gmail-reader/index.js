var express = require('express');
var fs = require('fs');
var path = require('path');
var readinessShadow;
try {
  readinessShadow = require('./readiness-shadow.cjs');
} catch (_) {
  readinessShadow = require('../readiness-shadow.cjs');
}
var app = express();
var PORT = process.env.PORT || 3001;

// Parse JSON request bodies for POST endpoints
app.use(express.json());

var CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
var CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
var REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || ('http://localhost:' + PORT + '/oauth/callback');
var MAILBOX = process.env.GMAIL_ADDRESS || 'chris91744@gmail.com';
var OUTPUT_DIR = process.env.MAIL_OUTPUT_DIR || '/mail-output';
var TOKEN_FILE = path.join(OUTPUT_DIR, '.gmail-token.json');
var LEGACY_ACTION_REQUEST_FILE = path.join(OUTPUT_DIR, 'action-request.json');
var LEGACY_ACTION_RESULT_FILE = path.join(OUTPUT_DIR, 'action-result.json');
var ACTION_REQUEST_DIR = path.join(OUTPUT_DIR, 'action-requests');
var ACTION_RESPONSE_DIR = path.join(OUTPUT_DIR, 'action-responses');
var ACTION_POLL_INTERVAL_MS = 1000;
var ACTION_REQUEST_STABILITY_MS = 250;
var ACTION_FILE_TTL_MS = 24 * 60 * 60 * 1000;
var INTERNAL_DOMAINS = ['prestigiocustom.com'];
var INTERNAL_EMAILS = [MAILBOX.toLowerCase(), 'stitch@prestigiocustom.com', 'chris@prestigiocustom.com'];

// ============================================================
// OAUTH 2.0 TOKEN MANAGEMENT
// Google requires a one-time human login. After that, the refresh
// token lets us get new access tokens automatically forever.
// ============================================================

var tokenData = { accessToken: null, refreshToken: null, expiresAt: 0 };
var lastLegacyActionMtime = 0;
var actionWatcherBusy = false;
var lastActionCleanupAt = 0;

// Load saved refresh token from disk on startup
function loadSavedToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      var saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      tokenData.refreshToken = saved.refreshToken;
      console.log('[gmail-reader] loaded saved refresh token');
      return true;
    }
  } catch (err) {
    console.error('[gmail-reader] failed to load saved token:', err.message);
  }
  return false;
}

// Save refresh token to disk so it survives container restarts
function saveToken() {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refreshToken: tokenData.refreshToken }, null, 2));
    console.log('[gmail-reader] saved refresh token to disk');
  } catch (err) {
    console.error('[gmail-reader] failed to save token:', err.message);
  }
}

// Exchange a refresh token for a new access token
async function refreshAccessToken() {
  var params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: tokenData.refreshToken,
    grant_type: 'refresh_token'
  });
  var response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!response.ok) {
    throw new Error('Token refresh failed: ' + response.status + ' ' + (await response.text()));
  }
  var data = await response.json();
  tokenData.accessToken = data.access_token;
  tokenData.expiresAt = Date.now() + (data.expires_in * 1000);
  // Google sometimes issues a new refresh token; save it if so
  if (data.refresh_token) {
    tokenData.refreshToken = data.refresh_token;
    saveToken();
  }
  return tokenData.accessToken;
}

// Get a valid access token, refreshing if needed
async function getAccessToken() {
  if (!tokenData.refreshToken) {
    throw new Error('Not authorized yet. Visit http://localhost:' + PORT + '/oauth/start to authorize.');
  }
  // Refresh if token is expired or will expire in the next 5 minutes
  if (!tokenData.accessToken || Date.now() > tokenData.expiresAt - 300000) {
    await refreshAccessToken();
  }
  return tokenData.accessToken;
}

// ============================================================
// OAUTH 2.0 AUTHORIZATION FLOW (one-time setup)
// ============================================================

// Step 1: Redirect the user to Google's consent screen
app.get('/oauth/start', function(req, res) {
  var params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.modify',
    access_type: 'offline',      // This is what gives us the refresh token
    prompt: 'consent'            // Force consent so we always get a refresh token
  });
  var url = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  console.log('[gmail-reader] redirecting to Google consent screen');
  res.redirect(url);
});

// Step 2: Google redirects back here with an authorization code
app.get('/oauth/callback', async function(req, res) {
  try {
    var code = req.query.code;
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }
    // Exchange the authorization code for access + refresh tokens
    var params = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    });
    var response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    if (!response.ok) {
      throw new Error('Token exchange failed: ' + response.status + ' ' + (await response.text()));
    }
    var data = await response.json();
    tokenData.accessToken = data.access_token;
    tokenData.refreshToken = data.refresh_token;
    tokenData.expiresAt = Date.now() + (data.expires_in * 1000);
    // Save the refresh token so it survives restarts
    saveToken();
    // Do an initial sync now that we're authorized
    await syncInboxToFile();
    res.send('<h1>Authorization successful!</h1><p>Gmail reader is now connected to ' + MAILBOX + '.</p><p>You can close this tab.</p>');
    console.log('[gmail-reader] authorization complete, tokens saved');
  } catch (err) {
    console.error('[gmail-reader] oauth callback error:', err.message);
    res.status(500).send('Authorization failed: ' + err.message);
  }
});

// ============================================================
// GMAIL API CALLS
// ============================================================

// Generic Gmail API caller
async function callGmail(endpoint, method, body) {
  var token = await getAccessToken();
  var options = {
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  };
  if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }
  var response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me' + endpoint, options);
  if (response.status === 204) {
    return { success: true };
  }
  if (!response.ok) {
    throw new Error('Gmail API: ' + response.status + ' ' + (await response.text()));
  }
  return response.json();
}

// Parse email headers into a simpler format
function getHeader(headers, name) {
  var header = headers.find(function(h) { return h.name.toLowerCase() === name.toLowerCase(); });
  return header ? header.value : '';
}

// Format a Gmail message into our standard format
function formatMessage(msg) {
  var headers = msg.payload ? msg.payload.headers : [];
  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: getHeader(headers, 'Subject'),
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    date: getHeader(headers, 'Date'),
    snippet: msg.snippet,
    isRead: msg.labelIds ? msg.labelIds.indexOf('UNREAD') === -1 : true,
    isStarred: msg.labelIds ? msg.labelIds.indexOf('STARRED') !== -1 : false,
    labels: msg.labelIds || [],
    hasAttachments: msg.payload && msg.payload.parts ?
      msg.payload.parts.some(function(p) { return p.filename && p.filename.length > 0; }) : false
  };
}

function extractBodyFromPayload(payload) {
  if (!payload) {
    return { body: '', bodyType: 'text/plain' };
  }

  if (payload.body && payload.body.data) {
    return {
      body: Buffer.from(payload.body.data, 'base64url').toString('utf8'),
      bodyType: payload.mimeType || 'text/plain'
    };
  }

  if (!payload.parts || payload.parts.length === 0) {
    return { body: '', bodyType: payload.mimeType || 'text/plain' };
  }

  var preferred = findBestPayloadPart(payload.parts);
  if (!preferred || !preferred.body || !preferred.body.data) {
    return { body: '', bodyType: payload.mimeType || 'text/plain' };
  }

  return {
    body: Buffer.from(preferred.body.data, 'base64url').toString('utf8'),
    bodyType: preferred.mimeType || 'text/plain'
  };
}

function findBestPayloadPart(parts) {
  var flat = flattenPayloadParts(parts);
  return (
    flat.find(function(part) { return part.mimeType === 'text/plain' && part.body && part.body.data; })
    || flat.find(function(part) { return part.mimeType === 'text/html' && part.body && part.body.data; })
    || flat.find(function(part) { return part.body && part.body.data; })
    || null
  );
}

function flattenPayloadParts(parts) {
  var flat = [];
  (parts || []).forEach(function(part) {
    flat.push(part);
    if (Array.isArray(part.parts) && part.parts.length > 0) {
      flat = flat.concat(flattenPayloadParts(part.parts));
    }
  });
  return flat;
}

function mapThreadMessage(msg) {
  var headers = msg.payload ? msg.payload.headers : [];
  var extracted = extractBodyFromPayload(msg.payload);
  return {
    id: msg.id,
    subject: getHeader(headers, 'Subject'),
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc'),
    date: getHeader(headers, 'Date'),
    preview: msg.snippet || '',
    body: extracted.body,
    bodyType: extracted.bodyType
  };
}

async function fetchThreadMessages(threadId) {
  var thread = await callGmail('/threads/' + threadId + '?format=full');
  var messages = (thread.messages || [])
    .map(mapThreadMessage)
    .sort(function(a, b) {
      return new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime();
    });
  return messages;
}

function captureReadinessShadow(threadId, subject, messages) {
  try {
    var shadow = readinessShadow.captureShadowCandidate({
      sourceMailbox: MAILBOX,
      sourceProvider: 'gmail_api',
      threadId: threadId,
      subject: subject,
      messages: messages
    });

    if (shadow.emitted) {
      console.log('[gmail-reader] readiness shadow captured: ' + shadow.eventType + ' ' + shadow.id);
    }
  } catch (err) {
    console.error('[gmail-reader] readiness shadow error:', err.message);
  }
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

function uniq(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function ensureActionBusDirs() {
  fs.mkdirSync(ACTION_REQUEST_DIR, { recursive: true });
  fs.mkdirSync(ACTION_RESPONSE_DIR, { recursive: true });
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  var tempFile = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, filePath);
}

function sanitizeRequestId(value, fallback) {
  var raw = String(value || '').trim();
  var cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || ((fallback || 'gmail-action') + '-' + Date.now());
}

function actionResponsePathForRequest(requestId) {
  return path.join(ACTION_RESPONSE_DIR, sanitizeRequestId(requestId, 'gmail-action') + '.json');
}

function isStableFile(filePath) {
  var stat = fs.statSync(filePath);
  return Date.now() - stat.mtimeMs >= ACTION_REQUEST_STABILITY_MS;
}

function listPendingRequestFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(function(name) { return name.endsWith('.json'); })
    .map(function(name) { return path.join(dir, name); })
    .filter(function(filePath) {
      try {
        return isStableFile(filePath);
      } catch (_) {
        return false;
      }
    })
    .sort(function(a, b) { return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs; });
}

function cleanupOldActionBusFiles() {
  var cutoff = Date.now() - ACTION_FILE_TTL_MS;
  [ACTION_REQUEST_DIR, ACTION_RESPONSE_DIR].forEach(function(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(function(name) {
      var filePath = path.join(dir, name);
      try {
        var stat = fs.statSync(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      } catch (_) {
        // best effort cleanup
      }
    });
  });
}

function maybeCleanupActionBus() {
  if (Date.now() - lastActionCleanupAt < 60000) return;
  cleanupOldActionBusFiles();
  lastActionCleanupAt = Date.now();
}

function writeActionResponse(data, options) {
  var requestId = options && options.requestId;
  var legacy = options && options.legacy;
  var payload = requestId ? Object.assign({}, data, { requestId: requestId }) : data;
  if (requestId) {
    writeJsonAtomic(actionResponsePathForRequest(requestId), payload);
  }
  if (legacy || !requestId) {
    writeJsonAtomic(LEGACY_ACTION_RESULT_FILE, payload);
  }
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
    history_winner_reason: resolution.history_winner_reason || null
  };
}

function buildActionSuccessPayload(request, result) {
  var payload = {
    success: true,
    action: request.action,
    provider: 'gmail',
    mailbox: MAILBOX,
    result: result,
    completedAt: new Date().toISOString()
  };

  if (request.requested_at) {
    payload.requestedAt = request.requested_at;
  }

  if (Array.isArray(request.to) || Array.isArray(request.cc)) {
    payload.requestedRecipients = {
      to: Array.isArray(request.to) ? request.to.slice() : [],
      cc: Array.isArray(request.cc) ? request.cc.slice() : []
    };
  }

  if (request.recipientResolution) {
    payload.recipientResolution = request.recipientResolution;
    payload.recipientResolutionSummary = summarizeRecipientResolution(request.recipientResolution);
  }

  return payload;
}

function buildActionErrorPayload(request, err) {
  var payload = {
    success: false,
    action: request && request.action ? request.action : null,
    provider: 'gmail',
    mailbox: MAILBOX,
    error: err.message,
    completedAt: new Date().toISOString()
  };

  if (request && request.requested_at) {
    payload.requestedAt = request.requested_at;
  }

  return payload;
}

function parseContactHeaderValue(value) {
  return String(value || '')
    .split(',')
    .map(function(part) { return part.trim(); })
    .filter(Boolean)
    .map(function(part) {
      var match = part.match(/^(.*?)(?:<([^>]+)>)?$/);
      if (!match) {
        return { name: null, email: null };
      }
      var email = (match[2] || match[1] || '').trim().toLowerCase();
      var name = match[2] ? match[1].trim().replace(/^"|"$/g, '') : null;
      return {
        name: name || null,
        email: email || null
      };
    })
    .filter(function(contact) { return contact.email; });
}

function isInternalEmail(email) {
  var normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return true;
  if (INTERNAL_EMAILS.indexOf(normalized) !== -1) return true;
  return INTERNAL_DOMAINS.some(function(domain) {
    return normalized.endsWith('@' + domain);
  });
}

function laterTimestamp(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function extractThreadRecipients(messages, providerScore) {
  var scored = new Map();

  for (var index = 0; index < messages.length; index += 1) {
    var message = messages[index];
    var isLatest = index === messages.length - 1;
    var isRecent = index >= messages.length - 2;
    [message.from, message.to, message.cc]
      .flatMap(parseContactHeaderValue)
      .filter(function(contact) {
        return contact.email && !isInternalEmail(contact.email);
      })
      .forEach(function(contact) {
        var key = contact.email.toLowerCase();
        var current = scored.get(key) || {
          name: contact.name,
          email: contact.email,
          score: 0,
          last_seen: message.date || null
        };

        current.name = current.name || contact.name || null;
        current.score += providerScore + (isLatest ? 4 : (isRecent ? 2 : 1));
        current.last_seen = laterTimestamp(current.last_seen, message.date || null);
        scored.set(key, current);
      });
  }

  return Array.from(scored.values()).sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.last_seen || 0).getTime() - new Date(a.last_seen || 0).getTime();
  });
}

function computeRecencyBoost(dateValue) {
  var lastSeen = new Date(dateValue || 0).getTime();
  if (!lastSeen) return 0;
  var daysAgo = (Date.now() - lastSeen) / (24 * 60 * 60 * 1000);
  if (daysAgo <= 30) return 18;
  if (daysAgo <= 90) return 12;
  if (daysAgo <= 365) return 6;
  return 0;
}

function scoreThreadCandidate(candidate) {
  var normalizedSubject = normalizeSearchText(candidate.subject);
  var score = 0;

  (candidate.matchedAliases || []).forEach(function(alias) {
    var normalizedAlias = normalizeSearchText(alias);
    if (!normalizedAlias) return;
    if (normalizedSubject === normalizedAlias) {
      score += 40;
    } else if (normalizedSubject.indexOf(normalizedAlias) !== -1) {
      score += 24;
    } else {
      score += 12;
    }
  });

  score += Math.min(15, (candidate.hitCount || 0) * 3);
  score += Math.min(12, (candidate.messageCount || 0) * 2);
  score += Math.min(15, (candidate.recipientCount || 0) * 3);
  score += computeRecencyBoost(candidate.lastDate);
  return score;
}

function confidenceFromScore(score) {
  return Math.max(0.25, Math.min(0.92, score / 100));
}

function summarizeWinnerReason(candidate) {
  var reasons = [];
  if ((candidate.matchedAliases || []).length > 0) {
    reasons.push('subject matched ' + candidate.matchedAliases.join(', '));
  }
  if (candidate.recipientCount > 0) {
    reasons.push(candidate.recipientCount + ' external recipient(s)');
  }
  if (candidate.lastDate) {
    reasons.push('last seen ' + candidate.lastDate);
  }
  return reasons.join('; ');
}

async function fetchMessageMetadata(messageId) {
  return callGmail(
    '/messages/' + messageId +
    '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date'
  );
}

async function searchMessageIds(query, maxResults) {
  var encodedQuery = encodeURIComponent(query);
  var data = await callGmail('/messages?maxResults=' + (maxResults || 10) + '&q=' + encodedQuery);
  return data.messages || [];
}

async function fetchThreadMetadata(threadId) {
  var thread = await callGmail(
    '/threads/' + threadId +
    '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date'
  );

  return (thread.messages || []).map(function(msg) {
    var headers = msg.payload ? msg.payload.headers : [];
    return {
      id: msg.id,
      threadId: msg.threadId,
      subject: getHeader(headers, 'Subject'),
      from: getHeader(headers, 'From'),
      to: getHeader(headers, 'To'),
      cc: getHeader(headers, 'Cc'),
      date: getHeader(headers, 'Date')
    };
  }).sort(function(a, b) {
    return new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime();
  });
}

function buildMailboxHistoryAliases(request) {
  var aliases = []
    .concat(request && request.search ? [request.search] : [])
    .concat(Array.isArray(request && request.aliases) ? request.aliases : [])
    .map(normalizeSearchText)
    .filter(Boolean);

  return uniq(aliases);
}

function buildParticipantQuery(request) {
  var participants = Array.isArray(request && request.participants)
    ? request.participants
    : [];
  var filters = participants
    .map(function(value) { return String(value || '').trim().toLowerCase(); })
    .filter(function(email) { return email && !isInternalEmail(email); })
    .map(function(email) {
      return '(from:' + email + ' OR to:' + email + ' OR cc:' + email + ')';
    });

  return filters.length > 0 ? '(' + filters.join(' OR ') + ')' : '';
}

async function searchMailboxHistory(request, options) {
  var deps = options || {};
  var searchIds = deps.searchMessageIds || searchMessageIds;
  var getMessageMetadata = deps.fetchMessageMetadata || fetchMessageMetadata;
  var getThreadMetadata = deps.fetchThreadMetadata || fetchThreadMetadata;
  var aliases = buildMailboxHistoryAliases(request);
  var participantQuery = buildParticipantQuery(request);
  var threadMap = new Map();

  for (var aliasIndex = 0; aliasIndex < aliases.length; aliasIndex += 1) {
    var alias = aliases[aliasIndex];
    var query = 'in:anywhere subject:"' + alias.replace(/"/g, '') + '"';
    if (participantQuery) {
      query += ' ' + participantQuery;
    }

    var hits = await searchIds(query, 10);
    for (var hitIndex = 0; hitIndex < hits.length; hitIndex += 1) {
      var message = await getMessageMetadata(hits[hitIndex].id);
      var subject = normalizeSearchText(getHeader(message.payload ? message.payload.headers : [], 'Subject'));
      var key = message.threadId;
      var current = threadMap.get(key) || {
        threadId: message.threadId,
        subject: getHeader(message.payload ? message.payload.headers : [], 'Subject'),
        matchedAliases: [],
        hitCount: 0,
        lastDate: getHeader(message.payload ? message.payload.headers : [], 'Date')
      };

      current.subject = current.subject || getHeader(message.payload ? message.payload.headers : [], 'Subject');
      current.matchedAliases = uniq(current.matchedAliases.concat(alias));
      current.hitCount += 1;
      current.lastDate = laterTimestamp(current.lastDate, getHeader(message.payload ? message.payload.headers : [], 'Date'));
      if (!subject && current.subject) {
        current.subject = current.subject;
      }
      threadMap.set(key, current);
    }
  }

  var preliminary = Array.from(threadMap.values())
    .sort(function(a, b) {
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      return new Date(b.lastDate || 0).getTime() - new Date(a.lastDate || 0).getTime();
    })
    .slice(0, 5);

  var candidates = [];
  for (var index = 0; index < preliminary.length; index += 1) {
    var seed = preliminary[index];
    var messages = await getThreadMetadata(seed.threadId);
    var candidate = {
      threadId: seed.threadId,
      subject: seed.subject || (messages[0] ? messages[0].subject : null),
      matchedAliases: seed.matchedAliases,
      hitCount: seed.hitCount,
      lastDate: laterTimestamp(seed.lastDate, messages.length > 0 ? messages[messages.length - 1].date : null),
      messages: messages,
      messageCount: messages.length
    };
    candidate.recipients = extractThreadRecipients(messages, 1);
    candidate.recipientCount = candidate.recipients.length;
    candidate.score = scoreThreadCandidate(candidate);
    candidates.push(candidate);
  }

  candidates.sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.lastDate || 0).getTime() - new Date(a.lastDate || 0).getTime();
  });

  var winner = candidates[0] || null;
  return {
    provider: 'gmail',
    mailbox: MAILBOX,
    found_in: 'mailbox_history',
    aliases_tried: aliases,
    confidence: winner ? confidenceFromScore(winner.score) : 0,
    matched_thread_subjects: uniq(candidates.map(function(candidate) { return candidate.subject; }).filter(Boolean)),
    matched_recipients: winner ? winner.recipients.map(function(recipient) { return recipient.email; }) : [],
    recipients: winner
      ? winner.recipients.map(function(recipient) {
          return {
            name: recipient.name,
            email: recipient.email,
            found_in: 'mailbox_history',
            provider: 'gmail',
            mailbox: MAILBOX,
            last_seen: recipient.last_seen
          };
        })
      : [],
    candidates: candidates.map(function(candidate) {
      return {
        threadId: candidate.threadId,
        subject: candidate.subject,
        matched_aliases: candidate.matchedAliases,
        score: candidate.score,
        message_count: candidate.messageCount,
        last_seen: candidate.lastDate,
        matched_recipients: candidate.recipients.map(function(recipient) { return recipient.email; })
      };
    }),
    winner_reason: winner ? summarizeWinnerReason(winner) : null
  };
}

// ============================================================
// INBOX SYNC
// ============================================================

async function syncInboxToFile() {
  try {
    // Get the list of message IDs in the inbox
    var listData = await callGmail('/messages?maxResults=20&labelIds=INBOX');
    var messages = listData.messages || [];

    // Fetch each message's details (metadata only, not full body)
    var detailed = [];
    for (var i = 0; i < messages.length; i++) {
      var msg = await callGmail('/messages/' + messages[i].id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date');
      detailed.push(formatMessage(msg));
    }

    // Get unread count from inbox label
    var labelData = await callGmail('/labels/INBOX');

    var output = {
      mailbox: MAILBOX,
      fetchedAt: new Date().toISOString(),
      unread: labelData.messagesUnread || 0,
      total: labelData.messagesTotal || 0,
      recentCount: detailed.length,
      messages: detailed
    };

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'inbox.json'),
      JSON.stringify(output, null, 2)
    );
    console.log('[gmail-reader] synced ' + detailed.length + ' messages to inbox.json (' + (labelData.messagesUnread || 0) + ' unread)');
  } catch (err) {
    console.error('[gmail-reader] sync error:', err.message);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'inbox.json'),
      JSON.stringify({ error: err.message, fetchedAt: new Date().toISOString() }, null, 2)
    );
  }
}

// ============================================================
// ARCHIVE - In Gmail, archiving means removing the INBOX label
// ============================================================

async function archiveMessage(messageId) {
  var result = await callGmail('/messages/' + messageId + '/modify', 'POST', {
    removeLabelIds: ['INBOX']
  });
  console.log('[gmail-reader] archived message: ' + messageId.substring(0, 20) + '...');
  return result;
}

// ============================================================
// STAR / UNSTAR - Gmail's equivalent of flagging
// ============================================================

async function starMessage(messageId, starred) {
  var body = starred ?
    { addLabelIds: ['STARRED'] } :
    { removeLabelIds: ['STARRED'] };
  var result = await callGmail('/messages/' + messageId + '/modify', 'POST', body);
  console.log('[gmail-reader] ' + (starred ? 'starred' : 'unstarred') + ' message: ' + messageId.substring(0, 20) + '...');
  return result;
}

// ============================================================
// LABEL - Gmail's equivalent of categorizing
// Gmail uses labels instead of categories. Users can create
// custom labels and apply multiple labels to a message.
// ============================================================

async function labelMessage(messageId, addLabels, removeLabels) {
  var body = {};
  if (addLabels && addLabels.length > 0) body.addLabelIds = addLabels;
  if (removeLabels && removeLabels.length > 0) body.removeLabelIds = removeLabels;
  var result = await callGmail('/messages/' + messageId + '/modify', 'POST', body);
  console.log('[gmail-reader] updated labels on message: ' + messageId.substring(0, 20) + '...');
  return result;
}

function normalizeLineEndings(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeMimeText(value) {
  return normalizeLineEndings(value).replace(/\n/g, '\r\n');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function textToHtml(text) {
  return '<div>' + escapeHtml(normalizeLineEndings(text)).replace(/\n/g, '<br>\r\n') + '</div>';
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

function encodeHeader(value) {
  return String(value || '').replace(/\r?\n/g, ' ').trim();
}

function resolveDraftBodies(draft) {
  var hasHtml = typeof draft.bodyHtml === 'string' && draft.bodyHtml.trim();
  var isHtmlBody = (draft.bodyType || '').toLowerCase() === 'html';
  var bodyHtml = hasHtml
    ? sanitizeEmailHtml(draft.bodyHtml)
    : isHtmlBody
      ? sanitizeEmailHtml(draft.body || '')
      : '';
  var bodyText = typeof draft.bodyText === 'string'
    ? draft.bodyText
    : bodyHtml
      ? htmlToText(bodyHtml)
      : (draft.body || '');
  if (!bodyHtml && bodyText) {
    bodyHtml = textToHtml(bodyText);
  }
  return {
    bodyText: normalizeLineEndings(bodyText),
    bodyHtml: bodyHtml
  };
}

function buildRawDraftMessage(draft) {
  var bodies = resolveDraftBodies(draft || {});
  var hasExplicitHtml = Boolean(
    (typeof draft.bodyHtml === 'string' && draft.bodyHtml.trim()) ||
    (draft.bodyType || '').toLowerCase() === 'html'
  );
  var lines = [];
  lines.push('To: ' + (draft.to || []).map(encodeHeader).join(', '));
  if (draft.cc && draft.cc.length > 0) {
    lines.push('Cc: ' + draft.cc.map(encodeHeader).join(', '));
  }
  lines.push('Subject: ' + encodeHeader(draft.subject || ''));
  lines.push('MIME-Version: 1.0');

  if (hasExplicitHtml) {
    var boundary = 'openclaw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    lines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    lines.push('');
    lines.push('--' + boundary);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(normalizeMimeText(bodies.bodyText));
    lines.push('--' + boundary);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(bodies.bodyHtml);
    lines.push('--' + boundary + '--');
    return lines.join('\r\n');
  }

  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(normalizeMimeText(bodies.bodyText));
  return lines.join('\r\n');
}

// List all available labels (so Stitch knows what labels exist)
async function listLabels() {
  var result = await callGmail('/labels');
  return result.labels || [];
}

// ============================================================
// DRAFT - Create a draft email (NOT sent)
// ============================================================

async function createDraft(draft) {
  // Gmail drafts require a base64url-encoded RFC 2822 message
  var rawMessage = buildRawDraftMessage(draft || {});
  // Base64url encode the message (replace + with -, / with _, remove =)
  var encoded = Buffer.from(rawMessage).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  var result = await callGmail('/drafts', 'POST', {
    message: { raw: encoded }
  });
  console.log('[gmail-reader] created draft: ' + (draft.subject || '(no subject)'));
  return result;
}

// ============================================================
// FILE-BASED ACTION SYSTEM (same pattern as Microsoft mail reader)
// ============================================================

function createActionHandlers() {
  return {
    archive: async function(request) {
      return { responseResult: await archiveMessage(request.messageId) };
    },
    star: async function(request) {
      return { responseResult: await starMessage(request.messageId, request.starred !== false) };
    },
    label: async function(request) {
      return { responseResult: await labelMessage(request.messageId, request.addLabels, request.removeLabels) };
    },
    draft: async function(request) {
      return { responseResult: await createDraft(request) };
    },
    labels: async function() {
      return { responseResult: await listLabels() };
    }
  };
}

async function processActionRequest(request, options) {
  var requestId = options && options.requestId;
  var legacy = options && options.legacy;
  var handlers = (options && options.actionHandlers) || createActionHandlers();
  var handler = handlers[request.action];

  if (!handler) {
    writeActionResponse(buildActionErrorPayload(request, new Error('Unknown action: ' + request.action)), {
      requestId: requestId,
      legacy: legacy
    });
    return;
  }

  console.log('[gmail-reader] action request: ' + request.action + (requestId ? ' [' + requestId + ']' : ''));

  try {
    var outcome = await handler(request);
    writeActionResponse(buildActionSuccessPayload(request, outcome ? outcome.responseResult : null), {
      requestId: requestId,
      legacy: legacy
    });
  } catch (err) {
    console.error('[gmail-reader] action error:', err.message);
    writeActionResponse(buildActionErrorPayload(request, err), {
      requestId: requestId,
      legacy: legacy
    });
  }
}

async function processLegacyActionRequest(actionHandlers) {
  if (!fs.existsSync(LEGACY_ACTION_REQUEST_FILE)) return;
  if (!isStableFile(LEGACY_ACTION_REQUEST_FILE)) return;

  var stat = fs.statSync(LEGACY_ACTION_REQUEST_FILE);
  if (stat.mtimeMs <= lastLegacyActionMtime) return;
  lastLegacyActionMtime = stat.mtimeMs;

  try {
    var raw = fs.readFileSync(LEGACY_ACTION_REQUEST_FILE, 'utf8').trim();
    if (!raw) return;
    var request = JSON.parse(raw);
    var requestId = request.requestId ? sanitizeRequestId(request.requestId, 'gmail-action') : undefined;
    await processActionRequest(request, {
      requestId: requestId,
      legacy: true,
      actionHandlers: actionHandlers
    });
  } finally {
    try {
      fs.unlinkSync(LEGACY_ACTION_REQUEST_FILE);
    } catch (_) {
      // best effort cleanup
    }
  }
}

async function processActionRequestFile(filePath, actionHandlers) {
  var requestId = sanitizeRequestId(path.basename(filePath, '.json'), 'gmail-action');
  try {
    var raw = fs.readFileSync(filePath, 'utf8');
    var request = JSON.parse(raw);
    if (request.requestId && sanitizeRequestId(request.requestId, 'gmail-action') !== requestId) {
      throw new Error('requestId mismatch between filename and payload');
    }
    await processActionRequest(request, {
      requestId: requestId,
      legacy: false,
      actionHandlers: actionHandlers
    });
  } catch (err) {
    console.error('[gmail-reader] action watcher error:', err.message);
    writeActionResponse({
      success: false,
      action: null,
      error: err.message,
      completedAt: new Date().toISOString()
    }, {
      requestId: requestId,
      legacy: false
    });
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {
      // best effort cleanup
    }
  }
}

async function checkForActionRequest(actionHandlers) {
  if (actionWatcherBusy) return;
  actionWatcherBusy = true;

  try {
    ensureActionBusDirs();
    maybeCleanupActionBus();

    await listPendingRequestFiles(ACTION_REQUEST_DIR).reduce(function(promise, filePath) {
      return promise.then(function() {
        return processActionRequestFile(filePath, actionHandlers);
      });
    }, Promise.resolve());
    await processLegacyActionRequest(actionHandlers);
  } finally {
    actionWatcherBusy = false;
  }
}

function watchForActionRequest() {
  var actionHandlers = createActionHandlers();
  setInterval(function() {
    checkForActionRequest(actionHandlers).catch(function(err) {
      console.error('[gmail-reader] action watcher error:', err.message);
    });
  }, ACTION_POLL_INTERVAL_MS);
}

// ============================================================
// TRIGGER AND DETAIL WATCHERS (same pattern as Microsoft)
// ============================================================

function watchForTrigger() {
  var triggerFile = path.join(OUTPUT_DIR, 'trigger.txt');
  setInterval(function() {
    if (fs.existsSync(triggerFile)) {
      console.log('[gmail-reader] trigger detected, syncing...');
      fs.unlinkSync(triggerFile);
      syncInboxToFile();
    }
  }, 2000);
}

function watchForDetailRequest() {
  var requestFile = path.join(OUTPUT_DIR, 'detail-request.txt');
  setInterval(async function() {
    if (fs.existsSync(requestFile)) {
      try {
        var messageId = fs.readFileSync(requestFile, 'utf8').trim();
        console.log('[gmail-reader] detail request for message: ' + messageId.substring(0, 20) + '...');
        fs.unlinkSync(requestFile);

        // Fetch full message with body
        var msg = await callGmail('/messages/' + messageId + '?format=full');
        var headers = msg.payload ? msg.payload.headers : [];
        var extracted = extractBodyFromPayload(msg.payload);
        var body = extracted.body;
        var bodyType = extracted.bodyType;
        var shadowMessages;

        var output = {
          id: msg.id,
          threadId: msg.threadId,
          subject: getHeader(headers, 'Subject'),
          from: getHeader(headers, 'From'),
          to: getHeader(headers, 'To'),
          cc: getHeader(headers, 'Cc'),
          date: getHeader(headers, 'Date'),
          body: body,
          bodyType: bodyType,
          isRead: msg.labelIds ? msg.labelIds.indexOf('UNREAD') === -1 : true,
          isStarred: msg.labelIds ? msg.labelIds.indexOf('STARRED') !== -1 : false,
          labels: msg.labelIds || [],
          hasAttachments: msg.payload && msg.payload.parts ?
            msg.payload.parts.some(function(p) { return p.filename && p.filename.length > 0; }) : false,
          fetchedAt: new Date().toISOString()
        };

        try {
          shadowMessages = await fetchThreadMessages(msg.threadId);
        } catch (shadowErr) {
          console.error('[gmail-reader] readiness thread fetch error:', shadowErr.message);
          shadowMessages = [output];
        }

        captureReadinessShadow(msg.threadId, output.subject, shadowMessages);

        fs.writeFileSync(
          path.join(OUTPUT_DIR, 'message-detail.json'),
          JSON.stringify(output, null, 2)
        );
        console.log('[gmail-reader] wrote message detail: ' + getHeader(headers, 'Subject'));
      } catch (err) {
        console.error('[gmail-reader] detail error:', err.message);
        fs.writeFileSync(
          path.join(OUTPUT_DIR, 'message-detail.json'),
          JSON.stringify({ error: err.message, fetchedAt: new Date().toISOString() }, null, 2)
        );
      }
    }
  }, 2000);
}

// ============================================================
// HTTP ENDPOINTS (for testing from terminal with curl)
// ============================================================

app.get('/health', function(req, res) {
  res.json({
    status: tokenData.refreshToken ? 'ok' : 'needs_authorization',
    mailbox: MAILBOX,
    authorized: !!tokenData.refreshToken,
    authUrl: tokenData.refreshToken ? null : 'http://localhost:' + PORT + '/oauth/start'
  });
});

app.get('/mail', async function(req, res) {
  try {
    var listData = await callGmail('/messages?maxResults=10&labelIds=INBOX');
    var messages = listData.messages || [];
    var detailed = [];
    for (var i = 0; i < messages.length; i++) {
      var msg = await callGmail('/messages/' + messages[i].id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date');
      detailed.push(formatMessage(msg));
    }
    res.json({ count: detailed.length, messages: detailed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/sync', async function(req, res) {
  await syncInboxToFile();
  res.json({ status: 'synced' });
});

app.post('/archive', async function(req, res) {
  try {
    var result = await archiveMessage(req.body.messageId);
    await syncInboxToFile();
    res.json({ success: true, result: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/star', async function(req, res) {
  try {
    var result = await starMessage(req.body.messageId, req.body.starred !== false);
    res.json({ success: true, result: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/label', async function(req, res) {
  try {
    var result = await labelMessage(req.body.messageId, req.body.addLabels, req.body.removeLabels);
    res.json({ success: true, result: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/labels', async function(req, res) {
  try {
    var labels = await listLabels();
    res.json({ labels: labels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/draft', async function(req, res) {
  try {
    var result = await createDraft(req.body);
    res.json({ success: true, id: result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/mailbox-history', async function(req, res) {
  try {
    var result = await searchMailboxHistory(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// STARTUP
// ============================================================

function start() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET');
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', function() {
    console.log('[gmail-reader] listening on port ' + PORT + ' for ' + MAILBOX);
    console.log('[gmail-reader] output dir: ' + OUTPUT_DIR);

    // Try to load a saved refresh token
    var hasToken = loadSavedToken();

    if (hasToken) {
      // We have a refresh token — start syncing
      syncInboxToFile();
      setInterval(syncInboxToFile, 5 * 60 * 1000);
      watchForTrigger();
      watchForDetailRequest();
      watchForActionRequest();
    } else {
      // No refresh token — need one-time authorization
      console.log('[gmail-reader] *** NOT YET AUTHORIZED ***');
      console.log('[gmail-reader] Visit http://localhost:' + PORT + '/oauth/start to authorize');
      // Still start the watchers so they're ready after authorization
      watchForTrigger();
      watchForDetailRequest();
      watchForActionRequest();
    }
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  start: start,
  __test: {
    sanitizeRequestId: sanitizeRequestId,
    actionResponsePathForRequest: actionResponsePathForRequest,
    buildMailboxHistoryAliases: buildMailboxHistoryAliases,
    extractThreadRecipients: extractThreadRecipients,
    scoreThreadCandidate: scoreThreadCandidate,
    searchMailboxHistory: searchMailboxHistory,
    sanitizeEmailHtml: sanitizeEmailHtml,
    htmlToText: htmlToText,
    buildRawDraftMessage: buildRawDraftMessage,
    processActionRequest: processActionRequest,
    processActionRequestFile: processActionRequestFile,
    checkForActionRequest: checkForActionRequest
  }
};
