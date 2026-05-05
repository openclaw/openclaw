const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCandidatePackets, buildSummaryPayload, defaultOverrides, normalizeOverrides } = require('./candidate-builder');
const { readApprovalActions, buildReviewStatePayload, applyReviewStateToCandidate, sortCandidatesForQueue } = require('./review-state');

const PORT = Number(process.env.PORT || 3010);
const POLL_MS = Number(process.env.MARKETING_POLL_MS || 1000);
const DEBOUNCE_MS = Number(process.env.MARKETING_DEBOUNCE_MS || 400);
const REQUEST_STABILITY_MS = Number(process.env.MARKETING_REQUEST_STABILITY_MS || 250);
const FILE_TTL_MS = Number(process.env.MARKETING_FILE_TTL_MS || 14 * 24 * 60 * 60 * 1000);
const DEFAULT_BACKFILL_DAYS = Number(process.env.MARKETING_BACKFILL_DAYS || 180);
const INCREMENTAL_INTERVAL_MS = Number(process.env.MARKETING_INCREMENTAL_INTERVAL_MS || 15 * 60 * 1000);
const HOME_DIR = process.env.HOME || os.homedir();
const ROOT_ENV_PATH = path.resolve(__dirname, '..', '.env');
const DATA_DIR = process.env.MARKETING_DATA_DIR || (fs.existsSync('/data')
  ? '/data'
  : path.join(HOME_DIR, '.openclaw', 'workspace', 'marketing'));
const BUILD_REQUESTS_DIR = path.join(DATA_DIR, 'build-requests');
const BUILD_RESPONSES_DIR = path.join(DATA_DIR, 'build-responses');
const STATUS_FILE = path.join(DATA_DIR, 'build-status.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'overrides.json');
const APPROVALS_DIR = path.join(DATA_DIR, 'approvals');
const REVIEW_STATE_FILE = path.join(DATA_DIR, 'review-state.json');
const CANDIDATES_DIR = path.join(DATA_DIR, 'candidates');
const CANDIDATES_SUMMARY_FILE = path.join(CANDIDATES_DIR, 'summary.json');
const CANDIDATES_BY_ID_DIR = path.join(CANDIDATES_DIR, 'by-id');
const QUALIFYING_STATUSES = ['work_complete', 'ready for pick up', 'collected'];
const ORDER_ITEMS_PAGE_SIZE = Number(process.env.MARKETING_ORDER_ITEMS_PAGE_SIZE || 250);
const ITEM_SPECS_PAGE_SIZE = Number(process.env.MARKETING_ITEM_SPECS_PAGE_SIZE || 500);
const PROJECT_DESIGNERS_PAGE_SIZE = Number(process.env.MARKETING_PROJECT_DESIGNERS_PAGE_SIZE || 500);
const LOG_PREFIX = '[marketing-overlay-service]';

let SUPABASE_URL = process.env.SUPABASE_URL || '';
let SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const ORDER_ITEM_SELECT = [
  'id',
  'item_name',
  'sidemark',
  'description',
  'quoting_description',
  'category',
  'room',
  'quantity',
  'status',
  'on_hold',
  'completion_photos',
  'inspo_images',
  'reference_images',
  'project_name',
  'design_firm_name',
  'width',
  'depth',
  'height',
  'client_visible_notes',
  'special_notes',
  'fabrication_notes',
  'construction_notes',
  'updated_at',
  'created_at',
  'work_completed_at',
  'completed_at',
  'delivered_at',
  'po:pos(po_number,project_id,projects(id,name,status,collaborating_designers,clients(id,name,company)))',
  'quote:quotes!order_items_quote_id_fkey(project_id,projects(id,name,status,collaborating_designers,clients(id,name,company)))'
].join(',');

const ITEM_SPEC_SELECT = [
  'id',
  'order_item_id',
  'spec_type',
  'cushion_type',
  'insert_type',
  'fill_material',
  'core_type',
  'foam_thickness',
  'wrap_material',
  'has_zipper',
  'seam_details',
  'special_instructions'
].join(',');

const PROJECT_DESIGNER_SELECT = 'project_id,designer_id,designers(name,email)';

let lastBuildStartedAt = null;
let lastBuildFinishedAt = null;
let lastSuccessfulBuildAt = null;
let lastError = null;
let lastMode = null;
let lastRequestId = null;
let lastSourceSince = null;
let lastCandidateCount = 0;
let lastProcessedItemCount = 0;
let lastSkippedCount = 0;
let isBuilding = false;
let debounceTimer = null;
let incrementalTimer = null;
let lastApprovalsFingerprint = null;
const buildQueue = [];

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logError(message) {
  console.error(`${LOG_PREFIX} ${message}`);
}

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

function loadEnvIfNeeded() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    parseEnvFile(ROOT_ENV_PATH);
    SUPABASE_URL = process.env.SUPABASE_URL || SUPABASE_URL;
    SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }
}

