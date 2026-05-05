var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var OUTPUT_ROOT = process.env.READINESS_CANDIDATES_DIR || '/readiness-candidates';
var LIVE_EVENT_TYPES = ['drawing_approval', 'drawing_revision', 'client_spec_answer'];

function captureShadowCandidate(input) {
  if (!input || !Array.isArray(input.messages) || input.messages.length === 0) {
    return { emitted: false, reason: 'missing_messages' };
  }

  var candidate = buildCandidate(input);
  if (!candidate) {
    return { emitted: false, reason: 'no_live_signal' };
  }

  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

  var existingPath = findExistingCandidatePath(OUTPUT_ROOT, candidate.id);
  if (existingPath) {
    return {
      emitted: false,
      reason: 'duplicate',
      id: candidate.id,
      filePath: existingPath
    };
  }

  var day = toPacificDate(candidate.created_at);
  var dayDir = path.join(OUTPUT_ROOT, day);
  fs.mkdirSync(dayDir, { recursive: true });

  var filePath = path.join(dayDir, candidate.id + '.json');
  writeJsonAtomic(filePath, candidate);
  writeDailySummary(dayDir, day);

  return {
    emitted: true,
    reason: 'captured',
    id: candidate.id,
    filePath: filePath,
    eventType: candidate.event_type
  };
}

function buildCandidate(input) {
  var normalized = normalizeMessages(input.messages);
  if (normalized.length === 0) return null;

  var latest = normalized[normalized.length - 1];
  var cleanLatestText = latest.cleanBody || latest.preview || '';
  var cleanThreadExcerpt = buildThreadExcerpt(normalized);
  var detection = detectWeekOneReadiness({
    subject: input.subject || latest.subject || '',
    cleanLatestText: cleanLatestText,
    cleanThreadExcerpt: cleanThreadExcerpt
  });

  if (!detection || !LIVE_EVENT_TYPES.includes(detection.eventType)) {
    return null;
  }

  var subject = input.subject || latest.subject || '';
  var normalizedSubject = normalizeSubject(subject);
  var latestTimestamp = latest.date || input.latestTimestamp || new Date().toISOString();
  var sourceThreadKey = buildSourceThreadKey(input, normalizedSubject, latestTimestamp);
  var evidenceText = detection.evidenceText || truncate(cleanLatestText || cleanThreadExcerpt, 500);
  var candidateId = buildCandidateId(input, sourceThreadKey, detection.eventType, evidenceText);

  return {
    id: candidateId,
    created_at: new Date().toISOString(),
    source_mailbox: input.sourceMailbox || null,
    source_provider: input.sourceProvider || null,
    source_thread_key: sourceThreadKey,
    subject: subject,
    normalized_subject: normalizedSubject,
    latest_timestamp: latestTimestamp,
    participants: collectParticipants(normalized),
    event_type: detection.eventType,
    evidence_text: evidenceText,
    clean_latest_text: cleanLatestText,
    clean_thread_excerpt: cleanThreadExcerpt,
    matched_project: null,
    matched_item: null,
    proposed_updates: [],
    confidence: detection.confidence,
    safe_to_auto_write_later: false,
    status: 'shadow_pending',
    todoist_task_ref: input.todoistTaskRef || null
  };
}

