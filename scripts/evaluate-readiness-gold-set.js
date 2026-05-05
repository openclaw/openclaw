#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_DIR = '/Users/chrisreyes/.openclaw/workspace/readiness-email-export';
const THREADS_PATH = path.join(BASE_DIR, 'threads.jsonl');
const GOLD_SET_PATH = path.join(BASE_DIR, 'gold_set_review.csv');
const REPORT_PATH = path.join(BASE_DIR, 'readiness_eval_report.md');
const RULESET_PATH = path.join(BASE_DIR, 'readiness_rules_v1.md');
const CONTRACT_PATH = path.join(BASE_DIR, 'readiness_candidate_contract.json');

const PROPOSAL_TYPES = [
  'drawing_approval',
  'drawing_revision',
  'client_spec_answer',
  'fabric_problem',
  'fabric_status',
  'frame_status',
  'client_item_status',
  'none'
];

const PRIORITY_LANES = ['drawing_approval', 'drawing_revision', 'client_spec_answer'];
const PROPOSAL_ONLY_LANES = ['fabric_problem', 'fabric_status', 'frame_status', 'client_item_status'];

main().catch((error) => {
  console.error(`[readiness-eval] ${error.message}`);
  process.exit(1);
});

async function main() {
  const threads = readJsonl(THREADS_PATH);
  const goldRows = parseCsv(fs.readFileSync(GOLD_SET_PATH, 'utf8'));
  const joined = joinGoldRows(goldRows, threads);

  const evaluated = joined.map((row) => ({
    ...row,
    prediction: predictReadiness(row.thread)
  }));

  const proposalRows = evaluated.filter((row) => normalizeBinary(row.gold.proposal_yes_no) !== null);
  const typeRows = evaluated.filter((row) => actualType(row.gold) !== null);
  const safeRows = evaluated.filter((row) => normalizeBinary(row.gold.safe_to_auto_write_later) !== null);

  const proposalMetrics = evaluateBinary(
    proposalRows,
    (row) => row.prediction.proposal_yes_no,
    (row) => normalizeBinary(row.gold.proposal_yes_no)
  );

  const safeMetrics = evaluateBinary(
    safeRows,
    (row) => row.prediction.safe_to_auto_write_later,
    (row) => normalizeBinary(row.gold.safe_to_auto_write_later)
  );

  const typeMetrics = evaluateTypeMetrics(typeRows);
  const falsePositivePatterns = summarizePatterns(
    proposalRows.filter((row) => row.prediction.proposal_yes_no === 'yes' && normalizeBinary(row.gold.proposal_yes_no) === 'no'),
    'false_positive'
  );
  const falseNegativePatterns = summarizePatterns(
    proposalRows.filter((row) => row.prediction.proposal_yes_no === 'no' && normalizeBinary(row.gold.proposal_yes_no) === 'yes'),
    'false_negative'
  );
  const mismatchExamples = buildMismatchExamples(evaluated);

  fs.writeFileSync(REPORT_PATH, renderReport({
    generatedAt: new Date().toISOString(),
    totalGoldRows: goldRows.length,
    joinedRows: joined.length,
    unmatchedRows: joined.filter((row) => row.thread == null).length,
    proposalRows,
    typeRows,
    safeRows,
    proposalMetrics,
    safeMetrics,
    typeMetrics,
    falsePositivePatterns,
    falseNegativePatterns,
    mismatchExamples
  }));

  fs.writeFileSync(RULESET_PATH, renderRulesV1());
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(buildCandidateContract(), null, 2)}\n`);

  console.log(JSON.stringify({
    goldRows: goldRows.length,
    joinedRows: joined.length,
    labeledProposalRows: proposalRows.length,
    labeledTypeRows: typeRows.length,
    labeledSafeRows: safeRows.length,
    reportPath: REPORT_PATH,
    rulesPath: RULESET_PATH,
    contractPath: CONTRACT_PATH
  }, null, 2));
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseCsv(text) {
  const rows = [];
  let current = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      current.push(cell);
      cell = '';
      continue;
    }

    if (ch === '\n') {
      current.push(cell);
      rows.push(current);
      current = [];
      cell = '';
      continue;
    }

    if (ch !== '\r') {
      cell += ch;
    }
  }

  if (cell.length > 0 || current.length > 0) {
    current.push(cell);
    rows.push(current);
  }

  const [header, ...dataRows] = rows;
  return dataRows
    .filter((row) => row.some((value) => String(value || '').trim() !== ''))
    .map((row) => {
      const entry = {};
      for (let i = 0; i < header.length; i += 1) {
        entry[header[i]] = row[i] ?? '';
      }
      return entry;
    });
}

function joinGoldRows(goldRows, threads) {
  const byFullKey = new Map();
  const byMailboxSubject = new Map();
  const byMailboxTimestamp = new Map();

  for (const thread of threads) {
    const fullKey = makeJoinKey(thread.mailbox, thread.subject, thread.latest_timestamp);
    byFullKey.set(fullKey, thread);

    const mailboxSubjectKey = `${thread.mailbox}::${thread.subject}`;
    if (!byMailboxSubject.has(mailboxSubjectKey)) byMailboxSubject.set(mailboxSubjectKey, []);
    byMailboxSubject.get(mailboxSubjectKey).push(thread);

    byMailboxTimestamp.set(`${thread.mailbox}::${thread.latest_timestamp}`, thread);
  }

  for (const candidates of byMailboxSubject.values()) {
    candidates.sort((a, b) => {
      return new Date(b.latest_timestamp).getTime() - new Date(a.latest_timestamp).getTime();
    });
  }

  return goldRows.map((gold) => {
    const fullKey = makeJoinKey(gold.mailbox, gold.subject, gold.latest_timestamp);
    let thread = byFullKey.get(fullKey) || null;

    if (!thread) {
      thread = byMailboxTimestamp.get(`${gold.mailbox}::${gold.latest_timestamp}`) || null;
    }

    if (!thread) {
      const candidates = byMailboxSubject.get(`${gold.mailbox}::${gold.subject}`) || [];
      thread = candidates[0] || null;
    }

    return { gold, thread };
  });
}

function makeJoinKey(mailbox, subject, latestTimestamp) {
  return `${mailbox}::${subject}::${latestTimestamp}`;
}

function predictReadiness(thread) {
  if (!thread) {
    return {
      proposal_yes_no: 'no',
      type: 'none',
      safe_to_auto_write_later: 'no',
      confidence: 0,
      primary_reason: 'missing_thread_join',
      signals: []
    };
  }

  const subject = String(thread.subject || '');
  const latestText = String(thread.clean_latest_text || thread.clean_thread_excerpt || '');
  const threadExcerpt = String(thread.clean_thread_excerpt || '');
  const threadWideText = [latestText, threadExcerpt].filter(Boolean).join('\n');
  const combinedHint = `${subject}\n${threadWideText}`.toLowerCase();
  const subjectHint = subject.toLowerCase();
  const body = latestText.toLowerCase();
  const threadBody = threadWideText.toLowerCase();

  const signals = [];

  const hasDrawingHint = containsAny(combinedHint, ['drawing', 'drawings', 'dfa', 'mock that up']);
  const hasStrongDrawingApproval = containsAny(threadBody, [
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
  const hasRevisionPhrase = containsAny(threadBody, [
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
  const hasSpecKeyword = containsAny(combinedHint, [
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
    '18.5',
    '15"',
    'option 1',
    'option 2',
    'gather sample',
    'gather',
    'foam',
    'envelope',
    'spring down'
  ]);
  const hasWeakApprovalOnly = containsAny(threadBody, [
    'sounds good',
    'that should work',
    'this works',
    'received, thank you',
    'thanks for confirming',
    'confirming receipt'
  ]);
  const hasExplicitChoice = containsAny(threadBody, [
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
  const hasOptionSelection = /option\s*[12]\b/.test(threadBody) && containsAny(threadBody, [
    'choose option',
    'selected option',
    'go with option',
    'prefer option',
    'option 1 works',
    'option 2 works',
    'let’s do option',
    "let's do option"
  ]);
  const hasDimensionPattern = containsDimensionPattern(threadBody);
  const hasExplicitDimensionDecision = (
    hasDimensionPattern
    && (
      containsAny(threadBody, [
        'keep the size as',
        'size should be',
        'the size is',
        'size is',
        'dimensions are',
        'railroad and keep the size as'
      ])
    )
  );
  const hasStructuredSpecAnswer = containsAny(threadBody, [
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
  const hasQuestionOnlySpecPrompt = containsAny(threadBody, [
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
  const hasStrongSpecAnswer = hasSpecKeyword && (
    hasOptionSelection
    || hasExplicitChoice
    || hasExplicitDimensionDecision
    || hasStructuredSpecAnswer
  ) && !(hasQuestionOnlySpecPrompt && !hasStructuredSpecAnswer && !hasExplicitDimensionDecision && !hasOptionSelection);

  const hasFabricKeyword = containsAny(combinedHint, ['fabric', 'yardage', 'yards', 'leather', 'material']);
  const hasFabricProblemPhrase = containsAny(threadBody, [
    'delay',
    'delayed',
    'short',
    'shortage',
    'damaged',
    'wrong',
    'missing',
    'backorder',
    'backordered',
    'pending payment',
    'hasn’t shipped',
    "hasn't shipped",
    'not enough yardage',
    'missing yardage'
  ]);
  const hasFabricStatusPhrase = containsAny(threadBody, [
    'fabric received',
    'received the fabric',
    'arriving to you today',
    'tracking',
    'shipped',
    'delivered',
    'ready for pickup',
    'yardage'
  ]);

  const hasFrameSignal = containsAny(combinedHint, ['frame']) && containsAny(threadBody, [
    'received',
    'approved',
    'ready',
    'eta',
    'repair',
    'frame was just approved'
  ]);

  const hasClientItemSignal = containsAny(threadBody, [
    'pick up',
    'pickup',
    'drop off',
    'dropoff',
    'client item',
    'ready for pickup'
  ]) && !hasFabricKeyword;

  const gratitudeOnly = isGratitudeOnly(body);
  const genericReceipt = isGenericReceipt(body);
  const commercialOnly = containsAny(body, [
    'invoice',
    'revised invoice',
    'quote',
    'check',
    'payment',
    'balance',
    'cadogan can pick it up',
    'xero'
  ]) && !hasStrongDrawingApproval && !hasRevisionPhrase && !hasStrongSpecAnswer;
  const forwardedOnly = isForwardedOnly(latestText);

  let type = 'none';
  let primaryReason = 'no_readiness_signal';
  let confidence = 0.2;

  if (hasStrongSpecAnswer) {
    type = 'client_spec_answer';
    primaryReason = 'thread_wide_client_spec_signal';
    confidence = 0.88;
    signals.push('thread_wide_client_spec_signal');
  } else if (hasRevisionPhrase && hasDrawingHint && !containsAny(threadBody, ['revised invoice'])) {
    type = 'drawing_revision';
    primaryReason = 'thread_wide_drawing_revision_signal';
    confidence = 0.86;
    signals.push('thread_wide_drawing_revision_signal');
  } else if (hasStrongDrawingApproval && hasDrawingHint) {
    type = 'drawing_approval';
    primaryReason = 'thread_wide_drawing_approval_signal';
    confidence = 0.9;
    signals.push('thread_wide_drawing_approval_signal');
  } else if (hasFabricKeyword && hasFabricProblemPhrase) {
    type = 'fabric_problem';
    primaryReason = 'thread_wide_fabric_problem_signal';
    confidence = 0.68;
    signals.push('thread_wide_fabric_problem_signal');
  } else if (hasFrameSignal) {
    type = 'frame_status';
    primaryReason = 'frame_status_signal';
    confidence = 0.66;
    signals.push('frame_status_signal');
  } else if (hasClientItemSignal) {
    type = 'client_item_status';
    primaryReason = 'client_item_status_signal';
    confidence = 0.62;
    signals.push('client_item_status_signal');
  } else if (hasFabricKeyword && hasFabricStatusPhrase) {
    type = 'fabric_status';
    primaryReason = 'thread_wide_fabric_status_signal';
    confidence = 0.56;
    signals.push('thread_wide_fabric_status_signal');
  }

  if (type === 'none') {
    if (commercialOnly) primaryReason = 'commercial_only';
    else if (genericReceipt) primaryReason = 'generic_receipt_only';
    else if (gratitudeOnly) primaryReason = 'gratitude_only';
    else if (forwardedOnly) primaryReason = 'forwarded_shell';
  }

  if ((gratitudeOnly || genericReceipt || forwardedOnly || commercialOnly) && !isPriorityLane(type)) {
    type = 'none';
    primaryReason = commercialOnly
      ? 'commercial_only'
      : genericReceipt
        ? 'generic_receipt_only'
        : gratitudeOnly
          ? 'gratitude_only'
          : 'forwarded_shell';
    confidence = 0.18;
    signals.push(primaryReason);
  }

  const proposal_yes_no = type === 'none' ? 'no' : 'yes';
  const safe_to_auto_write_later = predictSafeWrite(type, threadBody, hasQuestionOnlySpecPrompt && !hasStrongSpecAnswer);

  return {
    proposal_yes_no,
    type,
    safe_to_auto_write_later,
    confidence: Number(confidence.toFixed(2)),
    primary_reason: primaryReason,
    signals: uniq(signals)
  };
}

function predictSafeWrite(type, body, looksLikeQuestionOnly) {
  if (type === 'drawing_approval') {
    if (looksLikeQuestionOnly) return 'no';
    if (containsAny(body, ['approved', 'please proceed', 'proceed with production', 'final approval', 'signed off', 'ok she has approved'])) {
      return 'yes';
    }
  }

  if (type === 'client_spec_answer') {
    if (looksLikeQuestionOnly) return 'no';
    if (containsAny(body, [
      'please use',
      'switch to',
      'go with',
      'self-welt',
      'self welt',
      'blind seam',
      'no welt',
      'keep the size as',
      'let’s railroad',
      "let's railroad",
      'french welt removed',
      'remove the french welt'
    ])) {
      return 'yes';
    }
    if (containsDimensionPattern(body)) {
      return 'yes';
    }
  }

  return 'no';
}

function isPriorityLane(type) {
  return PRIORITY_LANES.includes(type);
}

function containsAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function containsDimensionPattern(text) {
  return /\b\d{1,3}(?:\.\d+)?\s?(?:x|×)\s?\d{1,3}(?:\.\d+)?(?:\s?(?:x|×)\s?\d{1,3}(?:\.\d+)?)?\b/.test(text);
}

function isGratitudeOnly(text) {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return true;
  return (
    trimmed.length < 120
    && containsAny(trimmed, ['thank you', 'thanks', 'great, thank you', 'appreciate it', 'got it, thanks'])
    && !containsAny(trimmed, ['approve', 'approved', 'drawing', 'blind seam', 'self-welt', 'self welt', 'size', 'dimensions'])
  );
}

function isGenericReceipt(text) {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return (
    trimmed.length < 220
    && containsAny(trimmed, ['received, thank you', 'thanks for confirming', 'confirming receipt', 'we received', 'got it, thanks'])
    && !containsAny(trimmed, ['approve', 'approved', 'proceed', 'blind seam', 'self-welt', 'dimensions', 'size'])
  );
}

function isForwardedOnly(text) {
  const trimmed = String(text || '').trim();
  return (
    trimmed.startsWith('---------- Forwarded message ----------')
    || trimmed.startsWith('________________________________')
    || trimmed.startsWith('From:')
  );
}

function evaluateBinary(rows, predictedSelector, actualSelector) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (const row of rows) {
    const predicted = predictedSelector(row);
    const actual = actualSelector(row);
    if (predicted === 'yes' && actual === 'yes') tp += 1;
    else if (predicted === 'yes' && actual === 'no') fp += 1;
    else if (predicted === 'no' && actual === 'yes') fn += 1;
    else if (predicted === 'no' && actual === 'no') tn += 1;
  }

  return {
    total: rows.length,
    tp,
    fp,
    fn,
    tn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn)
  };
}

function evaluateTypeMetrics(rows) {
  const result = {};
  for (const type of PROPOSAL_TYPES) {
    result[type] = { actual: 0, predicted: 0, exact_match: 0 };
  }

  for (const row of rows) {
    const predicted = row.prediction.type;
    const actual = actualType(row.gold);
    if (!actual) continue;
    result[actual].actual += 1;
    result[predicted].predicted += 1;
    if (predicted === actual) {
      result[actual].exact_match += 1;
    }
  }

  return result;
}

function actualType(gold) {
  const proposalLabel = normalizeBinary(gold.proposal_yes_no);
  const typeLabel = normalizeType(gold.proposal_type);
  if (proposalLabel === null) return null;
  if (proposalLabel === 'no') return 'none';
  if (typeLabel) return typeLabel;
  return null;
}

function normalizeBinary(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (['yes', 'y', 'true'].includes(normalized)) return 'yes';
  if (['no', 'n', 'false'].includes(normalized)) return 'no';
  return null;
}

function normalizeType(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  return PROPOSAL_TYPES.includes(normalized) ? normalized : null;
}

function summarizePatterns(rows, kind) {
  const counts = new Map();
  for (const row of rows) {
    let key = row.prediction.primary_reason;
    if (kind === 'false_negative') {
      key = `${actualType(row.gold) || 'unknown'} missed as ${row.prediction.primary_reason}`;
    } else if (kind === 'false_positive') {
      key = `${row.prediction.type} via ${row.prediction.primary_reason}`;
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([pattern, count]) => ({ pattern, count }));
}

function buildMismatchExamples(rows) {
  return rows
    .filter((row) => normalizeBinary(row.gold.proposal_yes_no) !== null)
    .filter((row) => {
      const actualProposal = normalizeBinary(row.gold.proposal_yes_no);
      const actualSafe = normalizeBinary(row.gold.safe_to_auto_write_later);
      const actualProposalType = actualType(row.gold);
      return (
        row.prediction.proposal_yes_no !== actualProposal
        || (actualProposalType && row.prediction.type !== actualProposalType)
        || (actualSafe && row.prediction.safe_to_auto_write_later !== actualSafe)
      );
    })
    .sort((a, b) => b.prediction.confidence - a.prediction.confidence)
    .slice(0, 5)
    .map((row) => ({
      mailbox: row.gold.mailbox,
      subject: row.gold.subject,
      actual_proposal: normalizeBinary(row.gold.proposal_yes_no),
      predicted_proposal: row.prediction.proposal_yes_no,
      actual_type: actualType(row.gold),
      predicted_type: row.prediction.type,
      actual_safe_write: normalizeBinary(row.gold.safe_to_auto_write_later),
      predicted_safe_write: row.prediction.safe_to_auto_write_later,
      original_guess: row.thread ? row.thread.candidate_event_type_guess : null,
      reason: row.prediction.primary_reason,
      excerpt: truncate(row.thread ? row.thread.clean_latest_text || row.thread.clean_thread_excerpt || '' : '', 260)
    }));
}

function renderReport(data) {
  const lines = [
    '# Readiness Eval Report',
    '',
    `- Generated at: ${data.generatedAt}`,
    `- Gold-set rows scanned: ${data.totalGoldRows}`,
    `- Joined rows: ${data.joinedRows}`,
    `- Unmatched rows: ${data.unmatchedRows}`,
    `- Proposal-labeled rows used: ${data.proposalRows.length}`,
    `- Type-labeled rows used: ${data.typeRows.length}`,
    `- Safe-write-labeled rows used: ${data.safeRows.length}`,
    ''
  ];

  if (data.proposalRows.length === 0) {
    lines.push(
      '## Status',
      '',
      'No human labels are filled in yet, so this run cannot compute live metrics.',
      'The evaluator is ready and will score once `proposal_yes_no`, `proposal_type`, and `safe_to_auto_write_later` begin to populate in the gold set.',
      ''
    );
  }

  lines.push(
    '## Proposal Generation',
    '',
    renderBinaryMetricBlock(data.proposalMetrics),
    '',
    '## Safe Future Write Lane',
    '',
    renderBinaryMetricBlock(data.safeMetrics),
    '',
    '## Per-Type Counts',
    '',
    '| Type | Actual | Predicted | Exact Match |',
    '| --- | ---: | ---: | ---: |'
  );

  for (const type of PROPOSAL_TYPES) {
    const metric = data.typeMetrics[type];
    lines.push(`| ${type} | ${metric.actual} | ${metric.predicted} | ${metric.exact_match} |`);
  }

  lines.push('', '## Top False-Positive Patterns', '');
  if (data.falsePositivePatterns.length === 0) {
    lines.push('- None yet');
  } else {
    for (const item of data.falsePositivePatterns) {
      lines.push(`- ${item.pattern}: ${item.count}`);
    }
  }

  lines.push('', '## Top False-Negative Patterns', '');
  if (data.falseNegativePatterns.length === 0) {
    lines.push('- None yet');
  } else {
    for (const item of data.falseNegativePatterns) {
      lines.push(`- ${item.pattern}: ${item.count}`);
    }
  }

  lines.push('', '## Informative Mismatches', '');
  if (data.mismatchExamples.length === 0) {
    lines.push('- None yet');
  } else {
    for (const example of data.mismatchExamples) {
      lines.push(`- ${example.subject}`);
      lines.push(`  mailbox: ${example.mailbox}`);
      lines.push(`  actual: proposal=${example.actual_proposal || 'blank'}, type=${example.actual_type || 'blank'}, safe=${example.actual_safe_write || 'blank'}`);
      lines.push(`  predicted: proposal=${example.predicted_proposal}, type=${example.predicted_type}, safe=${example.predicted_safe_write}`);
      lines.push(`  baseline reason: ${example.reason}`);
      lines.push(`  original heuristic guess: ${example.original_guess || 'n/a'}`);
      lines.push(`  excerpt: ${example.excerpt || '(none)'}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderBinaryMetricBlock(metrics) {
  if (metrics.total === 0) {
    return [
      '- total labeled rows used: 0',
      '- precision: n/a',
      '- recall: n/a',
      '- false positives: 0',
      '- false negatives: 0'
    ].join('\n');
  }

  return [
    `- total labeled rows used: ${metrics.total}`,
    `- precision: ${formatRatio(metrics.precision)}`,
    `- recall: ${formatRatio(metrics.recall)}`,
    `- false positives: ${metrics.fp}`,
    `- false negatives: ${metrics.fn}`,
    `- true positives: ${metrics.tp}`,
    `- true negatives: ${metrics.tn}`
  ].join('\n');
}