function ensureWorkspace() {
  fs.mkdirSync(BUILD_REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(BUILD_RESPONSES_DIR, { recursive: true });
  fs.mkdirSync(APPROVALS_DIR, { recursive: true });
  fs.mkdirSync(CANDIDATES_BY_ID_DIR, { recursive: true });
  if (!fs.existsSync(OVERRIDES_FILE)) {
    writeJsonAtomic(OVERRIDES_FILE, defaultOverrides());
  }
  if (!fs.existsSync(REVIEW_STATE_FILE)) {
    writeJsonAtomic(REVIEW_STATE_FILE, {
      service: 'marketing-overlay-service',
      review_state_version: 1,
      updated_at: new Date().toISOString(),
      action_count: 0,
      candidate_count: 0,
      candidates: {}
    });
  }
  if (!fs.existsSync(STATUS_FILE)) {
    writeStatus(false, { state: 'idle', initialized_at: new Date().toISOString() });
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tempPath, filePath);
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function sanitizeRequestId(value, fallback = 'marketing-build') {
  const raw = String(value || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || `${fallback}-${Date.now()}`;
}

function normalizeMode(value) {
  if (value === 'incremental') return 'incremental';
  return 'backfill';
}

function normalizeIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function clampPositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.round(num);
}

function normalizeBuildRequest(input, fallback) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    requestId: sanitizeRequestId(source.requestId || fallback || `marketing-build-${Date.now()}`),
    mode: normalizeMode(source.mode),
    days: clampPositiveInt(source.days, DEFAULT_BACKFILL_DAYS),
    since: normalizeIso(source.since),
    reason: String(source.reason || '').trim() || null
  };
}

function buildResponsePath(requestId) {
  return path.join(BUILD_RESPONSES_DIR, `${sanitizeRequestId(requestId)}.json`);
}

function isStableFile(filePath) {
  const stat = fs.statSync(filePath);
  return Date.now() - stat.mtimeMs >= REQUEST_STABILITY_MS;
}