function detectWeekOneReadiness(input) {
  var subject = String(input.subject || '');
  var latestText = String(input.cleanLatestText || '');
  var threadExcerpt = String(input.cleanThreadExcerpt || '');
  var threadWideText = [latestText, threadExcerpt].filter(Boolean).join('\n');
  var combinedHint = (subject + '\n' + threadWideText).toLowerCase();
  var latestBody = latestText.toLowerCase();
  var threadBody = threadWideText.toLowerCase();

  var hasDrawingHint = containsAny(combinedHint, ['drawing', 'drawings', 'dfa', 'mock that up']);
  var hasStrongDrawingApproval = containsAny(threadBody, [
    'received the approved dfa',
    'received approved dfa',
    'drawing was just approved',
    'drawings were approved',
    'final approval',
    'signed off',
    'sign off',
    'ok she has approved',
    'client approved',
    'approved it',
    'please proceed',
    'proceed with production',
    'looks good'
  ]);
  var hasRevisionPhrase = containsAny(threadBody, [
    'revised',
    'revise',
    'revision',
    'change order',
    'please change',
    'can you change',
    'update drawing',
    'send revised',
    'redline',
    'markup',
    'please remove',
    'remove the last line item'
  ]);
  var hasSpecKeyword = containsAny(combinedHint, [
    'seam',
    'blind seam',
    'self-welt',
    'self welt',
    'welt',
    'zipper',
    'fill',
    'insert',
    'size',
    'dimension',
    'dimensions',
    'option 1',
    'option 2',
    'gather sample',
    'gather',
    'foam',
    'envelope',
    'spring down'
  ]);
  var hasExplicitChoice = containsAny(threadBody, [
    'please use',
    'use blind seam',
    'use a blind seam',
    'switch to',
    'we prefer',
    'preferred',
    'go with',
    'make it',
    'do a blind seam',
    'self-welt',
    'self welt',
    'french welt removed',
    'remove the french welt',
    'no welt',
    'with zipper',
    'without zipper',
    'keep the size as',
    'size should be',
    'we are okay with the fabric having a contrast in direction',
    'inside of the seat',
    'back of the seat',
    'let’s railroad',
    "let's railroad",
    'gather sample',
    'proceed exactly that way'
  ]);
  var hasOptionSelection = /option\s*[12]\b/.test(threadBody) && containsAny(threadBody, [
    'choose option',
    'selected option',
    'go with option',
    'prefer option',
    'option 1 works',
    'option 2 works',
    'let’s do option',
    "let's do option"
  ]);
  var hasExplicitDimensionDecision = containsDimensionPattern(threadBody) && containsAny(threadBody, [
    'keep the size as',
    'size should be',
    'the size is',
    'size is',
    'dimensions are',
    'railroad and keep the size as'
  ]);
  var hasStructuredSpecAnswer = containsAny(threadBody, [
    'contrast in direction',
    'inside of the seat',
    'non-shiny on the back',
    'start with a 4" gather sample',
    'start with a 4” gather sample',
    'french welt removed',
    'remove the french welt',
    'let’s railroad and keep the size as',
    "let's railroad and keep the size as"
  ]);
  var hasQuestionOnlySpecPrompt = containsAny(threadBody, [
    'could you please confirm',
    'can you please confirm',
    'what size',
    'would you mind confirming',
    'please let me know',
    'which option',
    'can we ensure',
    'could you mock that up',
    'would like us to proceed with either'
  ]);
  var hasStrongSpecAnswer = hasSpecKeyword && (
    hasOptionSelection
    || hasExplicitChoice
    || hasExplicitDimensionDecision
    || hasStructuredSpecAnswer
  ) && !(hasQuestionOnlySpecPrompt && !hasStructuredSpecAnswer && !hasExplicitDimensionDecision && !hasOptionSelection);

  var gratitudeOnly = isGratitudeOnly(latestBody);
  var genericReceipt = isGenericReceipt(latestBody);
  var forwardedOnly = isForwardedOnly(latestText);
  var commercialOnly = containsAny(latestBody, [
    'invoice',
    'revised invoice',
    'quote',
    'check',
    'payment',
    'balance',
    'xero',
    'past due',
    'wire'
  ]) && !hasStrongDrawingApproval && !hasRevisionPhrase && !hasStrongSpecAnswer;

  if (hasStrongSpecAnswer) {
    return {
      eventType: 'client_spec_answer',
      confidence: 0.88,
      evidenceText: findEvidenceText([latestText, threadExcerpt], [
        'use blind seam',
        'self-welt',
        'self welt',
        'remove the french welt',
        'keep the size as',
        'size should be',
        'go with option',
        'choose option',
        'let’s railroad',
        "let's railroad",
        'gather sample',
        'contrast in direction'
      ])
    };
  }

  if (hasRevisionPhrase && hasDrawingHint && !containsAny(threadBody, ['revised invoice'])) {
    return {
      eventType: 'drawing_revision',
      confidence: 0.86,
      evidenceText: findEvidenceText([latestText, threadExcerpt], [
        'revised',
        'revise',
        'change order',
        'please change',
        'can you change',
        'update drawing',
        'send revised',
        'redline',
        'markup',
        'please remove'
      ])
    };
  }

  if (hasStrongDrawingApproval && hasDrawingHint && !gratitudeOnly && !genericReceipt && !forwardedOnly && !commercialOnly) {
    return {
      eventType: 'drawing_approval',
      confidence: 0.9,
      evidenceText: findEvidenceText([latestText, threadExcerpt], [
        'received the approved dfa',
        'received approved dfa',
        'drawing was just approved',
        'drawings were approved',
        'final approval',
        'signed off',
        'client approved',
        'approved it',
        'please proceed',
        'proceed with production',
        'looks good'
      ])
    };
  }

  return null;
}