function renderRulesV1() {
  const lines = [
    '# Readiness Rules V1',
    '',
    '## Purpose',
    '',
    'This ruleset defines a compact live-readiness detector for archived or newly arriving email threads. It is intentionally conservative and treats subject as a retrieval hint only. The actual decision should come from thread evidence, with strong signals allowed to override a weak or noisy latest reply.',
    '',
    '## Thread-Wide Scan',
    '',
    '- Scan the available thread evidence, not just the latest message.',
    '- If a strong readiness signal appears anywhere in the thread excerpt, use it even when the latest reply is weak, generic, or only logistical.',
    '- Latest clean text still matters most for framing, but it should not erase a strong signal from earlier in the thread.',
    '',
    '## Trigger A Readiness Proposal',
    '',
    '- `drawing_approval`: a thread-wide strong approval signal plus drawing context, such as `received the approved DFA`, `drawing was just approved`, `signed off`, or `please proceed` in a drawing/DFA thread.',
    '- `drawing_revision`: thread-wide explicit requests for drawing changes, markups, revised drawings, removals, or change-order style drawing updates.',
    '- `client_spec_answer`: thread-wide explicit spec resolution, such as blind seam vs self-welt, zipper choice, fill choice, directional fabric choice, option selection, or direct dimension answers like `keep the size as 64 x 16`.',
    '- `fabric_problem`: a real blocker or exception involving fabric, such as shortage, delay, damage, wrong fabric, backorder, missing yardage, or not-yet-shipped status tied to readiness risk.',
    '- `fabric_status`: fabric arrival, shipment, receipt, or tracking in a way that is operationally relevant but not necessarily write-safe.',
    '- `frame_status`: a concrete frame state update, such as frame received, approved, repaired, or ETA-bearing status.',
    '- `client_item_status`: a concrete pickup, dropoff, receipt, or readiness-state update for a client-owned item.',
    '',
    '## Strong vs Weak Signals',
    '',
    '- Strong approval signals: `approved`, `received the approved DFA`, `drawing was just approved`, `signed off`, `please proceed`, `proceed with production`, `looks good` when tied to drawing context.',
    '- Strong spec-answer signals: blind seam, self-welt, remove French welt, railroad direction, inside/back direction choices, explicit dimensions, `keep the size as`, or explicit option selections.',
    '- Weak signals that should not trigger on their own: `sounds good`, `that should work`, `this works`, `thanks`, `received`, generic confirmations, and generic acknowledgements.',
    '',
    '## Explicitly Suppress A Proposal',
    '',
    '- Subject-only signals with no matching evidence in thread text.',
    '- Forwarded shells where the latest text is mostly headers or forwarding scaffolding.',
    '- Generic thank-yous, acknowledgements, and courtesy replies with no build decision.',
    '- Generic `confirm` or `received` messages that only confirm receipt of an email, invoice, check, or quote.',
    '- Commercial-only threads about invoices, payments, checks, quote follow-up, or balance collection unless the latest text also carries a readiness decision.',
    '- Plain option lists or dimension listings without an actual selected choice or explicit answer.',
    '',
    '## V1 Live Lanes',
    '',
    '- Priority live lanes: `drawing_approval`, `drawing_revision`, `client_spec_answer`.',
    '- Proposal-only lanes for now: `fabric_problem`, `fabric_status`, `frame_status`, `client_item_status`.',
    '',
    '## Safe-To-Auto-Write Later = yes',
    '',
    '- Only when the thread is explicit enough that a future system could safely prepare a write after confirmation.',
    '- Strong `drawing_approval` language like `approved`, `final approval`, `please proceed`, or `signed off` can qualify.',
    '- Strong `client_spec_answer` language like `use blind seam`, `switch to self-welt`, `remove the French welt`, `keep the size as`, or explicit dimensions can qualify.',
    '- `drawing_revision` should normally stay `safe_to_auto_write_later = no` because it often implies new drawings or human interpretation rather than a direct structured field write.',
    '- Fabric shipping, delivery, tracking, or pickup alone should stay `safe_to_auto_write_later = no`.',
    '',
    '## Design Notes',
    '',
    '- Subject is a retrieval hint, not a deciding feature on its own.',
    '- Strong thread-wide evidence can override a weak latest reply.',
    '- If a thread mixes logistics with a clear readiness answer, classify the strongest actionable readiness signal.',
    '- Keep fabric conservative: shipping and delivery updates are proposal-only and should not be promoted to strong write-safe signals.',
    '- When in doubt, prefer proposal creation with `safe_to_auto_write_later = no` over an overconfident write lane.'
  ];

  return `${lines.join('\n')}\n`;
}

