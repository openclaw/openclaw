const fs = require('fs');
const path = require('path');

const TIME_ZONE = 'America/Los_Angeles';
const DAY_MS = 24 * 60 * 60 * 1000;
const READ_SERVICE_URL = process.env.PRESTIGIO_READ_SERVICE_URL || 'http://localhost:3005';
const DEFAULT_DATA_DIR = fs.existsSync('/data')
  ? '/data'
  : path.join(process.env.HOME || '', '.openclaw', 'workspace', 'prestigio');
const OUTPUT_PATH = process.env.PREP_PROPOSALS_OUTPUT_PATH || path.join(DEFAULT_DATA_DIR, 'prep-proposals.json');
const ROOT_ENV_PATH = path.resolve(__dirname, '..', '.env');
const PREFILL_KEYS = new Set(['fill_material', 'insert_type']);
const ALLOWED_FILL_MATERIALS = new Set([
  '50/50 Down & Feather',
  'Poly Fill',
  'Solid Down - Regular Stuffed',
  '25/75 Down & Feather',
  'Angel Hair',
  'Elite Fiber'
]);
const ALLOWED_INSERT_TYPES = new Set([
  'Foam & Dacron',
  'Envelope',
  'Spring Down',
  'Solid Down',
  'Foam Only',
  'Fiber Fill'
]);

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
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
    if (process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

function getPacificParts(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset'
  });
  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const offset = (lookup.timeZoneName || 'GMT+00:00').replace('GMT', '') || '+00:00';
  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
    hour: lookup.hour,
    minute: lookup.minute,
    second: lookup.second,
    offset
  };
}

function formatPacificTimestamp(date) {
  const parts = getPacificParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${parts.offset}`;
}

function formatPacificDate(date) {
  const parts = getPacificParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(date, days) {
  return new Date(date.getTime() + (days * DAY_MS));
}

function dateDiffInDays(dueDate, todayDate) {
  if (!dueDate) return Number.POSITIVE_INFINITY;
  const dueMs = Date.parse(`${dueDate}T00:00:00Z`);
  const todayMs = Date.parse(`${todayDate}T00:00:00Z`);
  if (Number.isNaN(dueMs) || Number.isNaN(todayMs)) return Number.POSITIVE_INFINITY;
  return Math.round((dueMs - todayMs) / DAY_MS);
}

function normalizeMissingSpecKeys(keys) {
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.filter(Boolean).map(String))].sort();
}

function buildMissingKeysSignature(keys) {
  return normalizeMissingSpecKeys(keys).join('|');
}

function buildStateSignature(item) {
  const specs = Array.isArray(item.specs)
    ? item.specs
        .map(spec => ({
          id: spec.id || null,
          cushion_type: spec.cushion_type || null,
          fill_material: spec.fill_material || null,
          insert_type: spec.insert_type || null
        }))
        .sort((a, b) => String(a.id || a.cushion_type || '').localeCompare(String(b.id || b.cushion_type || '')))
    : [];

  return JSON.stringify({
    target_completion: item.target_completion || null,
    missing_spec_keys: normalizeMissingSpecKeys(item.missing_spec_keys),
    frame_ready: Boolean(item.frame_ready),
    drawing_approved: Boolean(item.drawing_approved),
    all_fabric_received: Boolean(item.all_fabric_received),
    fabric_inspected: Boolean(item.fabric_inspected),
    specs
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON response from ${url}: ${error.message}`);
  }
}

async function fetchPrepItems() {
  const url = `${READ_SERVICE_URL}/query?type=prep_in_progress&fields=full`;
  const payload = await fetchJson(url);

  if (!payload || payload.success !== true || !Array.isArray(payload.results)) {
    throw new Error(`Unexpected prep_in_progress response: ${JSON.stringify(payload)}`);
  }

  return payload.results.map(item => ({
    ...item,
    missing_spec_keys: normalizeMissingSpecKeys(item.missing_spec_keys),
    specs: Array.isArray(item.specs) ? item.specs : []
  }));
}

async function fetchDianaFabricCount() {
  parseEnvFile(ROOT_ENV_PATH);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY for diana_fabric_count');
  }

  const url = `${supabaseUrl}/rest/v1/cot_entries?select=id&date_received=not.is.null&inspected_at=is.null&status=not.in.(returned,return_pending)`;
  const rows = await fetchJson(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json'
    }
  });

  return Array.isArray(rows) ? rows.length : 0;
}

function readExistingFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function classifyComponentRole(cushionType) {
  const value = String(cushionType || '').toLowerCase();
  const hasSeat = /\bseat\b/.test(value);
  const hasBack = /\bback\b/.test(value);
  if (hasSeat && !hasBack) return 'seat';
  if (hasBack && !hasSeat) return 'back';
  return null;
}

function isAllowedPrefillValue(field, value) {
  if (value == null || value === '') return false;
  if (field === 'fill_material') return ALLOWED_FILL_MATERIALS.has(value);
  if (field === 'insert_type') return ALLOWED_INSERT_TYPES.has(value);
  return false;
}

function joinHumanList(values) {
  if (values.length <= 1) return values[0] || '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function buildProductionContext(item) {
  if (item.frame_ready && item.fabric_inspected) {
    return 'Frame received, fabric inspected. One step from production.';
  }
  return null;
}

function buildPrefillProposal(item) {
  const missingKeys = normalizeMissingSpecKeys(item.missing_spec_keys);
  if (missingKeys.length === 0 || missingKeys.some(key => !PREFILL_KEYS.has(key))) {
    return null;
  }

  if (item.specs.length !== 2) return null;

  const specs = item.specs.map(spec => ({
    ...spec,
    role: classifyComponentRole(spec.cushion_type)
  }));

  if (specs.some(spec => !spec.role)) return null;

  const seatSpec = specs.find(spec => spec.role === 'seat');
  const backSpec = specs.find(spec => spec.role === 'back');
  if (!seatSpec || !backSpec) return null;

  const writes = [];
  let sourceSpec = null;
  let targetSpec = null;

  for (const key of missingKeys) {
    const seatValue = seatSpec[key] ?? null;
    const backValue = backSpec[key] ?? null;
    const seatHasValue = seatValue != null && seatValue !== '';
    const backHasValue = backValue != null && backValue !== '';

    if (seatHasValue === backHasValue) {
      return null;
    }

    const source = seatHasValue ? seatSpec : backSpec;
    const target = seatHasValue ? backSpec : seatSpec;
    if (!isAllowedPrefillValue(key, source[key])) {
      return null;
    }

    if (sourceSpec && sourceSpec.id !== source.id) return null;
    if (targetSpec && targetSpec.id !== target.id) return null;
    sourceSpec = source;
    targetSpec = target;

    writes.push({
      action: 'set-item-spec-field',
      item_id: item.id,
      spec_id: target.id,
      field: key,
      value: source[key]
    });
  }

  if (!sourceSpec || !targetSpec || writes.length !== missingKeys.length) {
    return null;
  }

  const contextValues = [];
  const insertWrite = writes.find(write => write.field === 'insert_type');
  const fillWrite = writes.find(write => write.field === 'fill_material');
  if (insertWrite) contextValues.push(insertWrite.value);
  if (fillWrite) contextValues.push(fillWrite.value);

  return {
    kind: 'prefill',
    item_label: `${item.sidemark} — ${targetSpec.cushion_type}`,
    context: `${sourceSpec.cushion_type} already has: ${contextValues.join(', ')}`,
    summary: `Match ${targetSpec.cushion_type} to ${sourceSpec.cushion_type}?`,
    writes,
    fields_needed: [],
    source_component: sourceSpec.cushion_type,
    target_component: targetSpec.cushion_type,
    components_needed: [targetSpec.cushion_type]
  };
}

function buildQuestionContext(item, missingKeys) {
  const componentsNeeded = new Set();

  for (const spec of item.specs) {
    for (const key of missingKeys) {
      if (!PREFILL_KEYS.has(key)) continue;
      if (spec[key] == null || spec[key] === '') {
        if (spec.cushion_type) componentsNeeded.add(spec.cushion_type);
      }
    }
  }

  const componentList = [...componentsNeeded];
  if (componentList.length > 0 && missingKeys.length === 1) {
    return {
      context: `${joinHumanList(componentList)} ${componentList.length === 1 ? 'is' : 'are'} blank for ${missingKeys[0]}.`,
      componentsNeeded: componentList
    };
  }

  if (componentList.length > 0) {
    return {
      context: `${joinHumanList(componentList)} still need ${joinHumanList(missingKeys)}.`,
      componentsNeeded: componentList
    };
  }

  return {
    context: 'No prefill source available on this item.',
    componentsNeeded: []
  };
}

function buildQuestionProposal(item) {
  const missingKeys = normalizeMissingSpecKeys(item.missing_spec_keys);
  const { context, componentsNeeded } = buildQuestionContext(item, missingKeys);
  let summary;
  if (missingKeys.length === 1 && componentsNeeded.length > 0) {
    summary = `What is ${missingKeys[0]} for ${joinHumanList(componentsNeeded)}?`;
  } else if (missingKeys.length === 1) {
    summary = `What is ${missingKeys[0]}?`;
  } else {
    summary = `What are ${joinHumanList(missingKeys)}?`;
  }

  return {
    kind: 'question',
    item_label: item.sidemark,
    context,
    summary,
    writes: [],
    fields_needed: missingKeys,
    components_needed: componentsNeeded
  };
}