function normalizeMessages(messages) {
  return messages
    .map(function(message) {
      var body = String(message.body || '');
      var cleanBody = cleanText(body, message.bodyType);
      return {
        id: message.id || null,
        subject: message.subject || '',
        from: message.from || '',
        to: Array.isArray(message.to) ? message.to : splitAddressHeader(message.to),
        cc: Array.isArray(message.cc) ? message.cc : splitAddressHeader(message.cc),
        date: message.date || message.receivedDateTime || null,
        preview: message.preview || message.snippet || '',
        body: body,
        bodyType: (message.bodyType || '').toLowerCase(),
        cleanBody: cleanBody
      };
    })
    .filter(function(message) {
      return message.cleanBody || message.preview || message.subject;
    })
    .sort(function(a, b) {
      return new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime();
    });
}

function buildThreadExcerpt(messages) {
  var excerpt = messages
    .map(function(message) {
      var text = message.cleanBody || message.preview || '';
      if (!text) return '';
      return [message.from, text].filter(Boolean).join(': ');
    })
    .filter(Boolean)
    .join('\n\n');

  return truncate(excerpt, 6000);
}

function collectParticipants(messages) {
  var participants = [];
  messages.forEach(function(message) {
    [message.from].concat(message.to || [], message.cc || []).forEach(function(entry) {
      var value = String(entry || '').trim();
      if (!value) return;
      if (participants.indexOf(value) === -1) {
        participants.push(value);
      }
    });
  });
  return participants;
}

function buildSourceThreadKey(input, normalizedSubject, latestTimestamp) {
  var parts = [
    input.sourceMailbox || 'unknown-mailbox',
    input.sourceProvider || 'unknown-provider',
    input.threadId || normalizedSubject || 'unknown-thread',
    latestTimestamp || 'unknown-timestamp'
  ];
  return parts.join('::');
}

function buildCandidateId(input, sourceThreadKey, eventType, evidenceText) {
  var hash = crypto.createHash('sha256');
  hash.update(String(input.sourceMailbox || ''));
  hash.update('\n');
  hash.update(String(input.sourceProvider || ''));
  hash.update('\n');
  hash.update(String(sourceThreadKey || ''));
  hash.update('\n');
  hash.update(String(eventType || ''));
  hash.update('\n');
  hash.update(String(evidenceText || ''));
  return 'rc_' + hash.digest('hex').slice(0, 20);
}

function findExistingCandidatePath(rootDir, candidateId) {
  var entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i += 1) {
    var entry = entries[i];
    if (!entry.isDirectory()) continue;
    var candidatePath = path.join(rootDir, entry.name, candidateId + '.json');
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

function writeDailySummary(dayDir, day) {
  var counts = {
    drawing_approval: 0,
    drawing_revision: 0,
    client_spec_answer: 0
  };
  var total = 0;
  var entries = fs.readdirSync(dayDir, { withFileTypes: true });

  entries.forEach(function(entry) {
    if (!entry.isFile() || entry.name === '_summary.json' || path.extname(entry.name) !== '.json') {
      return;
    }

    try {
      var candidate = JSON.parse(fs.readFileSync(path.join(dayDir, entry.name), 'utf8'));
      if (LIVE_EVENT_TYPES.indexOf(candidate.event_type) !== -1) {
        counts[candidate.event_type] += 1;
        total += 1;
      }
    } catch (err) {
      // Skip malformed files; the summary is only an operational convenience.
    }
  });

  writeJsonAtomic(path.join(dayDir, '_summary.json'), {
    date: day,
    updated_at: new Date().toISOString(),
    total_emitted_candidates: total,
    counts_by_event_type: counts
  });
}

function cleanText(body, bodyType) {
  var text = String(body || '');
  var normalizedType = String(bodyType || '').toLowerCase();

  if (!text) return '';

  if (normalizedType === 'html' || /<[^>]+>/.test(text)) {
    text = text.replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, ' ');
    text = text.replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*?<\/div>/gi, ' ');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n');
    text = text.replace(/<\/div>/gi, '\n');
    text = text.replace(/<[^>]+>/g, ' ');
    text = decodeHtmlEntities(text);
  }

  text = text
    .replace(/On .{10,160} wrote:/gi, '\n')
    .replace(/From:\s.+/gi, '\n')
    .replace(/Sent:\s.+/gi, '\n')
    .replace(/To:\s.+/gi, '\n')
    .replace(/Subject:\s.+/gi, '\n')
    .replace(/_{10,}/g, '\n')
    .replace(/-{10,}/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return truncate(text, 4000);
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, function(_, code) {
      return String.fromCharCode(Number(code));
    });
}