function listPendingRequestFiles() {
  if (!fs.existsSync(BUILD_REQUESTS_DIR)) return [];
  return fs.readdirSync(BUILD_REQUESTS_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => path.join(BUILD_REQUESTS_DIR, name))
    .filter(filePath => {
      try {
        return isStableFile(filePath);
      } catch (_) {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

function cleanupOldBusFiles() {
  const cutoff = Date.now() - FILE_TTL_MS;
  for (const dir of [BUILD_REQUESTS_DIR, BUILD_RESPONSES_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      } catch (_) {
        // best effort cleanup
      }
    }
  }
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function uniqueValues(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function deriveProjectId(item) {
  return item?.po?.project_id || item?.quote?.project_id || item?.po?.projects?.id || item?.quote?.projects?.id || null;
}

function deriveCompletionAnchor(item) {
  return item.delivered_at || item.completed_at || item.work_completed_at || item.updated_at || item.created_at || null;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
}

function buildSinceFilterParam(sinceIso) {
  if (!sinceIso) return null;
  return `(updated_at.gte.${sinceIso},work_completed_at.gte.${sinceIso},completed_at.gte.${sinceIso},delivered_at.gte.${sinceIso})`;
}

function supabaseHeaders(extra) {
  return Object.assign({
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  }, extra || {});
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}) ${url}: ${text}`);
  }
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function supabaseGetAll(table, params, pageSize) {
  const baseUrl = `${SUPABASE_URL}/rest/v1/${table}?${params.toString()}`;
  const results = [];
  let from = 0;

  while (true) {
    const headers = supabaseHeaders({
      Range: `${from}-${from + pageSize - 1}`,
      'Range-Unit': 'items'
    });
    const page = await fetchJson(baseUrl, { headers });
    const rows = Array.isArray(page) ? page : [];
    results.push(...rows);
    if (rows.length < pageSize) break;
    from += rows.length;
  }

  return results;
}

async function fetchOrderItemsForStatus(status, sinceIso) {
  const params = new URLSearchParams();
  params.set('select', ORDER_ITEM_SELECT);
  params.set('status', `eq.${status}`);
  if (sinceIso) {
    params.set('or', buildSinceFilterParam(sinceIso));
  }
  params.set('order', 'updated_at.desc');
  return supabaseGetAll('order_items', params, ORDER_ITEMS_PAGE_SIZE);
}

async function fetchSourceItems(mode, { days, since }) {
  const effectiveSince = mode === 'incremental'
    ? since
    : isoDaysAgo(days);

  const pages = await Promise.all(QUALIFYING_STATUSES.map(status => fetchOrderItemsForStatus(status, effectiveSince)));
  const merged = [];
  const seen = new Set();

  for (const rows of pages) {
    for (const row of rows) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
  }

  const cutoffIso = mode === 'backfill' ? isoDaysAgo(days) : effectiveSince;
  return merged.filter(row => {
    const anchor = deriveCompletionAnchor(row);
    if (!cutoffIso) return true;
    if (!anchor) return false;
    return new Date(anchor).toISOString() >= cutoffIso;
  });
}

async function fetchItemSpecsMap(itemIds) {
  const specsByItem = {};
  const ids = uniqueValues(itemIds);
  if (ids.length === 0) return specsByItem;

  for (const group of chunk(ids, 75)) {
    const params = new URLSearchParams();
    params.set('select', ITEM_SPEC_SELECT);
    params.set('order_item_id', `in.(${group.join(',')})`);
    params.set('order', 'created_at.asc');
    const rows = await supabaseGetAll('item_specs', params, ITEM_SPECS_PAGE_SIZE);
    for (const row of rows) {
      if (!specsByItem[row.order_item_id]) specsByItem[row.order_item_id] = [];
      specsByItem[row.order_item_id].push(row);
    }
  }

  return specsByItem;
}

async function fetchProjectDesignersMap(projectIds) {
  const contactsByProject = {};
  const ids = uniqueValues(projectIds);
  if (ids.length === 0) return contactsByProject;

  for (const group of chunk(ids, 75)) {
    const params = new URLSearchParams();
    params.set('select', PROJECT_DESIGNER_SELECT);
    params.set('project_id', `in.(${group.join(',')})`);
    const rows = await supabaseGetAll('project_designers', params, PROJECT_DESIGNERS_PAGE_SIZE);
    for (const row of rows) {
      if (!contactsByProject[row.project_id]) contactsByProject[row.project_id] = [];
      if (row.designers?.email) {
        contactsByProject[row.project_id].push({
          name: row.designers.name || null,
          email: row.designers.email,
          source: 'project_designers'
        });
      }
    }
  }

  return contactsByProject;
}

function loadSummaryMap() {
  const payload = readJsonFile(CANDIDATES_SUMMARY_FILE, null);
  const index = new Map();
  for (const entry of payload?.candidates || []) {
    if (entry?.candidate_id) {
      index.set(entry.candidate_id, entry);
    }
  }
  return {
    payload,
    index
  };
}

function loadExistingCandidates(summaryPayload) {
  const candidates = [];
  for (const entry of summaryPayload?.candidates || []) {
    if (!entry?.candidate_id) continue;
    const detailPath = path.join(CANDIDATES_BY_ID_DIR, `${entry.candidate_id}.json`);
    const detail = readJsonFile(detailPath, null);
    if (detail && detail.source && detail.evidence) {
      candidates.push(detail);
    }
  }
  return candidates;
}

function approvalsFingerprint() {
  if (!fs.existsSync(APPROVALS_DIR)) return 'missing';
  return fs.readdirSync(APPROVALS_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => {
      const filePath = path.join(APPROVALS_DIR, name);
      const stat = fs.statSync(filePath);
      return `${name}:${stat.mtimeMs}`;
    })
    .join('|');
}

function applyReviewStateToCandidates(candidates, reviewStatePayload, nowIso) {
  const hydrated = candidates.map(candidate => applyReviewStateToCandidate(candidate, reviewStatePayload, nowIso));
  return sortCandidatesForQueue(hydrated);
}

function writeReviewState(reviewStatePayload) {
  writeJsonAtomic(REVIEW_STATE_FILE, reviewStatePayload);
  lastApprovalsFingerprint = approvalsFingerprint();
}

function syncReviewStateFromCurrentQueue(reason) {
  const existingSummary = loadSummaryMap();
  if (!existingSummary.payload) return false;
  const candidates = loadExistingCandidates(existingSummary.payload);
  const nowIso = new Date().toISOString();
  const reviewStatePayload = buildReviewStatePayload({
    actions: readApprovalActions(APPROVALS_DIR),
    candidates,
    nowIso
  });
  const hydratedCandidates = applyReviewStateToCandidates(candidates, reviewStatePayload, nowIso);
  upsertCandidateFiles(hydratedCandidates);
  writeReviewState(reviewStatePayload);
  const summaryPayload = buildSummaryPayload(hydratedCandidates, {
    mode: existingSummary.payload.mode,
    requestId: existingSummary.payload.request_id,
    generatedAt: existingSummary.payload.generated_at,
    reviewStateUpdatedAt: nowIso,
    days: existingSummary.payload.days,
    sourceSince: existingSummary.payload.source_since,
    stats: existingSummary.payload.stats,
    queueSortedCandidates: hydratedCandidates
  });
  writeJsonAtomic(CANDIDATES_SUMMARY_FILE, summaryPayload);
  if (reason) {
    log(`review state synced (${reason})`);
  }
  return true;
}

function removeFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {
    // best effort cleanup
  }
}

function upsertCandidateFiles(candidates) {
  for (const candidate of candidates) {
    const detailPath = path.join(CANDIDATES_BY_ID_DIR, `${candidate.candidate_id}.json`);
    writeJsonAtomic(detailPath, candidate);
  }
}

function pruneRemovedCandidates(existingIds, nextIds) {
  const nextSet = new Set(nextIds);
  for (const candidateId of existingIds) {
    if (!nextSet.has(candidateId)) {
      removeFileIfExists(path.join(CANDIDATES_BY_ID_DIR, `${candidateId}.json`));
    }
  }
}

function writeStatus(success, extra) {
  writeJsonAtomic(STATUS_FILE, Object.assign({
    success,
    service: 'marketing-overlay-service',
    state: isBuilding ? 'building' : (success ? 'idle' : 'degraded'),
    updated_at: new Date().toISOString(),
    last_build_started_at: lastBuildStartedAt,
    last_build_finished_at: lastBuildFinishedAt,
    last_successful_build_at: lastSuccessfulBuildAt,
    last_mode: lastMode,
    last_request_id: lastRequestId,
    last_source_since: lastSourceSince,
    last_candidate_count: lastCandidateCount,
    last_processed_item_count: lastProcessedItemCount,
    last_skipped_count: lastSkippedCount,
    last_error: lastError
  }, extra || {}));
}

async function executeBuild(request) {
  const normalized = normalizeBuildRequest(request);
  const startedAt = new Date().toISOString();
  const existingSummary = loadSummaryMap();
  const previousSuccessAt = readJsonFile(STATUS_FILE, null)?.last_successful_build_at || null;
  const effectiveSince = normalized.mode === 'incremental'
    ? (normalized.since || previousSuccessAt || null)
    : isoDaysAgo(normalized.days);

  lastBuildStartedAt = startedAt;
  lastRequestId = normalized.requestId;
  lastMode = normalized.mode;
  lastSourceSince = effectiveSince;
  lastError = null;
  writeStatus(false, {
    state: 'building',
    requested_mode: normalized.mode,
    requested_days: normalized.days,
    requested_since: normalized.since
  });

  const overrides = normalizeOverrides(readJsonFile(OVERRIDES_FILE, defaultOverrides()));
  const sourceItems = await fetchSourceItems(normalized.mode, {
    days: normalized.days,
    since: effectiveSince
  });
  const itemIds = sourceItems.map(item => item.id);
  const projectIds = sourceItems.map(deriveProjectId);
  const [specsByItem, contactsByProject] = await Promise.all([
    fetchItemSpecsMap(itemIds),
    fetchProjectDesignersMap(projectIds)
  ]);

  const built = buildCandidatePackets({
    items: sourceItems,
    specsByItem,
    contactsByProject,
    overrides,
    buildRequest: {
      requestId: normalized.requestId,
      mode: normalized.mode,
      days: normalized.days,
      since: effectiveSince,
      startedAt
    }
  });

  let nextCandidates = built.candidates.slice();
  if (normalized.mode === 'incremental' && existingSummary.payload?.candidates?.length) {
    const merged = new Map();
    for (const existingCandidate of loadExistingCandidates(existingSummary.payload)) {
      merged.set(existingCandidate.candidate_id, existingCandidate);
    }
    for (const candidate of built.candidates) {
      merged.set(candidate.candidate_id, candidate);
    }
    nextCandidates = Array.from(merged.values());
  }

  const reviewStatePayload = buildReviewStatePayload({
    actions: readApprovalActions(APPROVALS_DIR),
    candidates: nextCandidates,
    nowIso: new Date().toISOString()
  });
  nextCandidates = applyReviewStateToCandidates(nextCandidates, reviewStatePayload, reviewStatePayload.updated_at);

  upsertCandidateFiles(nextCandidates);
  if (normalized.mode === 'backfill') {
    pruneRemovedCandidates(existingSummary.index.keys(), nextCandidates.map(candidate => candidate.candidate_id));
  }

  writeReviewState(reviewStatePayload);
  const summaryPayload = buildSummaryPayload(nextCandidates, {
    mode: normalized.mode,
    requestId: normalized.requestId,
    generatedAt: new Date().toISOString(),
    reviewStateUpdatedAt: reviewStatePayload.updated_at,
    days: normalized.days,
    sourceSince: effectiveSince,
    stats: built.stats,
    queueSortedCandidates: nextCandidates
  });
  writeJsonAtomic(CANDIDATES_SUMMARY_FILE, summaryPayload);

  const finishedAt = new Date().toISOString();
  lastBuildFinishedAt = finishedAt;
  lastSuccessfulBuildAt = finishedAt;
  lastError = null;
  lastCandidateCount = nextCandidates.length;
  lastProcessedItemCount = built.stats.processed_items;
  lastSkippedCount = built.stats.skipped_items;
  writeStatus(true, {
    state: 'idle',
    written_candidate_count: normalized.mode === 'incremental' ? built.candidates.length : nextCandidates.length
  });

  const responsePayload = {
    success: true,
    service: 'marketing-overlay-service',
    requestId: normalized.requestId,
    mode: normalized.mode,
    started_at: startedAt,
    finished_at: finishedAt,
    source_since: effectiveSince,
    processed_items: built.stats.processed_items,
    candidate_count: nextCandidates.length,
    written_candidate_count: normalized.mode === 'incremental' ? built.candidates.length : nextCandidates.length,
    skipped_items: built.stats.skipped_items,
    skipped_reasons: built.stats.skipped_reasons,
    build_summary_file: 'candidates/summary.json'
  };

  writeJsonAtomic(buildResponsePath(normalized.requestId), responsePayload);
  log(`build ${normalized.requestId} (${normalized.mode}) wrote ${responsePayload.written_candidate_count} candidates`);
  return responsePayload;
}

function queueBuild(request) {
  buildQueue.push(normalizeBuildRequest(request));
  processBuildQueue();
}

async function processBuildQueue() {
  if (isBuilding || buildQueue.length === 0) return;
  const request = buildQueue.shift();
  isBuilding = true;
  try {
    await executeBuild(request);
  } catch (error) {
    lastBuildFinishedAt = new Date().toISOString();
    lastError = error instanceof Error ? error.message : String(error);
    writeStatus(false);
    writeJsonAtomic(buildResponsePath(request.requestId), {
      success: false,
      service: 'marketing-overlay-service',
      requestId: request.requestId,
      mode: request.mode,
      started_at: lastBuildStartedAt,
      finished_at: lastBuildFinishedAt,
      error: lastError
    });
    logError(`build ${request.requestId} failed: ${lastError}`);
  } finally {
    isBuilding = false;
    if (buildQueue.length > 0) {
      processBuildQueue();
    }
  }
}

function pollRequestFiles() {
  for (const filePath of listPendingRequestFiles()) {
    const basename = path.basename(filePath, '.json');
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      const requestId = sanitizeRequestId(basename);
      writeJsonAtomic(buildResponsePath(requestId), {
        success: false,
        service: 'marketing-overlay-service',
        requestId,
        error: `Invalid JSON request: ${error.message}`
      });
      removeFileIfExists(filePath);
      continue;
    }
    removeFileIfExists(filePath);
    queueBuild(Object.assign({}, payload, { requestId: payload.requestId || basename }));
  }
}

function pollApprovalFiles() {
  const fingerprint = approvalsFingerprint();
  if (fingerprint !== lastApprovalsFingerprint) {
    syncReviewStateFromCurrentQueue('approval update');
  }
}

function scheduleOverrideRebuild() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    queueBuild({
      requestId: `overrides-${Date.now()}`,
      mode: 'backfill',
      reason: 'overrides.json update'
    });
  }, DEBOUNCE_MS);
}

function watchOverrides() {
  fs.watchFile(OVERRIDES_FILE, { interval: POLL_MS }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      scheduleOverrideRebuild();
    }
  });
}

function startIncrementalTimer() {
  if (INCREMENTAL_INTERVAL_MS <= 0) return;
  incrementalTimer = setInterval(() => {
    queueBuild({
      requestId: `incremental-${Date.now()}`,
      mode: 'incremental',
      reason: 'periodic incremental refresh'
    });
  }, INCREMENTAL_INTERVAL_MS);
}

function startPollingLoop() {
  setInterval(() => {
    pollRequestFiles();
    pollApprovalFiles();
    cleanupOldBusFiles();
  }, POLL_MS);
}

function createHealthPayload() {
  return {
    status: lastError ? 'degraded' : 'ok',
    service: 'marketing-overlay-service',
    last_build_started_at: lastBuildStartedAt,
    last_build_finished_at: lastBuildFinishedAt,
    last_successful_build_at: lastSuccessfulBuildAt,
    last_mode: lastMode,
    last_request_id: lastRequestId,
    last_source_since: lastSourceSince,
    last_candidate_count: lastCandidateCount,
    last_processed_item_count: lastProcessedItemCount,
    last_skipped_count: lastSkippedCount,
    queue_depth: buildQueue.length,
    is_building: isBuilding,
    last_error: lastError
  };
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(createHealthPayload()));
      return;
    }

    if (req.method === 'POST' && req.url === '/build') {
      let body = '';
      req.on('data', chunkValue => {
        body += chunkValue.toString();
      });
      req.on('end', () => {
        let payload = {};
        try {
          if (body.trim()) payload = JSON.parse(body);
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Invalid JSON: ${error.message}` }));
          return;
        }
        const request = normalizeBuildRequest(payload, `http-build-${Date.now()}`);
        queueBuild(request);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          requestId: request.requestId,
          mode: request.mode,
          response_file: `build-responses/${request.requestId}.json`
        }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, '0.0.0.0', () => {
    log(`service running on port ${PORT}`);
    log(`workspace ${DATA_DIR}`);
    log(`health http://localhost:${PORT}/health`);
  });
}