function buildProposalDraft(item) {
  return buildPrefillProposal(item) || buildQuestionProposal(item);
}

function createSuppressedRecord({
  item,
  draft,
  previousState,
  reason,
  ignoreCount,
  snoozeUntil,
  stateSignature,
  missingKeysSignature
}) {
  return {
    item_id: item.id,
    item_label: draft.item_label,
    kind: draft.kind,
    reason,
    due: item.target_completion || null,
    ignore_count: ignoreCount,
    snooze_until: snoozeUntil || null,
    last_proposed_at: previousState?.last_proposed_at || null,
    missing_spec_keys: normalizeMissingSpecKeys(item.missing_spec_keys),
    missing_keys_signature: missingKeysSignature,
    state_signature: stateSignature,
    production_context: buildProductionContext(item)
  };
}

function createCandidateRecord({
  item,
  draft,
  previousState,
  ignoreCount,
  stateSignature,
  missingKeysSignature
}) {
  return {
    kind: draft.kind,
    status: 'pending',
    item_id: item.id,
    item_label: draft.item_label,
    project: item.project || null,
    due: item.target_completion || null,
    context: draft.context,
    summary: draft.summary,
    writes: draft.writes,
    fields_needed: draft.fields_needed,
    components_needed: draft.components_needed,
    source_component: draft.source_component || null,
    target_component: draft.target_component || null,
    ignore_count: ignoreCount,
    snooze_until: null,
    last_proposed_at: previousState?.last_proposed_at || null,
    missing_spec_keys: normalizeMissingSpecKeys(item.missing_spec_keys),
    missing_keys_signature: missingKeysSignature,
    state_signature: stateSignature,
    production_context: buildProductionContext(item)
  };
}