function splitAddressHeader(value) {
  return String(value || '')
    .split(',')
    .map(function(part) { return part.trim(); })
    .filter(Boolean);
}

function normalizeSubject(subject) {
  return String(subject || '')
    .replace(/^(re|fw|fwd):\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findEvidenceText(texts, phrases) {
  for (var i = 0; i < texts.length; i += 1) {
    var text = String(texts[i] || '');
    if (!text) continue;
    var matched = findMatchingSnippet(text, phrases);
    if (matched) return matched;
  }
  return truncate(String(texts[0] || texts[1] || ''), 500);
}

function findMatchingSnippet(text, phrases) {
  var normalized = text.toLowerCase();
  var snippets = text
    .split(/\n+/)
    .map(function(line) { return line.trim(); })
    .filter(Boolean);

  for (var i = 0; i < snippets.length; i += 1) {
    var snippet = snippets[i];
    var lower = snippet.toLowerCase();
    if (containsAny(lower, phrases)) {
      return truncate(snippet, 500);
    }
  }

  var sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(function(sentence) { return sentence.trim(); })
    .filter(Boolean);

  for (var j = 0; j < sentences.length; j += 1) {
    var sentence = sentences[j];
    if (containsAny(sentence.toLowerCase(), phrases)) {
      return truncate(sentence, 500);
    }
  }

  if (containsDimensionPattern(normalized)) {
    for (var k = 0; k < sentences.length; k += 1) {
      if (containsDimensionPattern(sentences[k].toLowerCase())) {
        return truncate(sentences[k], 500);
      }
    }
  }

  return null;
}

function containsAny(text, phrases) {
  return phrases.some(function(phrase) { return text.indexOf(phrase) !== -1; });
}

function containsDimensionPattern(text) {
  return /\b\d{1,3}(?:\.\d+)?\s?(?:x|×)\s?\d{1,3}(?:\.\d+)?(?:\s?(?:x|×)\s?\d{1,3}(?:\.\d+)?)?\b/.test(text);
}

function isGratitudeOnly(text) {
  var trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return true;
  return (
    trimmed.length < 120
    && containsAny(trimmed, ['thank you', 'thanks', 'great, thank you', 'appreciate it', 'got it, thanks'])
    && !containsAny(trimmed, ['approve', 'approved', 'drawing', 'blind seam', 'self-welt', 'self welt', 'size', 'dimensions'])
  );
}

function isGenericReceipt(text) {
  var trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  return (
    trimmed.length < 220
    && containsAny(trimmed, ['received, thank you', 'thanks for confirming', 'confirming receipt', 'we received', 'got it, thanks'])
    && !containsAny(trimmed, ['approve', 'approved', 'proceed', 'blind seam', 'self-welt', 'dimensions', 'size'])
  );
}

function isForwardedOnly(text) {
  var trimmed = String(text || '').trim();
  return (
    trimmed.indexOf('---------- Forwarded message ----------') === 0
    || trimmed.indexOf('________________________________') === 0
    || trimmed.indexOf('From:') === 0
  );
}

function truncate(text, maxLen) {
  var value = String(text || '');
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen - 1).trimEnd() + '…';
}

function toPacificDate(isoString) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(isoString));
}

function writeJsonAtomic(filePath, data) {
  var tempPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tempPath, filePath);
}

module.exports = {
  captureShadowCandidate: captureShadowCandidate,
  detectWeekOneReadiness: detectWeekOneReadiness,
  cleanText: cleanText,
  normalizeSubject: normalizeSubject
};