function buildCandidateContract() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Readiness Candidate Contract',
    type: 'object',
    additionalProperties: false,
    required: [
      'event_type',
      'source_mailbox',
      'subject',
      'latest_timestamp',
      'evidence_text',
      'proposed_updates',
      'confidence',
      'safe_to_auto_write_later',
      'status'
    ],
    properties: {
      id: {
        type: 'string',
        description: 'Stable candidate id generated by the readiness system.'
      },
      event_type: {
        type: 'string',
        enum: [
          'drawing_approval',
          'drawing_revision',
          'client_spec_answer',
          'fabric_problem',
          'fabric_status',
          'frame_status',
          'client_item_status'
        ]
      },
      source_mailbox: {
        type: 'string',
        description: 'Mailbox where the thread was retrieved.'
      },
      subject: {
        type: 'string'
      },
      latest_timestamp: {
        type: 'string',
        description: 'ISO 8601 timestamp for the latest thread activity.'
      },
      evidence_text: {
        type: 'string',
        description: 'Latest clean thread text or best evidence excerpt used for classification.'
      },
      matched_project: {
        type: ['string', 'null']
      },
      matched_item: {
        type: ['string', 'null']
      },
      proposed_updates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['target', 'field', 'value', 'confidence'],
          properties: {
            target: {
              type: 'string',
              enum: ['order_item', 'item_spec', 'project', 'none']
            },
            field: {
              type: 'string'
            },
            value: {},
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1
            },
            requires_confirmation: {
              type: 'boolean',
              default: true
            }
          }
        }
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1
      },
      safe_to_auto_write_later: {
        type: 'boolean'
      },
      status: {
        type: 'string',
        enum: ['candidate', 'reviewed', 'approved', 'applied', 'dismissed']
      },
      source_thread_key: {
        type: 'string',
        description: 'Stable join key back to the exported thread dataset.'
      },
      notes: {
        type: ['string', 'null']
      }
    }
  };
}

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return numerator / denominator;
}

function formatRatio(value) {
  if (value == null) return 'n/a';
  return value.toFixed(2);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function truncate(value, length) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1)}…`;
}
