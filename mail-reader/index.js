var express = require('express');
var crypto = require('crypto');
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

// Parse JSON request bodies for POST/PATCH endpoints
app.use(express.json());

var TENANT_ID = process.env.MS_TENANT_ID;
var CLIENT_ID = process.env.MS_CLIENT_ID;
var CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
var MAILBOX = process.env.MS_MAILBOX || 'stitch@prestigiocustom.com';
var OUTPUT_DIR = process.env.MAIL_OUTPUT_DIR || '/mail-output';
var LEGACY_ACTION_REQUEST_FILE = path.join(OUTPUT_DIR, 'action-request.json');
var LEGACY_ACTION_RESULT_FILE = path.join(OUTPUT_DIR, 'action-result.json');
var LEGACY_THREAD_DETAIL_FILE = path.join(OUTPUT_DIR, 'thread-detail.json');
var ACTION_REQUEST_DIR = path.join(OUTPUT_DIR, 'action-requests');
var ACTION_RESPONSE_DIR = path.join(OUTPUT_DIR, 'action-responses');
var THREAD_DETAIL_DIR = path.join(OUTPUT_DIR, 'thread-details');
var ACTION_POLL_INTERVAL_MS = 1000;
var ACTION_REQUEST_STABILITY_MS = 250;
var ACTION_FILE_TTL_MS = 24 * 60 * 60 * 1000;
var ATTACHMENTS_DIR = path.join(OUTPUT_DIR, 'attachments');
var MAX_ATTACHMENT_BYTES = Number(process.env.MAIL_ATTACHMENT_MAX_BYTES || 25 * 1024 * 1024);
var MAX_MESSAGE_ATTACHMENT_BYTES = Number(process.env.MAIL_ATTACHMENT_MAX_TOTAL_BYTES || 75 * 1024 * 1024);
var ALLOWED_ATTACHMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg'
];
var ALLOWED_ATTACHMENT_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg'];
var DATA_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*["']data:(image\/(?:png|jpe?g));base64,([^"']+)["'][^>]*>/gi;

// ============================================================
// FORWARD WHITELIST — security boundary for forwarding
// Only these addresses can receive forwarded emails.
// The code rejects any address not on this list, regardless
// of what the model writes to action-request.json.
// ============================================================

var FORWARD_WHITELIST = [
  'diana@prestigiocustom.com'
];
var INTERNAL_REPLY_DOMAINS = ['prestigiocustom.com'];
var INTERNAL_REPLY_EMAILS = [
  'stitch@prestigiocustom.com',
  'chris@prestigiocustom.com',
  'chris91744@gmail.com'
];

var tokenCache = { token: null, expiresAt: 0 };
var lastLegacyActionMtime = 0;
var actionWatcherBusy = false;
var lastActionCleanupAt = 0;

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 300000) {
    return tokenCache.token;
  }
  var url = 'https://login.microsoftonline.com/' + TENANT_ID + '/oauth2/v2.0/token';
  var params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  var response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!response.ok) {
    throw new Error('Token failed: ' + response.status + ' ' + (await response.text()));
  }
  var data = await response.json();
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  };
  return tokenCache.token;
}

// Extended callGraph: supports GET, POST, PATCH, and DELETE
// Handles 202 Accepted (forward) and 204 No Content (move/update)
async function callGraph(endpoint, method, body) {
  var token = await getAccessToken();
  var options = {
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  };
  // Attach request body for POST and PATCH requests
  if (body && (method === 'POST' || method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }
  var response = await fetch('https://graph.microsoft.com/v1.0' + endpoint, options);
  // 202 Accepted (forward) and 204 No Content (move, update) — no body to parse
  if (response.status === 202 || response.status === 204) {
    return { success: true };
  }
  if (!response.ok) {
    throw new Error('Graph API: ' + response.status + ' ' + (await response.text()));
  }
  return response.json();
}

async function callGraphRaw(endpoint, method) {
  var token = await getAccessToken();
  var response = await fetch('https://graph.microsoft.com/v1.0' + endpoint, {
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + token
    }
  });
  if (!response.ok) {
    throw new Error('Graph API: ' + response.status + ' ' + (await response.text()));
  }
  return response;
}