async function runOnceFromCli() {
  const modeFlagIndex = process.argv.indexOf('--mode');
  const daysFlagIndex = process.argv.indexOf('--days');
  const sinceFlagIndex = process.argv.indexOf('--since');
  const request = normalizeBuildRequest({
    requestId: `once-${Date.now()}`,
    mode: modeFlagIndex !== -1 ? process.argv[modeFlagIndex + 1] : 'backfill',
    days: daysFlagIndex !== -1 ? process.argv[daysFlagIndex + 1] : DEFAULT_BACKFILL_DAYS,
    since: sinceFlagIndex !== -1 ? process.argv[sinceFlagIndex + 1] : null,
    reason: 'cli once'
  });
  try {
    await executeBuild(request);
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function main() {
  ensureWorkspace();
  loadEnvIfNeeded();
  lastApprovalsFingerprint = approvalsFingerprint();

  if (process.argv.includes('--once')) {
    await runOnceFromCli();
    return;
  }

  startServer();
  watchOverrides();
  startPollingLoop();
  startIncrementalTimer();
  syncReviewStateFromCurrentQueue('startup');
  queueBuild({
    requestId: `startup-${Date.now()}`,
    mode: normalizeMode(process.env.MARKETING_STARTUP_MODE || 'backfill'),
    reason: 'startup build'
  });
}

main().catch(error => {
  logError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