function evaluateCurrentItems(items, previous, now) {
  const previousProposals = new Map();
  const previousSuppressed = new Map();
  const hasPreviousRun = Boolean(previous?.generated_at);
  const todayDate = formatPacificDate(now);
  const candidates = [];
  const suppressed = [];

  for (const proposal of previous?.proposals || []) {
    if (proposal?.status === 'pending' && proposal.item_id) {
      previousProposals.set(proposal.item_id, proposal);
    }
  }

  for (const entry of previous?.suppressed || []) {
    if (entry?.item_id) {
      previousSuppressed.set(entry.item_id, entry);
    }
  }

  for (const item of items) {
    const draft = buildProposalDraft(item);
    const previousProposal = previousProposals.get(item.id) || null;
    const previousSuppression = previousSuppressed.get(item.id) || null;
    const previousState = previousProposal || previousSuppression;
    const stateSignature = buildStateSignature(item);
    const missingKeysSignature = buildMissingKeysSignature(item.missing_spec_keys);
    const stateChanged = Boolean(previousState && previousState.state_signature && previousState.state_signature !== stateSignature);
    const missingKeysChanged = Boolean(previousState && previousState.missing_keys_signature && previousState.missing_keys_signature !== missingKeysSignature);
    const newlyEntered = hasPreviousRun && !previousState;
    const dueInDays = dateDiffInDays(item.target_completion, todayDate);
    const dueWithin14Days = dueInDays <= 14;
    const dueWithin7Days = dueInDays <= 7;

    let ignoreCount = previousState ? Number(previousState.ignore_count || 0) : 0;
    if (stateChanged) {
      ignoreCount = 0;
    } else if (previousProposal) {
      ignoreCount += 1;
    }

    // Once an item is within 7 days of due, surface it again even if it was snoozed.
    if (!stateChanged && !dueWithin7Days && previousSuppression?.reason === 'snoozed_after_first_ignore' && previousSuppression.snooze_until) {
      const snoozeUntilMs = Date.parse(previousSuppression.snooze_until);
      if (!Number.isNaN(snoozeUntilMs) && now.getTime() < snoozeUntilMs) {
        suppressed.push(createSuppressedRecord({
          item,
          draft,
          previousState,
          reason: 'snoozed_after_first_ignore',
          ignoreCount,
          snoozeUntil: previousSuppression.snooze_until,
          stateSignature,
          missingKeysSignature
        }));
        continue;
      }
    }

    if (!stateChanged && previousSuppression?.reason === 'suppressed_after_second_ignore' && !dueWithin7Days) {
      suppressed.push(createSuppressedRecord({
        item,
        draft,
        previousState,
        reason: 'suppressed_after_second_ignore',
        ignoreCount,
        snoozeUntil: null,
        stateSignature,
        missingKeysSignature
      }));
      continue;
    }

    if (!stateChanged && !dueWithin7Days && previousProposal && ignoreCount === 1) {
      suppressed.push(createSuppressedRecord({
        item,
        draft,
        previousState,
        reason: 'snoozed_after_first_ignore',
        ignoreCount,
        snoozeUntil: formatPacificTimestamp(addDays(now, 7)),
        stateSignature,
        missingKeysSignature
      }));
      continue;
    }

    if (!stateChanged && previousProposal && ignoreCount >= 2 && !dueWithin7Days) {
      suppressed.push(createSuppressedRecord({
        item,
        draft,
        previousState,
        reason: 'suppressed_after_second_ignore',
        ignoreCount,
        snoozeUntil: null,
        stateSignature,
        missingKeysSignature
      }));
      continue;
    }

    const eligibleByWindow = dueWithin14Days || newlyEntered || missingKeysChanged || stateChanged;
    if (!eligibleByWindow) {
      suppressed.push(createSuppressedRecord({
        item,
        draft,
        previousState,
        reason: 'due_date_too_far',
        ignoreCount,
        snoozeUntil: null,
        stateSignature,
        missingKeysSignature
      }));
      continue;
    }

    candidates.push(createCandidateRecord({
      item,
      draft,
      previousState,
      ignoreCount,
      stateSignature,
      missingKeysSignature
    }));
  }

  candidates.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'prefill' ? -1 : 1;
    }
    const aDue = a.due || '9999-12-31';
    const bDue = b.due || '9999-12-31';
    return aDue.localeCompare(bDue);
  });

  const visible = [];
  const overflow = [];
  for (const candidate of candidates) {
    if (visible.length < 2) {
      visible.push(candidate);
    } else {
      overflow.push(candidate);
    }
  }

  for (const candidate of overflow) {
    suppressed.push({
      item_id: candidate.item_id,
      item_label: candidate.item_label,
      kind: candidate.kind,
      reason: 'cap_reached',
      due: candidate.due,
      ignore_count: candidate.ignore_count,
      snooze_until: candidate.snooze_until,
      last_proposed_at: candidate.last_proposed_at,
      missing_spec_keys: candidate.missing_spec_keys,
      missing_keys_signature: candidate.missing_keys_signature,
      state_signature: candidate.state_signature,
      production_context: candidate.production_context
    });
  }

  const generatedAt = formatPacificTimestamp(now);
  let prefillId = 0;
  let questionId = 0;
  const proposals = visible.map(candidate => {
    const id = candidate.kind === 'prefill'
      ? `P${++prefillId}`
      : `Q${++questionId}`;

    return {
      id,
      ...candidate,
      last_proposed_at: generatedAt
    };
  });

  suppressed.sort((a, b) => {
    const aDue = a.due || '9999-12-31';
    const bDue = b.due || '9999-12-31';
    if (aDue !== bDue) return aDue.localeCompare(bDue);
    return String(a.item_id).localeCompare(String(b.item_id));
  });

  return { proposals, suppressed };
}

async function generatePrepProposals() {
  const now = process.env.PREP_PROPOSALS_NOW
    ? new Date(process.env.PREP_PROPOSALS_NOW)
    : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error(`Invalid PREP_PROPOSALS_NOW value: ${process.env.PREP_PROPOSALS_NOW}`);
  }

  const [items, dianaFabricCount] = await Promise.all([
    fetchPrepItems(),
    fetchDianaFabricCount()
  ]);
  const previous = readExistingFile(OUTPUT_PATH);
  const { proposals, suppressed } = evaluateCurrentItems(items, previous, now);

  const payload = {
    generated_at: formatPacificTimestamp(now),
    diana_fabric_count: dianaFabricCount,
    proposals,
    suppressed
  };

  writeJsonAtomic(OUTPUT_PATH, payload);
  return payload;
}

if (require.main === module) {
  generatePrepProposals()
    .then(payload => {
      console.log(JSON.stringify({
        ok: true,
        generated_at: payload.generated_at,
        proposals: payload.proposals.length,
        suppressed: payload.suppressed.length,
        diana_fabric_count: payload.diana_fabric_count,
        output: OUTPUT_PATH
      }, null, 2));
    })
    .catch(error => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = {
  buildProposalDraft,
  evaluateCurrentItems,
  generatePrepProposals
};