// Convert plain text to simple HTML: escape entities, newlines to <br>
function textToHtml(text) {
  var escaped = (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>\n');
  return '<div>' + escaped + '</div>';
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

function resolveDraftBodyHtml(draft) {
  if (typeof draft.bodyHtml === 'string' && draft.bodyHtml.trim()) {
    return sanitizeEmailHtml(draft.bodyHtml);
  }
  if ((draft.bodyType || '').toLowerCase() === 'html') {
    return sanitizeEmailHtml(draft.body || '');
  }
  if (typeof draft.bodyText === 'string') {
    return textToHtml(draft.bodyText);
  }
  return textToHtml(draft.body);
}

// Email signature for chris@ mailbox only
var CHRIS_SIGNATURE = '<br><br>' +
  '<div style="color:#333;font-size:14px;line-height:1.6;">' +
  'Chris<br>' +
  '<b>Prestigio Custom Furniture</b><br>' +
  '<span style="color:#555;">136 N Ash Ave. Inglewood, CA 90301</span><br>' +
  '<span style="color:#555;">C: 626.224.1421</span>' +
  '</div>';

function appendSignature(html) {
  if (MAILBOX.toLowerCase().indexOf('chris@') !== 0) return html;
  return html + CHRIS_SIGNATURE;
}

function formatFrom(msg) {
  if (msg.from && msg.from.emailAddress) {
    if (msg.from.emailAddress.name) {
      return msg.from.emailAddress.name + ' <' + msg.from.emailAddress.address + '>';
    }
    return msg.from.emailAddress.address;
  }
  return 'unknown';
}

function formatMessage(msg) {
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    subject: msg.subject,
    from: formatFrom(msg),
    date: msg.receivedDateTime,
    preview: msg.bodyPreview,
    isRead: msg.isRead,
    hasAttachments: msg.hasAttachments
  };
}

// Strip Re:/Fw:/Fwd: prefixes to get the base subject for searching
function baseSubject(subject) {
  return (subject || '').replace(/^(Re|Fw|Fwd|RE|FW|FWD):\s*/gi, '').trim();
}

function normalizeResolverText(value) {
  return baseSubject(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchSubject(value, wordLimit) {
  var cleaned = baseSubject(value)
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';
  if (!wordLimit) return cleaned;
  return cleaned.split(' ').slice(0, wordLimit).join(' ');
}

function uniqueNonEmpty(values) {
  var seen = {};
  return (values || []).filter(function(value) {
    var key = String(value || '').trim();
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function containsNormalizedPhrase(haystack, needle) {
  var normalizedHaystack = ' ' + String(haystack || '').trim() + ' ';
  var normalizedNeedle = ' ' + String(needle || '').trim() + ' ';
  if (!normalizedNeedle.trim()) return false;
  return normalizedHaystack.indexOf(normalizedNeedle) !== -1;
}

var OBJECT_SIGNAL_VOCAB = [
  { canonical: 'sofa', phrases: ['sofa', 'couch'] },
  { canonical: 'ottoman', phrases: ['ottoman'] },
  { canonical: 'coffee_table', phrases: ['coffee table'] },
  { canonical: 'chair', phrases: ['chair'] },
  { canonical: 'armchair', phrases: ['armchair', 'arm chair'] },
  { canonical: 'sectional', phrases: ['sectional'] },
  { canonical: 'banquette', phrases: ['banquette'] },
  { canonical: 'bed', phrases: ['bed'] },
  { canonical: 'bench', phrases: ['bench'] },
  { canonical: 'pillow', phrases: ['pillow', 'pillows'] }
];

var OBJECT_MISMATCH_CANONICALS = [
  'sofa',
  'ottoman',
  'coffee_table',
  'chair',
  'armchair',
  'sectional',
  'banquette',
  'bed',
  'bench'
];

var OBJECT_SIGNAL_COMPATIBILITY = {
  ottoman: { coffee_table: true },
  coffee_table: { ottoman: true },
  chair: { armchair: true },
  armchair: { chair: true }
};

function normalizePhraseList(values) {
  return uniqueNonEmpty((values || []).map(normalizeResolverText).filter(Boolean));
}

function extractObjectSignals(text) {
  var normalized = normalizeResolverText(text);
  var canonicals = {};
  var phrases = {};

  OBJECT_SIGNAL_VOCAB.forEach(function(entry) {
    entry.phrases.forEach(function(phrase) {
      var normalizedPhrase = normalizeResolverText(phrase);
      if (containsNormalizedPhrase(normalized, normalizedPhrase)) {
        canonicals[entry.canonical] = true;
        phrases[normalizedPhrase] = true;
      }
    });
  });

  return {
    canonicals: Object.keys(canonicals),
    phrases: Object.keys(phrases)
  };
}

function buildThreadResolverHints(subject, options) {
  var opts = options || {};
  var normalizedSubject = normalizeResolverText(subject);
  var normalizedContextSubject = normalizeResolverText(opts.contextSubject);
  var normalizedSourceTaskText = normalizeResolverText(opts.sourceTaskText);
  var explicitPreferred = normalizePhraseList(opts.preferredPhrases || []);
  var explicitRequired = normalizePhraseList(opts.requiredTokens || []);
  var explicitForbidden = normalizePhraseList(opts.forbiddenTokens || []);
  var objectSignals = extractObjectSignals(
    [subject, opts.contextSubject, opts.sourceTaskText].filter(Boolean).join(' ')
  );
  var targetObjects = objectSignals.canonicals.filter(function(canonical) {
    return OBJECT_MISMATCH_CANONICALS.indexOf(canonical) !== -1;
  });
  var forbiddenObjects = {};

  targetObjects.forEach(function(target) {
    OBJECT_MISMATCH_CANONICALS.forEach(function(candidate) {
      if (candidate === target) return;
      if (targetObjects.indexOf(candidate) !== -1) return;
      if (OBJECT_SIGNAL_COMPATIBILITY[target] && OBJECT_SIGNAL_COMPATIBILITY[target][candidate]) return;
      forbiddenObjects[candidate] = true;
    });
  });

  return {
    normalizedSubject: normalizedSubject,
    normalizedContextSubject: normalizedContextSubject,
    normalizedSourceTaskText: normalizedSourceTaskText,
    preferredPhrases: uniqueNonEmpty(
      explicitPreferred
        .concat(objectSignals.phrases)
        .concat(normalizedSubject ? [normalizedSubject] : [])
        .concat(normalizedContextSubject ? [normalizedContextSubject] : [])
    ),
    requiredTokens: uniqueNonEmpty(explicitRequired.concat(objectSignals.phrases)),
    forbiddenTokens: explicitForbidden,
    targetObjects: targetObjects,
    forbiddenObjects: Object.keys(forbiddenObjects)
  };
}

function buildThreadSearchQueries(subject, hints) {
  var queries = [];

  function push(value, wordLimit) {
    var normalized = normalizeSearchSubject(value, wordLimit);
    if (normalized) queries.push(normalized);
  }

  push(subject, 6);
  push(subject, 12);
  push(hints.normalizedContextSubject, 12);
  (hints.preferredPhrases || []).slice(0, 4).forEach(function(phrase) {
    push(phrase, phrase.split(' ').length <= 3 ? 3 : 6);
  });
  (hints.requiredTokens || []).slice(0, 4).forEach(function(token) {
    push(token, token.split(' ').length <= 3 ? 3 : 6);
  });

  return uniqueNonEmpty(queries);
}

async function searchMessagesBySubjectQueries(queries) {
  var messageMap = {};

  for (var i = 0; i < queries.length; i += 1) {
    var query = queries[i];
    if (!query) continue;
    var data = await callGraph(
      '/users/' + MAILBOX + '/messages' +
      '?$search="' + encodeURIComponent(query) + '"' +
      '&$top=50' +
      '&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,hasAttachments'
    );

    (data.value || []).forEach(function(msg) {
      messageMap[msg.id] = msg;
    });
  }

  return Object.keys(messageMap).map(function(id) { return messageMap[id]; });
}

function normalizedCandidateBody(messages) {
  return normalizeResolverText(messages.map(function(msg) {
    return stripQuotedContent(msg.body ? msg.body.content : '', msg.body ? msg.body.contentType : '');
  }).join(' '));
}

function buildThreadCandidate(conversationId, rawMessages, hints) {
  var messages = rawMessages.slice().sort(function(a, b) {
    return new Date(a.receivedDateTime) - new Date(b.receivedDateTime);
  });
  var latest = messages[messages.length - 1] || null;
  var subjectVariants = uniqueNonEmpty(messages.map(function(msg) { return msg.subject || ''; }));
  var normalizedSubjects = uniqueNonEmpty(subjectVariants.map(normalizeResolverText).filter(Boolean));
  var combinedSubjectText = normalizedSubjects.join(' ');
  var combinedBodyText = normalizedCandidateBody(messages);
  var candidateSignals = extractObjectSignals(combinedSubjectText + ' ' + combinedBodyText);
  var score = 0;
  var matchedPreferredPhrases = [];
  var matchedRequiredTokens = [];
  var missingRequiredTokens = [];
  var matchedObjects = [];
  var conflictingObjects = [];
  var latestSubject = normalizeResolverText(latest ? latest.subject : '');
  var exactSubjectMatch = hints.normalizedSubject && normalizedSubjects.indexOf(hints.normalizedSubject) !== -1;
  var exactLatestSubjectMatch = hints.normalizedSubject && latestSubject === hints.normalizedSubject;
  var exactContextSubjectMatch = hints.normalizedContextSubject && normalizedSubjects.indexOf(hints.normalizedContextSubject) !== -1;

  if (exactSubjectMatch) score += 180;
  if (exactLatestSubjectMatch) score += 220;
  if (exactContextSubjectMatch) score += 120;

  (hints.preferredPhrases || []).forEach(function(phrase) {
    if (!phrase) return;
    var matched = normalizedSubjects.some(function(subject) {
      return subject === phrase || containsNormalizedPhrase(subject, phrase);
    });
    if (matched) {
      matchedPreferredPhrases.push(phrase);
      score += phrase === hints.normalizedSubject ? 110 : 40;
      return;
    }
    if (phrase.length >= 6 && containsNormalizedPhrase(combinedBodyText, phrase)) {
      matchedPreferredPhrases.push(phrase);
      score += 18;
    }
  });

  (hints.requiredTokens || []).forEach(function(token) {
    var matched = containsNormalizedPhrase(combinedSubjectText, token) || containsNormalizedPhrase(combinedBodyText, token);
    if (matched) {
      matchedRequiredTokens.push(token);
      score += 26;
    } else {
      missingRequiredTokens.push(token);
      score -= 34;
    }
  });

  (hints.targetObjects || []).forEach(function(target) {
    if (candidateSignals.canonicals.indexOf(target) !== -1) {
      matchedObjects.push(target);
      score += 36;
    }
  });

  candidateSignals.canonicals.forEach(function(candidate) {
    if ((hints.forbiddenObjects || []).indexOf(candidate) !== -1) {
      conflictingObjects.push(candidate);
      score -= 90;
    }
  });

  (hints.forbiddenTokens || []).forEach(function(token) {
    if (containsNormalizedPhrase(combinedSubjectText, token) || containsNormalizedPhrase(combinedBodyText, token)) {
      score -= 60;
    }
  });

  var latestDateMs = latest ? new Date(latest.receivedDateTime || 0).getTime() : 0;
  var daysAgo = latestDateMs ? Math.max(0, (Date.now() - latestDateMs) / (24 * 60 * 60 * 1000)) : 365;
  if (daysAgo <= 7) score += 8;
  else if (daysAgo <= 30) score += 5;
  else if (daysAgo <= 90) score += 2;

  score += Math.min(2, messages.length * 0.35);

  return {
    conversationId: conversationId,
    anchorMessageId: latest ? latest.id : null,
    latestDate: latest ? latest.receivedDateTime : null,
    latestSubject: latest ? latest.subject : null,
    subjects: subjectVariants,
    normalizedSubjects: normalizedSubjects,
    messageCount: messages.length,
    score: Number(score.toFixed(2)),
    exactSubjectMatch: Boolean(exactSubjectMatch),
    exactLatestSubjectMatch: Boolean(exactLatestSubjectMatch),
    exactContextSubjectMatch: Boolean(exactContextSubjectMatch),
    matchedPreferredPhrases: matchedPreferredPhrases,
    matchedRequiredTokens: matchedRequiredTokens,
    missingRequiredTokens: missingRequiredTokens,
    matchedObjects: matchedObjects,
    conflictingObjects: conflictingObjects
  };
}

function compareThreadCandidates(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  var rightTime = new Date(right.latestDate || 0).getTime();
  var leftTime = new Date(left.latestDate || 0).getTime();
  if (rightTime !== leftTime) return rightTime - leftTime;
  return right.messageCount - left.messageCount;
}

function isThreadCandidateConfident(best, runnerUp, hints) {
  if (!best) return false;
  if (best.exactLatestSubjectMatch) return true;
  if (best.exactSubjectMatch && (!runnerUp || !runnerUp.exactSubjectMatch || (best.score - runnerUp.score) >= 20)) {
    return true;
  }
  if (
    hints.requiredTokens.length > 0 &&
    best.missingRequiredTokens.length === 0 &&
    best.conflictingObjects.length === 0 &&
    (!runnerUp || runnerUp.missingRequiredTokens.length > 0 || (best.score - runnerUp.score) >= 16)
  ) {
    return true;
  }
  if (best.conflictingObjects.length > 0) return false;
  if (best.score >= 120 && (!runnerUp || (best.score - runnerUp.score) >= 24)) return true;
  return false;
}

function buildAmbiguityMessage(requestedSubject, candidates) {
  var top = (candidates || []).slice(0, 2).map(function(candidate) {
    return candidate.latestSubject || candidate.subjects[0] || 'untitled thread';
  });

  if (top.length >= 2) {
    return 'I found two likely threads for "' + requestedSubject + '": ' + top[0] + ' and ' + top[1] + '.';
  }
  if (top.length === 1) {
    return 'I found a possible thread for "' + requestedSubject + '" but it was not confident enough to open safely.';
  }
  return 'I could not find a confident thread match for "' + requestedSubject + '".';
}

function selectThreadCandidate(threads, hints, requestedSubject) {
  var candidates = Object.keys(threads).map(function(conversationId) {
    return buildThreadCandidate(conversationId, threads[conversationId], hints);
  }).sort(compareThreadCandidates);

  if (candidates.length === 0) {
    return { status: 'empty', candidates: [] };
  }

  var best = candidates[0];
  var runnerUp = candidates[1];
  if (isThreadCandidateConfident(best, runnerUp, hints)) {
    return { status: 'selected', candidate: best, candidates: candidates };
  }

  if (runnerUp && Math.abs(best.score - runnerUp.score) < 20) {
    return {
      status: 'ambiguous',
      message: buildAmbiguityMessage(requestedSubject, candidates),
      candidates: candidates.slice(0, 3)
    };
  }

  if (!runnerUp && best.conflictingObjects.length === 0 && best.score >= 70) {
    return { status: 'selected', candidate: best, candidates: candidates };
  }

  return {
    status: 'ambiguous',
    message: buildAmbiguityMessage(requestedSubject, candidates),
    candidates: candidates.slice(0, 3)
  };
}

function formatSubjectFetchMessages(messages) {
  return messages.map(function(msg) {
    return {
      id: msg.id,
      subject: msg.subject,
      from: msg.from,
      to: msg.to,
      cc: msg.cc,
      date: msg.date,
      preview: msg.preview,
      body: stripQuotedContent(msg.body || '', msg.bodyType || ''),
      bodyType: 'text',
      isRead: msg.isRead,
      hasAttachments: msg.hasAttachments
    };
  });
}

function normalizeGraphThreadMessages(rawMessages) {
  return (rawMessages || [])
    .slice()
    .sort(function(a, b) { return new Date(a.receivedDateTime) - new Date(b.receivedDateTime); })
    .map(function(msg) {
      return {
        id: msg.id,
        subject: msg.subject,
        from: formatFrom(msg),
        to: msg.toRecipients ? msg.toRecipients.map(function(r) { return r.emailAddress.address; }) : [],
        cc: msg.ccRecipients ? msg.ccRecipients.map(function(r) { return r.emailAddress.address; }) : [],
        date: msg.receivedDateTime,
        preview: msg.bodyPreview,
        body: msg.body ? msg.body.content : '',
        bodyType: msg.body ? msg.body.contentType : '',
        isRead: msg.isRead,
        hasAttachments: msg.hasAttachments
      };
    });
}

function buildAmbiguousThreadResult(subject, selection) {
  return {
    ambiguous: true,
    requestedSubject: subject,
    subject: subject,
    messageCount: 0,
    messages: [],
    candidates: (selection.candidates || []).map(function(candidate) {
      return {
        conversationId: candidate.conversationId,
        subject: candidate.latestSubject || candidate.subjects[0] || subject,
        messageCount: candidate.messageCount,
        latestDate: candidate.latestDate,
        score: candidate.score,
        matched_required_tokens: candidate.matchedRequiredTokens,
        conflicting_objects: candidate.conflictingObjects,
        matched_preferred_phrases: candidate.matchedPreferredPhrases
      };
    }),
    ambiguityMessage: selection.message,
    fetchedAt: new Date().toISOString()
  };
}

function captureReadinessShadow(messages, threadId, subject) {
  try {
    var shadow = readinessShadow.captureShadowCandidate({
      sourceMailbox: MAILBOX,
      sourceProvider: 'microsoft_graph',
      threadId: threadId,
      subject: subject,
      messages: messages
    });

    if (shadow.emitted) {
      console.log('[mail-reader] readiness shadow captured: ' + shadow.eventType + ' ' + shadow.id);
    }
  } catch (err) {
    console.error('[mail-reader] readiness shadow error:', err.message);
  }
}

function ensureActionBusDirs() {
  fs.mkdirSync(ACTION_REQUEST_DIR, { recursive: true });
  fs.mkdirSync(ACTION_RESPONSE_DIR, { recursive: true });
  fs.mkdirSync(THREAD_DETAIL_DIR, { recursive: true });
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
  return cleaned || ((fallback || 'mail-action') + '-' + Date.now());
}

function sanitizeFileName(value, fallback) {
  var raw = String(value || '').trim();
  var base = raw.split(/[\\/]/).pop() || fallback || 'attachment';
  base = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  if (!base || base === '.' || base === '..') {
    return fallback || 'attachment';
  }
  return base;
}

function ensureUniqueFilePath(dir, fileName) {
  var parsed = path.parse(fileName);
  var candidate = path.join(dir, fileName);
  var counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, parsed.name + '-' + counter + parsed.ext);
    counter += 1;
  }
  return candidate;
}

function isAllowedAttachment(attachment) {
  var contentType = String(attachment.contentType || '').toLowerCase();
  var extension = path.extname(String(attachment.name || '')).toLowerCase();
  return ALLOWED_ATTACHMENT_CONTENT_TYPES.indexOf(contentType) !== -1 ||
    ALLOWED_ATTACHMENT_EXTENSIONS.indexOf(extension) !== -1;
}

function fileSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extensionForContentType(contentType) {
  var normalized = String(contentType || '').toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'application/pdf') return '.pdf';
  return '';
}

function saveDownloadedAttachment(params) {
  var fileName = sanitizeFileName(params.name, params.fallbackName || 'attachment');
  var ext = path.extname(fileName);
  if (!ext) {
    fileName += extensionForContentType(params.contentType);
  }
  var filePath = ensureUniqueFilePath(params.outputDir, fileName);
  fs.writeFileSync(filePath, params.buffer, { mode: 0o600 });
  return {
    id: params.id || null,
    name: path.basename(filePath),
    originalName: params.originalName || params.name || null,
    contentType: String(params.contentType || '').toLowerCase() || null,
    size: params.buffer.length,
    sha256: fileSha256(params.buffer),
    path: filePath,
    isInline: params.isInline === true,
    contentId: params.contentId || null,
    source: params.source || 'attachment'
  };
}

async function downloadDataUriImagesFromBody(messageId, outputDir, totalBytes, graph) {
  var downloaded = [];
  var skipped = [];
  var message;
  try {
    message = await graph(
      '/users/' + MAILBOX + '/messages/' + encodeURIComponent(messageId) + '?$select=body'
    );
  } catch (err) {
    return {
      downloaded: downloaded,
      skipped: [{
        id: null,
        name: null,
        contentType: null,
        size: null,
        reason: 'body_fetch_failed',
        detail: err.message
      }],
      totalBytes: totalBytes
    };
  }

  var body = message && message.body && message.body.content ? String(message.body.content) : '';
  var match;
  var index = 1;
  DATA_IMAGE_RE.lastIndex = 0;
  while ((match = DATA_IMAGE_RE.exec(body)) !== null) {
    var contentType = String(match[1] || '').toLowerCase();
    var rawBase64 = String(match[2] || '').replace(/\s+/g, '');
    var buffer;
    try {
      buffer = Buffer.from(rawBase64, 'base64');
    } catch (err) {
      skipped.push({
        id: null,
        name: 'inline-image-' + index,
        contentType: contentType,
        size: null,
        reason: 'invalid_data_uri_image'
      });
      index += 1;
      continue;
    }
    if (buffer.length > MAX_ATTACHMENT_BYTES || totalBytes + buffer.length > MAX_MESSAGE_ATTACHMENT_BYTES) {
      skipped.push({
        id: null,
        name: 'inline-image-' + index,
        contentType: contentType,
        size: buffer.length,
        reason: 'downloaded_size_limit'
      });
      index += 1;
      continue;
    }
    downloaded.push(saveDownloadedAttachment({
      id: null,
      name: 'inline-image-' + index + extensionForContentType(contentType),
      fallbackName: 'inline-image-' + index,
      contentType: contentType,
      buffer: buffer,
      outputDir: outputDir,
      isInline: true,
      source: 'body_data_uri'
    }));
    totalBytes += buffer.length;
    index += 1;
  }

  return {
    downloaded: downloaded,
    skipped: skipped,
    totalBytes: totalBytes
  };
}

function actionResponsePathForRequest(requestId) {
  return path.join(ACTION_RESPONSE_DIR, sanitizeRequestId(requestId, 'mail-action') + '.json');
}

function threadDetailPathForRequest(requestId) {
  return path.join(THREAD_DETAIL_DIR, sanitizeRequestId(requestId, 'mail-thread') + '.json');
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
  [ACTION_REQUEST_DIR, ACTION_RESPONSE_DIR, THREAD_DETAIL_DIR].forEach(function(dir) {
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

function writeThreadDetail(detail, options) {
  var requestId = options && options.requestId;
  var legacy = options && options.legacy;
  if (requestId) {
    writeJsonAtomic(threadDetailPathForRequest(requestId), detail);
  }
  if (legacy || !requestId) {
    writeJsonAtomic(LEGACY_THREAD_DETAIL_FILE, detail);
  }
}

function summarizeRecipientResolution(resolution) {
  if (!resolution || typeof resolution !== 'object') {
    return null;
  }

  var provider = resolution.provider || 'unknown';
  var source = resolution.found_in || 'unknown';
  var confidence = typeof resolution.confidence === 'number'
    ? Number(resolution.confidence.toFixed(2))
    : null;

  return {
    found_in: source,
    provider: provider,
    mailbox: resolution.mailbox || null,
    confidence: confidence,
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
  var responseResult = result;
  var payload = {
    success: true,
    action: request.action,
    provider: 'microsoft',
    mailbox: MAILBOX,
    completedAt: new Date().toISOString()
  };

  if (result && typeof result === 'object' && result.__openclawReplyRecipientGuard) {
    payload.replyRecipientGuard = result.__openclawReplyRecipientGuard;
    responseResult = Object.assign({}, result);
    delete responseResult.__openclawReplyRecipientGuard;
  }

  payload.result = responseResult;

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
    provider: 'microsoft',
    mailbox: MAILBOX,
    error: err.message,
    completedAt: new Date().toISOString()
  };

  if (request && request.requested_at) {
    payload.requestedAt = request.requested_at;
  }

  return payload;
}

function normalizeActionName(action) {
  var value = String(action || '').trim();
  if (!value) return value;
  return value.replace(/_/g, '-');
}

async function downloadMessageAttachments(messageId, options) {
  var id = String(messageId || '').trim();
  if (!id) {
    throw new Error('download_attachments requires messageId');
  }

  var graph = options && options.callGraph ? options.callGraph : callGraph;
  var graphRaw = options && options.callGraphRaw ? options.callGraphRaw : callGraphRaw;
  var outputRoot = options && options.outputDir ? options.outputDir : ATTACHMENTS_DIR;
  var safeMessageId = sanitizeRequestId(id, 'message');
  var outputDir = path.join(outputRoot, safeMessageId);
  var attachmentList = await graph(
    '/users/' + MAILBOX + '/messages/' + encodeURIComponent(id) + '/attachments?$select=id,name,contentType,size,isInline'
  );
  var attachments = Array.isArray(attachmentList.value) ? attachmentList.value : [];
  var downloaded = [];
  var skipped = [];
  var totalBytes = 0;

  fs.mkdirSync(outputDir, { recursive: true });

  for (var i = 0; i < attachments.length; i += 1) {
    var attachment = attachments[i];
    var attachmentId = attachment.id;
    var name = sanitizeFileName(attachment.name, 'attachment-' + (i + 1));
    var size = Number(attachment.size || 0);
    var contentType = String(attachment.contentType || '').toLowerCase();
    var reason = null;

    if (!attachmentId) {
      reason = 'missing_attachment_id';
    } else if (!isAllowedAttachment(attachment)) {
      reason = 'unsupported_content_type';
    } else if (size > MAX_ATTACHMENT_BYTES) {
      reason = 'attachment_too_large';
    } else if (totalBytes + size > MAX_MESSAGE_ATTACHMENT_BYTES) {
      reason = 'message_attachment_limit';
    }

    if (reason) {
      skipped.push({
        id: attachmentId || null,
        name: name,
        contentType: contentType || null,
        size: size || null,
        reason: reason
      });
      continue;
    }

    var detail = await graph(
      '/users/' + MAILBOX + '/messages/' + encodeURIComponent(id) + '/attachments/' + encodeURIComponent(attachmentId)
    );
    if (detail['@odata.type'] && detail['@odata.type'] !== '#microsoft.graph.fileAttachment') {
      skipped.push({
        id: attachmentId,
        name: name,
        contentType: contentType || null,
        size: size || null,
        reason: 'not_file_attachment'
      });
      continue;
    }

    var buffer;
    if (detail.contentBytes) {
      buffer = Buffer.from(detail.contentBytes, 'base64');
    } else {
      var response = await graphRaw(
        '/users/' + MAILBOX + '/messages/' + encodeURIComponent(id) + '/attachments/' + encodeURIComponent(attachmentId) + '/$value'
      );
      buffer = Buffer.from(await response.arrayBuffer());
    }

    if (buffer.length > MAX_ATTACHMENT_BYTES || totalBytes + buffer.length > MAX_MESSAGE_ATTACHMENT_BYTES) {
      skipped.push({
        id: attachmentId,
        name: name,
        contentType: contentType || null,
        size: buffer.length,
        reason: 'downloaded_size_limit'
      });
      continue;
    }

    totalBytes += buffer.length;
    downloaded.push(saveDownloadedAttachment({
      id: attachmentId,
      name: name,
      originalName: attachment.name || null,
      contentType: contentType || null,
      buffer: buffer,
      outputDir: outputDir,
      isInline: attachment.isInline === true,
      contentId: detail.contentId || attachment.contentId || null,
      source: attachment.isInline ? 'inline_attachment' : 'attachment'
    }));
  }

  var bodyImages = await downloadDataUriImagesFromBody(id, outputDir, totalBytes, graph);
  downloaded = downloaded.concat(bodyImages.downloaded);
  skipped = skipped.concat(bodyImages.skipped);
  totalBytes = bodyImages.totalBytes;

  return {
    messageId: id,
    outputDir: outputDir,
    totalBytes: totalBytes,
    attachments: downloaded,
    skipped: skipped,
    downloadedAt: new Date().toISOString()
  };
}

function createActionHandlers() {
  return {
    archive: async function(request) {
      return { responseResult: await archiveMessage(request.messageId) };
    },
    flag: async function(request) {
      return { responseResult: await flagMessage(request.messageId, request.flagStatus) };
    },
    categorize: async function(request) {
      return { responseResult: await categorizeMessage(request.messageId, request.categories) };
    },
    draft: async function(request) {
      return { responseResult: await createDraft(request) };
    },
    reply: async function(request) {
      return { responseResult: await createReplyDraftWithDeps(
        request.messageId,
        request.body,
        request.cc,
        { callGraph: callGraph },
        {
          bodyText: request.bodyText,
          bodyHtml: request.bodyHtml,
          bodyType: request.bodyType
        }
      ) };
    },
    forward: async function(request) {
      return { responseResult: await forwardMessage(request.messageId, request.to, request.comment) };
    },
    'fetch-thread': async function(request) {
      var detail = await fetchThread(request.messageId);
      return {
        responseResult: {
          messageCount: detail.messageCount,
          subject: detail.subject,
          conversationId: detail.conversationId
        },
        threadDetail: detail
      };
    },
    'fetch-thread-by-subject': async function(request) {
      var detail = await fetchThreadBySubject(request.subject, request);
      return {
        responseResult: {
          ambiguous: Boolean(detail.ambiguous),
          ambiguityMessage: detail.ambiguityMessage || null,
          candidates: detail.candidates || null,
          messageCount: detail.messageCount,
          subject: detail.subject,
          conversationId: detail.conversationId || null
        },
        threadDetail: detail
      };
    },
    'download-attachments': async function(request) {
      return { responseResult: await downloadMessageAttachments(request.messageId) };
    }
  };
}

// ============================================================
// INBOX SYNC
// Pulls messages from the Inbox folder, filters to Focused
// only (skips Other tab noise like OneDrive, DMARC, etc.),
// and writes the result to inbox.json for Stitch to read.
// ============================================================

async function syncInboxToFile() {
  try {
    // Pull 100 messages so we have enough after filtering out "other"
    var data = await callGraph(
      '/users/' + MAILBOX + '/mailFolders/inbox/messages?$top=100' +
      '&$orderby=receivedDateTime desc' +
      '&$select=id,conversationId,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,inferenceClassification'
    );

    // Filter to focused messages only, keep up to 50
    var focused = data.value.filter(function(msg) { return msg.inferenceClassification === 'focused'; });
    var messages = focused.slice(0, 50);

    var unreadData = await callGraph(
      '/users/' + MAILBOX + '/mailFolders/inbox?$select=unreadItemCount,totalItemCount'
    );

    var output = {
      mailbox: MAILBOX,
      fetchedAt: new Date().toISOString(),
      unread: unreadData.unreadItemCount,
      total: unreadData.totalItemCount,
      recentCount: messages.length,
      messages: messages.map(formatMessage)
    };

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'inbox.json'),
      JSON.stringify(output, null, 2)
    );
    console.log('[mail-reader] synced ' + messages.length + ' messages to inbox.json (' + unreadData.unreadItemCount + ' unread)');
  } catch (err) {
    console.error('[mail-reader] sync error:', err.message);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'inbox.json'),
      JSON.stringify({ error: err.message, fetchedAt: new Date().toISOString() }, null, 2)
    );
  }
}

// ============================================================
// ARCHIVE - moves a message from inbox to the archive folder
// ============================================================

async function archiveMessage(messageId) {
  var result = await callGraph(
    '/users/' + MAILBOX + '/messages/' + messageId + '/move',
    'POST',
    { destinationId: 'archive' }
  );
  console.log('[mail-reader] archived message: ' + messageId.substring(0, 30) + '...');
  return result;
}

// ============================================================
// FLAG - set or remove a flag on a message
// Flag values: "flagged", "notFlagged", "complete"
// ============================================================

async function flagMessage(messageId, flagStatus) {
  var validFlags = ['flagged', 'notFlagged', 'complete'];
  if (validFlags.indexOf(flagStatus) === -1) {
    throw new Error('Invalid flag status. Must be one of: ' + validFlags.join(', '));
  }
  var result = await callGraph(
    '/users/' + MAILBOX + '/messages/' + messageId,
    'PATCH',
    { flag: { flagStatus: flagStatus } }
  );
  console.log('[mail-reader] flagged message as ' + flagStatus + ': ' + messageId.substring(0, 30) + '...');
  return result;
}

// ============================================================
// CATEGORIZE - add or replace categories on a message
// Categories are string labels like "Urgent", "Follow Up", etc.
// ============================================================

async function categorizeMessage(messageId, categories) {
  if (!Array.isArray(categories)) {
    throw new Error('Categories must be an array of strings');
  }
  var result = await callGraph(
    '/users/' + MAILBOX + '/messages/' + messageId,
    'PATCH',
    { categories: categories }
  );
  console.log('[mail-reader] categorized message as [' + categories.join(', ') + ']: ' + messageId.substring(0, 30) + '...');
  return result;
}

// ============================================================
// DRAFT - create a new draft email in the Drafts folder
// Does NOT send it. Chris must review and send manually.
// ============================================================

async function createDraft(draft) {
  var bodyHtml = resolveDraftBodyHtml(draft || {});
  var message = {
    subject: draft.subject || '',
    body: {
      contentType: 'HTML',
      content: appendSignature(bodyHtml)
    },
    toRecipients: (draft.to || []).map(function(addr) {
      return { emailAddress: { address: addr } };
    })
  };
  if (draft.cc && draft.cc.length > 0) {
    message.ccRecipients = draft.cc.map(function(addr) {
      return { emailAddress: { address: addr } };
    });
  }
  if (draft.conversationId) {
    message.conversationId = draft.conversationId;
  }
  var result = await callGraph(
    '/users/' + MAILBOX + '/messages',
    'POST',
    message
  );
  console.log('[mail-reader] created draft: ' + (draft.subject || '(no subject)'));
  return result;
}

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function isInternalReplyEmail(address) {
  var normalized = normalizeAddress(address);
  if (!normalized) return true;
  if (normalized === normalizeAddress(MAILBOX)) return true;
  if (INTERNAL_REPLY_EMAILS.indexOf(normalized) !== -1) return true;
  return INTERNAL_REPLY_DOMAINS.some(function(domain) {
    return normalized.endsWith('@' + domain);
  });
}

function graphRecipientList(recipients) {
  return Array.isArray(recipients) ? recipients : [];
}

function graphRecipientAddresses(recipients) {
  return graphRecipientList(recipients)
    .map(function(recipient) {
      return normalizeAddress(recipient && recipient.emailAddress && recipient.emailAddress.address);
    })
    .filter(Boolean);
}

function mergeCcRecipients(existingCcRecipients, requestedCc, excludedAddresses) {
  var merged = [];
  var seen = {};
  var excluded = {};

  (excludedAddresses || []).forEach(function(address) {
    var normalized = normalizeAddress(address);
    if (normalized) excluded[normalized] = true;
  });

  graphRecipientList(existingCcRecipients).forEach(function(recipient) {
    var address = normalizeAddress(recipient && recipient.emailAddress && recipient.emailAddress.address);
    if (!address || excluded[address] || seen[address]) return;
    seen[address] = true;
    merged.push(recipient);
  });

  (requestedCc || []).forEach(function(address) {
    var normalized = normalizeAddress(address);
    if (!normalized || excluded[normalized] || seen[normalized]) return;
    seen[normalized] = true;
    merged.push({
      emailAddress: {
        address: normalized
      }
    });
  });

  return merged;
}

function collectExternalReplyRecipients(fields) {
  var recipientMap = {};

  (fields || []).forEach(function(field) {
    graphRecipientAddresses(field).forEach(function(address) {
      if (!isInternalReplyEmail(address)) {
        recipientMap[address] = true;
      }
    });
  });

  return Object.keys(recipientMap).sort();
}

function buildReplyRecipientGuard(anchorMessage, replyDraft) {
  var expected = collectExternalReplyRecipients([
    anchorMessage && anchorMessage.replyTo,
    anchorMessage && anchorMessage.from ? [anchorMessage.from] : [],
    anchorMessage && anchorMessage.toRecipients,
    anchorMessage && anchorMessage.ccRecipients
  ]);
  var actual = collectExternalReplyRecipients([
    replyDraft && replyDraft.toRecipients,
    replyDraft && replyDraft.ccRecipients
  ]);

  if (expected.length <= 1 || actual.length >= expected.length) {
    return null;
  }

  return {
    status: 'narrowed',
    message: 'Reply-all draft returned fewer external recipients than the source thread suggests.',
    expected_external_recipients: expected,
    actual_external_recipients: actual,
    expected_external_count: expected.length,
    actual_external_count: actual.length
  };
}

async function createReplyDraftWithDeps(messageId, body, cc, deps, bodyOptions) {
  var graph = deps && deps.callGraph ? deps.callGraph : callGraph;
  var anchor = await graph(
    '/users/' + MAILBOX + '/messages/' + messageId +
    '?$select=id,subject,from,replyTo,toRecipients,ccRecipients'
  );

  // Reply-all is the safe default for multi-party client threads.
  var reply = await graph(
    '/users/' + MAILBOX + '/messages/' + messageId + '/createReplyAll',
    'POST'
  );

  var mergedCcRecipients = mergeCcRecipients(
    reply && reply.ccRecipients,
    cc,
    graphRecipientAddresses(reply && reply.toRecipients)
  );
  var updates = {
    body: {
      contentType: 'HTML',
      content: appendSignature(resolveDraftBodyHtml(Object.assign({}, bodyOptions || {}, { body: body })))
    }
  };
  if (mergedCcRecipients.length > 0) {
    updates.ccRecipients = mergedCcRecipients;
  }

  var result = await graph(
    '/users/' + MAILBOX + '/messages/' + reply.id,
    'PATCH',
    updates
  );
  if (!result || result.success === true) {
    result = Object.assign({}, reply, {
      body: updates.body
    });
    if (mergedCcRecipients.length > 0) {
      result.ccRecipients = mergedCcRecipients;
    }
  }
  var guard = buildReplyRecipientGuard(anchor, result);
  if (guard) {
    console.warn('[mail-reader] reply-all recipient guard for ' + messageId.substring(0, 30) + '... expected ' + guard.expected_external_count + ' external recipient(s) but got ' + guard.actual_external_count);
    result = Object.assign({}, result, {
      __openclawReplyRecipientGuard: guard
    });
  }
  console.log('[mail-reader] created reply-all draft to: ' + messageId.substring(0, 30) + '...');
  return result;
}

// ============================================================
// REPLY - create a reply draft that stays in the same thread
// Uses the Graph API's createReplyAll endpoint so threading
// headers (In-Reply-To, References) are set automatically.
// The draft appears inside the original conversation in all
// mail clients (Outlook, Spark, Gmail, etc.)
// ============================================================

async function createReplyDraft(messageId, body, cc) {
  return createReplyDraftWithDeps(messageId, body, cc, { callGraph: callGraph });
}

// ============================================================
// FORWARD - forward a message to a whitelisted recipient
// Uses Graph API's /forward endpoint which preserves all
// original attachments (PDFs, images, etc.) automatically.
// The comment field is prepended above the forwarded content.
//
// SECURITY: Only addresses in FORWARD_WHITELIST are allowed.
// Any other address is rejected at the code level, regardless
// of what the model requests.
// ============================================================

async function forwardMessage(messageId, to, comment) {
  // Validate recipient against whitelist
  var normalizedTo = (to || '').toLowerCase().trim();
  if (!normalizedTo) {
    throw new Error('Forward requires a "to" address');
  }
  if (FORWARD_WHITELIST.indexOf(normalizedTo) === -1) {
    throw new Error('Forward blocked: "' + to + '" is not on the whitelist. Allowed: ' + FORWARD_WHITELIST.join(', '));
  }

  var body = {
    comment: comment || '',
    toRecipients: [
      { emailAddress: { address: normalizedTo } }
    ]
  };

  var result = await callGraph(
    '/users/' + MAILBOX + '/messages/' + messageId + '/forward',
    'POST',
    body
  );
  console.log('[mail-reader] forwarded message to ' + normalizedTo + ': ' + messageId.substring(0, 30) + '...');
  return result;
}

// ============================================================
// FETCH THREAD - pull all messages in a conversation thread
//
// Graph API NOTE: $filter on conversationId returns InefficientFilter
// error on both /messages and folder-scoped endpoints. The workaround:
//   1. Fetch the anchor message to get its subject + conversationId
//   2. Strip Re:/Fw: prefixes to get the base subject
//   3. Use $search on the base subject — searches across ALL folders
//      (inbox, sent, archive, drafts) automatically
//   4. Filter results client-side by conversationId for accuracy
//   5. Sort chronologically
//
// This correctly finds archived messages (where Chris's emails live
// after GTD processing) that a folder-scoped query would miss.
// ============================================================

async function fetchThread(messageId) {
  // Step 1: Fetch the anchor message to get subject and conversationId.
  // We need both: subject for $search, conversationId to filter results.
  var anchor = await callGraph(
    '/users/' + MAILBOX + '/messages/' + messageId +
    '?$select=id,conversationId,subject,receivedDateTime'
  );

  var conversationId = anchor.conversationId;
  // Sanitize for Graph $search: strip special chars, collapse spaces, take first 6 words.
  // Parentheses, quotes, slashes, dashes etc. all break $search syntax.
  // First 6 words is enough to be unique; conversationId filter handles accuracy.
  var searchSubject = baseSubject(anchor.subject)
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');

  console.log('[mail-reader] fetching thread for subject: "' + searchSubject + '" conversationId: ' + conversationId.substring(0, 30) + '...');

  // Step 2: Search across all folders using the base subject.
  // $search works across inbox, sent, archive, drafts simultaneously.
  // encodeURIComponent handles special characters in subject lines.
  var data = await callGraph(
    '/users/' + MAILBOX + '/messages' +
    '?$search="' + encodeURIComponent(searchSubject) + '"' +
    '&$top=50' +
    '&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,hasAttachments'
  );

  // Step 3: Filter client-side to only messages in this conversation,
  // then sort chronologically oldest-first.
  var messages = normalizeGraphThreadMessages(
    (data.value || []).filter(function(msg) { return msg.conversationId === conversationId; })
  );

  console.log('[mail-reader] fetched thread: ' + messages.length + ' messages for "' + searchSubject + '"');
  captureReadinessShadow(messages, conversationId, anchor.subject);
  return {
    conversationId: conversationId,
    subject: searchSubject,
    messageCount: messages.length,
    messages: messages,
    fetchedAt: new Date().toISOString()
  };
}

// ============================================================
// FETCH THREAD BY SUBJECT - search directly by subject string
// Use this when the messageId is stale (404) but you have the
// subject line from a Todoist task description or other source.
// Graph API messageIds change when emails are moved to archive,
// so stored IDs often go dead. Subject search is more durable.
// ============================================================

function stripQuotedContent(content, contentType) {
  if (!content) return '';
  if (contentType === 'html') {
    // Remove blockquotes (quoted history in Outlook/Apple Mail)
    content = content.replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, '');
    // Remove Gmail quoted reply divs
    content = content.replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*?<\/div>/gi, '');
    // Remove "On [date] ... wrote:" patterns (plain text style)
    content = content.replace(/On .{10,80} wrote:/gi, '');
    // Strip all HTML tags
    content = content.replace(/<[^>]+>/g, ' ');
    // Decode common entities
    content = content
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    // Collapse whitespace
    content = content.replace(/\s+/g, ' ').trim();
  }
  return content;
}

async function fetchThreadBySubject(subject, options) {
  var requestedSubject = baseSubject(subject);
  var hints = buildThreadResolverHints(requestedSubject, options || {});
  var searchQueries = buildThreadSearchQueries(requestedSubject, hints);

  console.log('[mail-reader] fetching thread by subject with queries:', searchQueries.join(' | '));

  var candidateMessages = await searchMessagesBySubjectQueries(searchQueries);

  if (!candidateMessages.length) {
    return {
      subject: requestedSubject,
      messageCount: 0,
      messages: [],
      fetchedAt: new Date().toISOString()
    };
  }

  var threads = {};
  candidateMessages.forEach(function(msg) {
    var cid = msg.conversationId;
    if (!cid) return;
    if (!threads[cid]) threads[cid] = [];
    threads[cid].push(msg);
  });

  var selection = selectThreadCandidate(threads, hints, requestedSubject);
  if (selection.status === 'ambiguous') {
    console.log('[mail-reader] ambiguous thread-by-subject match for "' + requestedSubject + '"');
    return buildAmbiguousThreadResult(requestedSubject, selection);
  }

  if (selection.status !== 'selected' || !selection.candidate || !selection.candidate.anchorMessageId) {
    return {
      subject: requestedSubject,
      messageCount: 0,
      messages: [],
      fetchedAt: new Date().toISOString()
    };
  }

  var selectedRawMessages = threads[selection.candidate.conversationId] || [];
  var bestThread = await fetchThread(selection.candidate.anchorMessageId);
  var messages = formatSubjectFetchMessages(bestThread.messages || []);
  var resolvedSubject = selection.candidate.latestSubject || requestedSubject;

  if (!messages.length && selectedRawMessages.length) {
    console.log('[mail-reader] subject fetch fallback: using candidate messages already found for "' + resolvedSubject + '"');
    messages = formatSubjectFetchMessages(normalizeGraphThreadMessages(selectedRawMessages));
    return {
      conversationId: selection.candidate.conversationId,
      subject: resolvedSubject,
      messageCount: messages.length,
      messages: messages,
      fetchedAt: new Date().toISOString()
    };
  }

  console.log('[mail-reader] fetched thread by subject: ' + messages.length + ' messages for "' + resolvedSubject + '"');
  return {
    conversationId: bestThread.conversationId,
    subject: resolvedSubject,
    messageCount: messages.length,
    messages: messages,
    fetchedAt: new Date().toISOString()
  };
}

// ============================================================
// FILE-BASED ACTION SYSTEM
// Stitch writes a JSON action request, we execute it and write the result
// ============================================================

async function processActionRequest(request, options) {
  var requestId = options && options.requestId;
  var legacy = options && options.legacy;
  var handlers = (options && options.actionHandlers) || createActionHandlers();
  var normalizedAction = normalizeActionName(request && request.action);
  var normalizedRequest = Object.assign({}, request, { action: normalizedAction });
  var handler = handlers[normalizedAction];

  if (!handler) {
    writeActionResponse(buildActionErrorPayload(normalizedRequest, new Error('Unknown action: ' + request.action)), {
      requestId: requestId,
      legacy: legacy
    });
    return;
  }

  console.log('[mail-reader] action request: ' + normalizedAction + (requestId ? ' [' + requestId + ']' : ''));

  try {
    var outcome = await handler(normalizedRequest);
    if (outcome && outcome.threadDetail) {
      writeThreadDetail(outcome.threadDetail, { requestId: requestId, legacy: legacy });
    }
    writeActionResponse(buildActionSuccessPayload(normalizedRequest, outcome ? outcome.responseResult : null), {
      requestId: requestId,
      legacy: legacy
    });
  } catch (err) {
    console.error('[mail-reader] action error:', err.message);
    writeActionResponse(buildActionErrorPayload(normalizedRequest, err), {
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
    var requestId = request.requestId ? sanitizeRequestId(request.requestId, 'mail-action') : undefined;
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
  var requestId = sanitizeRequestId(path.basename(filePath, '.json'), 'mail-action');
  try {
    var raw = fs.readFileSync(filePath, 'utf8');
    var request = JSON.parse(raw);
    if (request.requestId && sanitizeRequestId(request.requestId, 'mail-action') !== requestId) {
      throw new Error('requestId mismatch between filename and payload');
    }
    await processActionRequest(request, {
      requestId: requestId,
      legacy: false,
      actionHandlers: actionHandlers
    });
  } catch (err) {
    console.error('[mail-reader] action watcher error:', err.message);
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
      console.error('[mail-reader] action watcher error:', err.message);
    });
  }, ACTION_POLL_INTERVAL_MS);
}

// ============================================================
// TRIGGER AND DETAIL WATCHERS
// ============================================================

function watchForTrigger() {
  var triggerFile = path.join(OUTPUT_DIR, 'trigger.txt');
  setInterval(function() {
    if (fs.existsSync(triggerFile)) {
      console.log('[mail-reader] trigger detected, syncing...');
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
        console.log('[mail-reader] detail request for message: ' + messageId.substring(0, 30) + '...');
        fs.unlinkSync(requestFile);

        var msg = await callGraph(
          '/users/' + MAILBOX + '/messages/' + messageId +
          '?$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead,hasAttachments'
        );

        var output = {
          id: msg.id,
          conversationId: msg.conversationId,
          subject: msg.subject,
          from: formatFrom(msg),
          to: msg.toRecipients ? msg.toRecipients.map(function(r) { return r.emailAddress.address; }) : [],
          cc: msg.ccRecipients ? msg.ccRecipients.map(function(r) { return r.emailAddress.address; }) : [],
          date: msg.receivedDateTime,
          body: msg.body ? msg.body.content : '',
          bodyType: msg.body ? msg.body.contentType : '',
          isRead: msg.isRead,
          hasAttachments: msg.hasAttachments,
          fetchedAt: new Date().toISOString()
        };

        captureReadinessShadow([output], msg.conversationId, msg.subject);

        fs.writeFileSync(
          path.join(OUTPUT_DIR, 'message-detail.json'),
          JSON.stringify(output, null, 2)
        );
        console.log('[mail-reader] wrote message detail: ' + msg.subject);
      } catch (err) {
        console.error('[mail-reader] detail error:', err.message);
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
  res.json({ status: 'ok', mailbox: MAILBOX });
});

app.get('/mail', async function(req, res) {
  try {
    var data = await callGraph(
      '/users/' + MAILBOX + '/mailFolders/inbox/messages?$top=100' +
      '&$orderby=receivedDateTime desc' +
      '&$select=id,conversationId,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,inferenceClassification'
    );
    var focused = data.value.filter(function(msg) { return msg.inferenceClassification === 'focused'; });
    var messages = focused.slice(0, 50);
    res.json({
      count: messages.length,
      messages: messages.map(formatMessage)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/sync', async function(req, res) {
  await syncInboxToFile();
  res.json({ status: 'synced' });
});

// Archive a message: POST /archive { messageId: "..." }
app.post('/archive', async function(req, res) {
  try {
    var result = await archiveMessage(req.body.messageId);
    await syncInboxToFile();
    res.json({ success: true, result: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Flag a message: POST /flag { messageId: "...", flagStatus: "flagged" }
app.post('/flag', async function(req, res) {
  try {
    var result = await flagMessage(req.body.messageId, req.body.flagStatus);
    res.json({ success: true, result: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Categorize a message: POST /categorize { messageId: "...", categories: ["Urgent"] }
app.post('/categorize', async function(req, res) {
  try {
    var result = await categorizeMessage(req.body.messageId, req.body.categories);
    res.json({ success: true, result: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new draft: POST /draft { subject: "...", body: "...", to: ["addr@example.com"] }
app.post('/draft', async function(req, res) {
  try {
    var result = await createDraft(req.body);
    res.json({ success: true, id: result.id, subject: result.subject });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a reply draft: POST /reply { messageId: "...", body: "reply text", cc: ["optional@example.com"] }
app.post('/reply', async function(req, res) {
  try {
    var result = await createReplyDraftWithDeps(
      req.body.messageId,
      req.body.body,
      req.body.cc,
      { callGraph: callGraph },
      {
        bodyText: req.body.bodyText,
        bodyHtml: req.body.bodyHtml,
        bodyType: req.body.bodyType
      }
    );
    res.json({ success: true, id: result.id, subject: result.subject });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forward a message: POST /forward { messageId: "...", to: "diana@prestigiocustom.com", comment: "Please process" }
// SECURITY: recipient must be on FORWARD_WHITELIST
app.post('/forward', async function(req, res) {
  try {
    var result = await forwardMessage(req.body.messageId, req.body.to, req.body.comment);
    res.json({ success: true, result: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch full thread: POST /thread { messageId: "..." }
// NOTE: accepts messageId (not conversationId) — fetches anchor message
// first to get subject for $search, then filters by conversationId client-side.
app.post('/thread', async function(req, res) {
  try {
    var result = await fetchThread(req.body.messageId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch thread by subject: POST /thread-by-subject { subject: "..." }
// Use when messageId is stale. Searches across all folders by subject.
app.post('/thread-by-subject', async function(req, res) {
  try {
    var result = await fetchThreadBySubject(req.body.subject, req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// STARTUP
// ============================================================

function start() {
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing required env vars: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET');
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', function() {
    console.log('[mail-reader] listening on port ' + PORT + ' for ' + MAILBOX);
    console.log('[mail-reader] output dir: ' + OUTPUT_DIR);
    console.log('[mail-reader] forward whitelist: ' + FORWARD_WHITELIST.join(', '));

    // Initial sync on startup
    syncInboxToFile();

    // Sync every 5 minutes
    setInterval(syncInboxToFile, 5 * 60 * 1000);

    // Watch for bot triggers
    watchForTrigger();
    watchForDetailRequest();
    watchForActionRequest();
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
    threadDetailPathForRequest: threadDetailPathForRequest,
    buildActionSuccessPayload: buildActionSuccessPayload,
    summarizeRecipientResolution: summarizeRecipientResolution,
    textToHtml: textToHtml,
    sanitizeEmailHtml: sanitizeEmailHtml,
    resolveDraftBodyHtml: resolveDraftBodyHtml,
    createDraft: createDraft,
    createReplyDraftWithDeps: createReplyDraftWithDeps,
    buildReplyRecipientGuard: buildReplyRecipientGuard,
    processActionRequest: processActionRequest,
    processActionRequestFile: processActionRequestFile,
    checkForActionRequest: checkForActionRequest,
    buildThreadResolverHints: buildThreadResolverHints,
    buildThreadCandidate: buildThreadCandidate,
    selectThreadCandidate: selectThreadCandidate,
    buildAmbiguousThreadResult: buildAmbiguousThreadResult,
    normalizeGraphThreadMessages: normalizeGraphThreadMessages,
    fetchThreadBySubject: fetchThreadBySubject,
    sanitizeFileName: sanitizeFileName,
    isAllowedAttachment: isAllowedAttachment,
    downloadMessageAttachments: downloadMessageAttachments
  }
};
