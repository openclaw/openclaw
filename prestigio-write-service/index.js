const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SHARED_DESCRIPTION_GENERATOR_PATH =
  process.env.QUOTE_DESCRIPTION_GENERATORS_PATH || '/app/quote-description-generators.js';
const loadedQuoteDescriptionGenerators = require(SHARED_DESCRIPTION_GENERATOR_PATH);
const quoteDescriptionGenerators = Object.keys(loadedQuoteDescriptionGenerators || {}).length
  ? loadedQuoteDescriptionGenerators
  : globalThis.PrestigioQuoteDescriptionGenerators;

// --- Config ---
const PORT = 3006;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MOUNT_PATH = process.env.MOUNT_PATH || '/data';
const LEGACY_REQUEST_FILE = path.join(MOUNT_PATH, 'write-request.json');
const LEGACY_RESPONSE_FILE = path.join(MOUNT_PATH, 'write-response.json');
const REQUEST_DIR = path.join(MOUNT_PATH, 'write-requests');
const RESPONSE_DIR = path.join(MOUNT_PATH, 'write-responses');
const POLL_INTERVAL_MS = 1000;
const REQUEST_STABILITY_MS = 250;
const FILE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_QUOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const QUOTE_IMAGE_BUCKET = 'quote-images';
const PASSTHROUGH_MULT = Number(process.env.PRESTIGIO_PASSTHROUGH_MULT || 1.337);
const MATERIALS_MULT = Number(process.env.PRESTIGIO_MATERIALS_MULT || 1.667);
const PRESTIGIO_APP_BASE_URL = (process.env.PRESTIGIO_APP_BASE_URL || 'https://app.prestigio.la').replace(/\/+$/, '');

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const HEADERS = {
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json'
};

function ensureBusDirs() {
  fs.mkdirSync(REQUEST_DIR, { recursive: true });
  fs.mkdirSync(RESPONSE_DIR, { recursive: true });
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function sanitizeRequestId(value, fallback = 'write') {
  const raw = String(value || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || `${fallback}-${Date.now()}`;
}

function responsePathForRequest(requestId) {
  return path.join(RESPONSE_DIR, `${sanitizeRequestId(requestId)}.json`);
}

function writeResponse(data, { requestId, legacy = false } = {}) {
  const payload = requestId ? { ...data, requestId } : data;
  if (requestId) {
    writeJsonAtomic(responsePathForRequest(requestId), payload);
  }
  if (legacy || !requestId) {
    writeJsonAtomic(LEGACY_RESPONSE_FILE, payload);
  }
}

function buildModernQuoteUrl(quoteId) {
  return quoteId ? `${PRESTIGIO_APP_BASE_URL}/quote-v2.html?edit=${encodeURIComponent(quoteId)}` : null;
}

function isStableFile(filePath) {
  const stat = fs.statSync(filePath);
  return Date.now() - stat.mtimeMs >= REQUEST_STABILITY_MS;
}

function listPendingRequestFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => path.join(dir, name))
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
  for (const dir of [REQUEST_DIR, RESPONSE_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      } catch (_) {
        // best effort cleanup
      }
    }
  }
}

// --- Action field definitions ---
const ACTION_FIELDS = {
  'set-hold': ['item_id', 'hold_reason', 'hold_contact', 'hold_follow_up_date'],
  'clear-hold': ['item_id'],
  'append-note': ['item_id', 'title', 'body'],
  'rename-item': ['item_id', 'sidemark'],
  'mark-received': ['item_id'],
  'mark-not-received': ['item_id'],
  'set-order-item-production-field': ['item_id', 'field', 'value', 'confirmed', 'confirm_digest'],
  'set-item-spec-field': ['item_id', 'spec_id', 'field', 'value', 'confirmed', 'confirm_digest'],
  'apply-credit': ['order_item_id', 'xero_contact_id', 'xero_invoice_id', 'amount', 'description', 'source_context', 'reference', 'requested_at'],
  'search-xero-invoices': ['search', 'contact_id', 'invoice_number', 'statuses', 'requested_at'],
  'search-xero-quotes': ['search', 'contact_id', 'quote_number', 'statuses', 'requested_at'],
  'search-xero-bank-transactions': ['search', 'contact_id', 'from_date', 'to_date', 'reference', 'requested_at'],
  'search-xero-credit-notes': ['search', 'contact_id', 'credit_note_number', 'statuses', 'requested_at'],
  'create-invoice': ['xero_contact_id', 'reference', 'line_items', 'due_days', 'requested_at'],
  'record-payment': ['payments', 'check_date', 'payment_method', 'check_number', 'account_id', 'requested_at'],
  'email-invoice': ['invoice_id', 'requested_at'],
  'send-invoice-email': ['invoiceId', 'xeroInvoiceId', 'xeroInvoiceNumber', 'ccEmails', 'recipientOverrideEmails', 'requested_at'],
  'create-xero-contact': ['client_id', 'name', 'company', 'email', 'phone', 'source_context', 'requested_at', 'confirmed', 'confirm_digest'],
  'create-client-project': ['client', 'project', 'source_context', 'requested_at', 'confirmed', 'confirm_digest'],
  'create-draft-quote': ['quote', 'items', 'source_context', 'requested_at', 'confirmed', 'confirm_digest'],
  'revise-existing-quote': ['quote', 'revision_reason', 'operations', 'expected', 'source_context', 'requested_at', 'confirmed', 'confirm_digest']
};

const CONFIRMABLE_ACTIONS = ['set-order-item-production-field', 'set-item-spec-field', 'create-client-project', 'create-draft-quote', 'create-xero-contact', 'revise-existing-quote'];

function computeConfirmDigest(action, params) {
  const secret = process.env.STITCH_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!secret) {
    return null;
  }
  let canonical;

  if (action === 'set-order-item-production-field') {
    canonical = `${action}:${params.item_id}:${params.field}:${JSON.stringify(params.value)}`;
  } else if (action === 'set-item-spec-field') {
    canonical = `${action}:${params.item_id}:${params.spec_id}:${params.field}:${JSON.stringify(params.value)}`;
  } else if (action === 'create-client-project') {
    canonical = `${action}:${JSON.stringify(params.client || {})}:${JSON.stringify(params.project || {})}`;
  } else if (action === 'create-draft-quote') {
    canonical = `${action}:${JSON.stringify(params.quote || {})}:${JSON.stringify(params.items || [])}`;
  } else if (action === 'create-xero-contact') {
    canonical = `${action}:${params.client_id}:${params.name || ''}:${params.company || ''}:${params.email || ''}:${params.phone || ''}`;
  } else if (action === 'revise-existing-quote') {
    const plan = buildQuoteRevisionPlanFromRequest(params);
    if (!plan) return null;
    canonical = stableJson(plan);
  } else {
    return null;
  }

  return crypto.createHmac('sha256', secret).update(canonical).digest('base64url');
}

function buildConfirmSummary(action, params) {
  if (action === 'set-order-item-production-field') {
    return `Set ${params.field} to ${JSON.stringify(params.value)} on item ${params.item_id}`;
  }
  if (action === 'set-item-spec-field') {
    return `Set ${params.field} to ${JSON.stringify(params.value)} on spec ${params.spec_id} (item ${params.item_id})`;
  }
  if (action === 'create-draft-quote') {
    const quote = params.quote || {};
    const items = Array.isArray(params.items) ? params.items : [];
    const sidemark = quote.sidemark || quote.project_name || quote.client_name || 'Untitled quote';
    const itemTotal = sumDraftQuoteItems(items);
    const siteVisitTotal = getDraftQuoteSiteVisitTotal(quote);
    const total = Math.round((itemTotal + siteVisitTotal) * 100) / 100;
    const siteVisitText = siteVisitTotal > 0 ? ` including ${formatMoney(siteVisitTotal)} site visit` : '';
    return `Create draft quote "${sidemark}" with ${items.length} item(s), total ${formatMoney(total)}${siteVisitText}${summarizeDraftQuotePricingModes(items)}`;
  }
  if (action === 'create-client-project') {
    const client = params.client || {};
    const project = params.project || {};
    const clientName = client.company || client.name || 'Unnamed client';
    const projectName = project.name ? ` and project "${project.name}"` : '';
    return `Create client "${clientName}"${projectName}`;
  }
  if (action === 'create-xero-contact') {
    const label = params.company || params.name || params.client_id || 'client';
    return `Create or link Xero contact "${label}"`;
  }
  if (action === 'revise-existing-quote') {
    const plan = buildQuoteRevisionPlanFromRequest(params);
    if (!plan) return 'Revise existing quote';
    return summarizeQuoteRevisionPlan(plan);
  }
  return `${action} on ${params.item_id}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sumDraftQuoteItems(items) {
  if (!Array.isArray(items)) return 0;
  return Math.round(items.reduce((sum, item) => {
    const normalized = normalizeDraftItem(item, 0);
    const qty = Number(normalized.quantity) || 1;
    const price = Number(normalized.sell_price ?? normalized.price ?? normalized.total ?? 0) || 0;
    return sum + (qty * price);
  }, 0) * 100) / 100;
}

function getDraftQuoteSiteVisitTotal(quote = {}) {
  const explicitTotal = Number(quote.site_visit_total);
  if (Number.isFinite(explicitTotal) && explicitTotal > 0) {
    return Math.round(explicitTotal * 100) / 100;
  }
  const hours = Number(quote.site_visit_hours);
  const rate = Number(quote.site_visit_rate);
  if (Number.isFinite(hours) && hours > 0 && Number.isFinite(rate) && rate > 0) {
    return Math.round(hours * rate * 100) / 100;
  }
  return 0;
}

function summarizeDraftQuotePricingModes(items) {
  if (!Array.isArray(items) || !items.length) return '';
  let manual = 0;
  let calculated = 0;
  for (const item of items) {
    if (item && typeof item === 'object' && item.sell_price !== undefined) {
      manual += 1;
    } else if (item && typeof item === 'object' && (item.cost_breakdown || item.lineItems)) {
      calculated += 1;
    }
  }
  const parts = [];
  if (calculated > 0) parts.push(`${calculated} calculated from cost breakdown`);
  if (manual > 0) parts.push(`${manual} manual/client-facing sell price`);
  return parts.length ? `; pricing: ${parts.join(', ')}` : '';
}

function formatMoney(value) {
  return `$${(Number(value) || 0).toFixed(2)}`;
}

function roundQuoteBuilderPrice(raw) {
  const value = Number(raw) || 0;
  const targets = [0, 10, 50, 95];
  const base = Math.floor(value / 100) * 100;
  const remainder = value - base;

  let bestTarget = 0;
  let bestDist = Infinity;
  for (const target of targets) {
    const dist = Math.abs(remainder - target);
    if (dist < bestDist || (dist === bestDist && target > bestTarget)) {
      bestDist = dist;
      bestTarget = target;
    }
  }

  if (100 - remainder < bestDist) return base + 100;
  return base + bestTarget;
}

function quoteRevisionLineRaw(line) {
  const value = cleanObject(line) || {};
  if (value.raw !== undefined && value.raw !== null) return Number(value.raw) || 0;
  const qty = Number(value.qty ?? value.quantity ?? value.hours ?? 0) || 0;
  const rate = Number(value.rate ?? 0) || 0;
  return qty * rate;
}

function normalizeQuoteRevisionCostBreakdownLines(costBreakdown) {
  const breakdown = cleanObject(costBreakdown);
  if (!breakdown) return breakdown;
  const normalized = {};
  for (const [key, line] of Object.entries(breakdown)) {
    const lineObject = cleanObject(line);
    if (!lineObject) {
      normalized[key] = line;
      continue;
    }
    const nextLine = { ...lineObject };
    if (nextLine.quantity !== undefined) {
      nextLine.qty = nextLine.quantity;
    }
    const qty = Number(nextLine.qty ?? nextLine.quantity ?? nextLine.hours);
    const rate = Number(nextLine.rate);
    if (Number.isFinite(qty) && Number.isFinite(rate)) {
      const raw = qty * rate;
      nextLine.raw = raw;
      if (Number.isFinite(Number(nextLine.multiplier))) {
        nextLine.final = raw * Number(nextLine.multiplier);
      }
    }
    normalized[key] = nextLine;
  }
  return normalized;
}

function calculateReupholsteryUnitPriceFromBreakdown(costBreakdown) {
  const breakdown = cleanObject(costBreakdown);
  if (!breakdown) return null;

  const passThroughRaw = ['springs', 'webbing', 'frame']
    .reduce((sum, key) => sum + quoteRevisionLineRaw(breakdown[key]), 0);
  const materialsRaw = ['seat_foam', 'back_foam', 'seat_fill', 'back_fill', 'foam', 'fill']
    .reduce((sum, key) => sum + quoteRevisionLineRaw(breakdown[key]), 0);
  const labor = breakdown.labor_upholstery || breakdown.labor;
  const laborRaw = quoteRevisionLineRaw(labor);

  const unitRaw = (passThroughRaw * PASSTHROUGH_MULT) + (materialsRaw * MATERIALS_MULT) + laborRaw;
  if (unitRaw <= 0) return null;
  return roundQuoteBuilderPrice(unitRaw);
}

function calculatePillowUnitPriceFromBreakdown(costBreakdown, quantity) {
  if (
    quoteDescriptionGenerators &&
    typeof quoteDescriptionGenerators.calculatePillowUnitPriceFromBreakdown === 'function'
  ) {
    return quoteDescriptionGenerators.calculatePillowUnitPriceFromBreakdown(costBreakdown, quantity);
  }

  const breakdown = cleanObject(costBreakdown);
  if (!breakdown) return null;
  const fillRaw = quoteRevisionLineRaw(breakdown.fill);
  const labor = breakdown.labor_upholstery || breakdown.labor;
  const laborRaw = quoteRevisionLineRaw(labor);
  const fabric = breakdown.fabric || {};
  const fabricRaw = Number(fabric.raw) || ((Number(fabric.yardage ?? fabric.qty) || 0) * (Number(fabric.costPerYard ?? fabric.rate) || 0));
  const itemQty = Math.max(1, Number(quantity) || 1);
  const unitRaw = (fillRaw * MATERIALS_MULT) + laborRaw + (fabricRaw / itemQty);
  if (unitRaw <= 0) return null;
  return Math.round(unitRaw / 5) * 5;
}

function calculateCushionUnitPriceFromBreakdown(costBreakdown) {
  if (
    quoteDescriptionGenerators &&
    typeof quoteDescriptionGenerators.calculateCushionUnitPriceFromBreakdown === 'function'
  ) {
    return quoteDescriptionGenerators.calculateCushionUnitPriceFromBreakdown(costBreakdown);
  }

  const breakdown = cleanObject(costBreakdown);
  if (!breakdown) return null;
  const foamRaw = quoteRevisionLineRaw(breakdown.foam);
  const fillRaw = quoteRevisionLineRaw(breakdown.fill);
  const labor = breakdown.labor_upholstery || breakdown.labor;
  const laborRaw = quoteRevisionLineRaw(labor);
  const fabric = breakdown.fabric || {};
  const fabricRaw = Number(fabric.raw) || ((Number(fabric.yardage ?? fabric.qty) || 0) * (Number(fabric.costPerYard ?? fabric.rate) || 0));
  const unitRaw = ((foamRaw + fillRaw) * MATERIALS_MULT) + laborRaw + fabricRaw;
  if (unitRaw <= 0) return null;
  return roundQuoteBuilderPrice(unitRaw);
}

function calculateSeatingUnitPriceFromBreakdown(costBreakdown) {
  if (
    quoteDescriptionGenerators &&
    typeof quoteDescriptionGenerators.calculateSeatingUnitPriceFromBreakdown === 'function'
  ) {
    return quoteDescriptionGenerators.calculateSeatingUnitPriceFromBreakdown(costBreakdown);
  }

  const breakdown = cleanObject(costBreakdown);
  if (!breakdown) return null;
  const passThroughRaw = ['frame', 'springs', 'legs']
    .reduce((sum, key) => sum + quoteRevisionLineRaw(breakdown[key]), 0);
  const materialsRaw = ['seat_foam', 'back_foam', 'seat_fill', 'back_fill', 'frame_padding', 'arm_foam']
    .reduce((sum, key) => sum + quoteRevisionLineRaw(breakdown[key]), 0);
  const labor = breakdown.labor_upholstery || breakdown.labor;
  const laborRaw = quoteRevisionLineRaw(labor);
  const swivelRaw = quoteRevisionLineRaw(breakdown.swivel);
  const slipcoverRaw = quoteRevisionLineRaw(breakdown.slipcover);
  const fabric = breakdown.fabric || {};
  const fabricRaw = Number(fabric.raw) || ((Number(fabric.yardage ?? fabric.qty) || 0) * (Number(fabric.costPerYard ?? fabric.rate) || 0));
  const unitRaw = (passThroughRaw * PASSTHROUGH_MULT) + (materialsRaw * MATERIALS_MULT) + laborRaw + swivelRaw + slipcoverRaw + fabricRaw;
  if (unitRaw <= 0) return null;
  return roundQuoteBuilderPrice(unitRaw);
}

function calculateBedUnitPriceFromBreakdown(costBreakdown) {
  if (
    quoteDescriptionGenerators &&
    typeof quoteDescriptionGenerators.calculateBedUnitPriceFromBreakdown === 'function'
  ) {
    return quoteDescriptionGenerators.calculateBedUnitPriceFromBreakdown(costBreakdown);
  }

  const breakdown = cleanObject(costBreakdown);
  if (!breakdown) return null;
  const passThroughRaw = ['frame', 'legs']
    .reduce((sum, key) => sum + quoteRevisionLineRaw(breakdown[key]), 0);
  const materialsRaw = quoteRevisionLineRaw(breakdown.foam);
  const labor = breakdown.labor_upholstery || breakdown.labor;
  const laborRaw = quoteRevisionLineRaw(labor);
  const slipcoverRaw = quoteRevisionLineRaw(breakdown.slipcover);
  const fabric = breakdown.fabric || {};
  const fabricRaw = Number(fabric.raw) || ((Number(fabric.yardage ?? fabric.qty) || 0) * (Number(fabric.costPerYard ?? fabric.rate) || 0));
  const unitRaw = (passThroughRaw * PASSTHROUGH_MULT) + (materialsRaw * MATERIALS_MULT) + laborRaw + fabricRaw + slipcoverRaw;
  if (unitRaw <= 0) return null;
  return roundQuoteBuilderPrice(unitRaw);
}

function calculateOttomanUnitPriceFromBreakdown(costBreakdown) {
  if (
    quoteDescriptionGenerators &&
    typeof quoteDescriptionGenerators.calculateOttomanUnitPriceFromBreakdown === 'function'
  ) {
    return quoteDescriptionGenerators.calculateOttomanUnitPriceFromBreakdown(costBreakdown);
  }

  const breakdown = cleanObject(costBreakdown);
  if (!breakdown) return null;
  const passThroughRaw = ['frame', 'legs']
    .reduce((sum, key) => sum + quoteRevisionLineRaw(breakdown[key]), 0);
  const materialsRaw = ['foam', 'wrap']
    .reduce((sum, key) => sum + quoteRevisionLineRaw(breakdown[key]), 0);
  const labor = breakdown.labor_upholstery || breakdown.labor;
  const laborRaw = quoteRevisionLineRaw(labor);
  const slipcoverRaw = quoteRevisionLineRaw(breakdown.slipcover);
  const unitRaw = (passThroughRaw * PASSTHROUGH_MULT) + (materialsRaw * MATERIALS_MULT) + laborRaw + slipcoverRaw;
  if (unitRaw <= 0) return null;
  return roundQuoteBuilderPrice(unitRaw);
}

function calculateSoftgoodsUnitPriceFromBreakdown(costBreakdown) {
  if (
    quoteDescriptionGenerators &&
    typeof quoteDescriptionGenerators.calculateSoftgoodsUnitPriceFromBreakdown === 'function'
  ) {
    return quoteDescriptionGenerators.calculateSoftgoodsUnitPriceFromBreakdown(costBreakdown);
  }

  const breakdown = cleanObject(costBreakdown);
  if (!breakdown) return null;
  const labor = breakdown.labor_upholstery || breakdown.labor;
  const laborRaw = quoteRevisionLineRaw(labor);
  const fabric = breakdown.fabric || {};
  const fabricRaw = Number(fabric.raw) || ((Number(fabric.yardage ?? fabric.qty) || 0) * (Number(fabric.costPerYard ?? fabric.rate) || 0));
  const unitRaw = laborRaw + fabricRaw;
  if (unitRaw <= 0) return null;
  return roundQuoteBuilderPrice(unitRaw);
}

function calculatePatioUnitPriceFromBreakdown(costBreakdown) {
  if (
    quoteDescriptionGenerators &&
    typeof quoteDescriptionGenerators.calculatePatioUnitPriceFromBreakdown === 'function'
  ) {
    return quoteDescriptionGenerators.calculatePatioUnitPriceFromBreakdown(costBreakdown);
  }

  const breakdown = cleanObject(costBreakdown);
  if (!breakdown) return null;
  const materialsRaw = ['seat_foam', 'seat_fill', 'back_fill']
    .reduce((sum, key) => sum + quoteRevisionLineRaw(breakdown[key]), 0);
  const labor = breakdown.labor_upholstery || breakdown.labor;
  const laborRaw = quoteRevisionLineRaw(labor);
  const fabric = breakdown.fabric || {};
  const fabricRaw = Number(fabric.raw) || ((Number(fabric.yardage ?? fabric.qty) || 0) * (Number(fabric.costPerYard ?? fabric.rate) || 0));
  const unitRaw = (materialsRaw * MATERIALS_MULT) + laborRaw + fabricRaw;
  if (unitRaw <= 0) return null;
  return roundQuoteBuilderPrice(unitRaw);
}

function calculateRestuffingUnitPriceFromBreakdown(costBreakdown, quantity) {
  if (
    quoteDescriptionGenerators &&
    typeof quoteDescriptionGenerators.calculateRestuffingUnitPriceFromBreakdown === 'function'
  ) {
    return quoteDescriptionGenerators.calculateRestuffingUnitPriceFromBreakdown(costBreakdown, quantity);
  }

  const breakdown = cleanObject(costBreakdown);
  if (!breakdown) return null;
  const fillRaw = quoteRevisionLineRaw(breakdown.fill);
  const labor = breakdown.labor_upholstery || breakdown.labor;
  const laborRaw = quoteRevisionLineRaw(labor);
  const coverRaw = quoteRevisionLineRaw(breakdown.cover);
  const itemQty = Math.max(1, Number(quantity) || 1);
  const unitRaw = ((fillRaw * MATERIALS_MULT) + laborRaw + coverRaw) / itemQty;
  if (unitRaw <= 0) return null;
  return roundQuoteBuilderPrice(unitRaw);
}

function cleanText(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function cleanObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function cleanArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanEmail(value) {
  const text = cleanText(value, 320);
  if (!text) return null;
  return text.includes('@') ? text.toLowerCase() : null;
}

function buildDraftQuoteDescription(items) {
  return (items || [])
    .map(item => cleanText(item.description, 500))
    .filter(Boolean)
    .join('; ')
    .slice(0, 3000) || null;
}

function buildQuoteRevisionPlanFromRequest(params) {
  const quote = cleanObject(params.quote) || {};
  const operations = cleanArray(params.operations);
  return {
    action: 'revise-existing-quote',
    quote: {
      quote_id: cleanText(quote.quote_id || quote.id, 100),
      xero_quote_number: cleanText(quote.xero_quote_number, 100),
      quote_number: cleanText(quote.quote_number, 100)
    },
    revision_reason: cleanText(params.revision_reason, 1000),
    operations: operations.map(op => ({
      op: cleanText(op.op, 100),
      item_id: cleanText(op.item_id, 100),
      reason: cleanText(op.reason, 1000),
      updates: cleanObject(op.updates) || null
    })),
    expected: cleanObject(params.expected) || null,
    source_context: cleanObject(params.source_context) || null
  };
}

function summarizeQuoteRevisionPlan(plan) {
  const quoteLabel =
    plan.quote.xero_quote_number ||
    plan.quote.quote_number ||
    plan.quote.quote_id ||
    'existing quote';
  const removeOps = cleanArray(plan.operations).filter(op => op.op === 'remove_item');
  const updateOps = cleanArray(plan.operations).filter(op => op.op === 'update_item');
  const expected = cleanObject(plan.expected) || {};
  const totalText = expected.before_total !== undefined && expected.after_total !== undefined
    ? ` Total ${formatMoney(expected.before_total)} -> ${formatMoney(expected.after_total)}.`
    : '';
  return `Revise ${quoteLabel}: remove ${removeOps.length} quote item(s), update ${updateOps.length} quote item(s).${totalText}`;
}

const REUPHOLSTERY_TYPE_LABELS = {
  sofa: 'SOFA',
  chair: 'CHAIR',
  sectional: 'SECTIONAL',
  loveseat: 'LOVESEAT',
  ottoman: 'OTTOMAN',
  bench: 'BENCH',
  headboard: 'HEADBOARD',
  antique: 'ANTIQUE PIECE',
  chaise_lounge: 'CHAISE LOUNGE',
  cushion_pad: 'CUSHION PAD',
  barstool: 'BARSTOOL',
  fully_upholstered_bed: 'FULLY UPHOLSTERED BED'
};

const REUPHOLSTERY_SCOPE_LABELS = {
  full: 'FULL REUPHOLSTERY',
  'seat-only': 'SEAT ONLY',
  'back-only': 'BACK ONLY',
  'cushions-only': 'CUSHIONS ONLY',
  'arms-only': 'ARMS ONLY',
  partial: 'PARTIAL REUPHOLSTERY'
};

const REUPHOLSTERY_CONDITION_LABELS = {
  excellent: 'EXCELLENT - SWAP FABRIC ONLY',
  good: 'GOOD - NEW FABRIC + NEW FILLS',
  fair: 'FAIR - NEW FABRIC, FILLS, AND MINOR FRAME REPAIRS',
  poor: 'POOR - FULL STRIP-DOWN AND MAJOR RESTORATION'
};

const REUPHOLSTERY_VALID = {
  type: new Set(Object.keys(REUPHOLSTERY_TYPE_LABELS)),
  scope: new Set(Object.keys(REUPHOLSTERY_SCOPE_LABELS)),
  condition: new Set(Object.keys(REUPHOLSTERY_CONDITION_LABELS)),
  materialType: new Set(['fabric', 'leather']),
  seatStyle: new Set(['tight', 'loose', 'attached']),
  backStyle: new Set(['tight', 'loose-back-cushion', 'loose-pillow', 'attached-pillow', 'channeled', 'tufted']),
  seam: new Set(['not-specified', 'blind-seam', 'self-welt', 'contrast-welt', 'double-welt', 'single-topstitch', 'double-topstitch', 'cot', 'flange']),
  insert: new Set(['foam', 'foam-dacron', 'down-25', 'down-50', 'angel-hair', 'elite-fiber', 'spring-down']),
  foamType: new Set(['dryfast', 'foam18', 'hrfoam']),
  foamThickness: new Set(['1', '2', '3', '4', '5', '6'])
};

function normalizeKey(value) {
  return cleanText(value, 100)?.toLowerCase().replace(/\s+/g, '-').replace(/_/g, '-') || '';
}

function normalizeReupholsteryType(value) {
  const raw = cleanText(value, 100) || '';
  const normalized = normalizeKey(raw);
  if (REUPHOLSTERY_VALID.type.has(normalized)) return normalized;
  if (normalized === 'reupholstery' || normalized === 'reupholster-sofa') return 'sofa';
  if (normalized.includes('sofa')) return 'sofa';
  return normalized;
}

function assertAllowed(field, value, allowed, { required = false } = {}) {
  const normalized = normalizeKey(value);
  if (!normalized) {
    if (required) {
      throw new Error(`${field} is required. Valid options: ${Array.from(allowed).join(', ')}`);
    }
    return '';
  }
  if (!allowed.has(normalized)) {
    throw new Error(`Invalid ${field}: ${value}. Valid options: ${Array.from(allowed).join(', ')}`);
  }
  return normalized;
}

function titleCaseLabel(value) {
  return String(value || '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function formatReupholsteryMaterial(material, fallbackType = 'fabric') {
  const mat = cleanObject(material) || {};
  const type = normalizeKey(mat.type || fallbackType) === 'leather' ? 'COL' : 'COM';
  const yardage = toNullableNumber(mat.yardage);
  const name = cleanText(mat.name, 300) || (type === 'COL' ? 'COL' : 'COM');
  const usage = cleanText(mat.usage, 200);
  const yardInfo = yardage !== null ? `${yardage} YD, ` : '';
  return `${type}: (${yardInfo}${name})${usage ? ` - ${usage.toUpperCase()}` : ''}`;
}

function formatFill(fill) {
  const fillMap = {
    'down-25': '25/75',
    'down-50': '50/50',
    'angel-hair': 'ANGEL HAIR',
    'elite-fiber': 'ELITE FIBER',
    foam: 'FOAM',
    'foam-dacron': 'FOAM DACRON',
    'spring-down': 'ENVELOPE W/ MARSHALL SPRINGS'
  };
  return fillMap[normalizeKey(fill)] || titleCaseLabel(fill).toUpperCase();
}

function formatInsert(insert) {
  const labels = {
    foam: 'Foam',
    'foam-dacron': 'Foam + Dacron',
    'down-25': '25/75 Down & Feather',
    'down-50': '50/50 Down & Feather',
    'angel-hair': 'Angel Hair',
    'elite-fiber': 'Elite Fiber',
    'spring-down': 'Envelope w/ Marshall Springs'
  };
  return labels[normalizeKey(insert)] || titleCaseLabel(insert);
}

function formatSeam(seam) {
  const labels = {
    'not-specified': 'Not Specified',
    'blind-seam': 'Blind Seam',
    'self-welt': 'Self Welt',
    'contrast-welt': 'Contrast Welt',
    'double-welt': 'Double Welt',
    'single-topstitch': 'Single Topstitch',
    'double-topstitch': 'Double Topstitch',
    cot: 'COT (Cord on Trim)',
    flange: 'Flange'
  };
  return labels[normalizeKey(seam)] || titleCaseLabel(seam);
}

function buildReupholsteryDescription(formData, item) {
  return quoteDescriptionGenerators.generateReupholsteryDescription({
    ...item,
    ...formData,
    type: formData.reupholsteryType || formData.type || item.type || item.item_type,
    materialType: formData.materialType || item.materialType || 'fabric',
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials),
    notes: formData.clientVisibleNotes || item.client_visible_notes || item.quote_notes
  });
}

const REUPHOLSTERY_BOOLEAN_FIELD_MAP = {
  new_foam: 'newFoam',
  new_springs: 'newSprings',
  new_webbing: 'newWebbing',
  frame_repair: 'frameRepair',
  new_fill: 'newFill',
  strip_old: 'stripOld',
  tufting: 'tufting',
  nailheads: 'nailheads'
};

function syncReupholsteryFormBooleans(formData, item) {
  const synced = { ...(cleanObject(formData) || {}) };
  for (const [columnKey, formKey] of Object.entries(REUPHOLSTERY_BOOLEAN_FIELD_MAP)) {
    if (item[columnKey] !== undefined && synced[formKey] === undefined) {
      synced[formKey] = Boolean(item[columnKey]);
    }
  }
  return synced;
}

function normalizePillowType(value) {
  const normalized = normalizeKey(value);
  if (!normalized) return 'throw';
  if (normalized === 'knife-edge' || normalized === 'lumbar' || normalized === 'euro' || normalized === 'pillow') return 'throw';
  return normalized;
}

function normalizeCushionType(value) {
  const normalized = normalizeKey(value);
  if (!normalized) return 'bench';
  if (normalized === 'seat' || normalized === 'seat-cushion' || normalized === 'sofa-cushion' || normalized === 'bench-seat') return 'bench';
  if (normalized === 'window-seat-cushion') return 'window-seat';
  if (normalized === 'chair-pad-cushion' || normalized === 'seat-pad') return 'chair-pad';
  return normalized;
}

function buildPillowDescription(formData, item) {
  return quoteDescriptionGenerators.generatePillowDescription({
    ...item,
    ...formData,
    type: formData.pillowType || formData.type || item.type || item.item_type,
    fill: formData.pillowFill || formData.fill || item.fill,
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials)
  });
}

function buildCushionDescription(formData, item) {
  return quoteDescriptionGenerators.generateCushionDescription({
    ...item,
    ...formData,
    type: formData.cushionType || formData.type || item.type || item.item_type,
    fill: formData.cushionFill || formData.fill || item.fill,
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials)
  });
}

function normalizeReupholsteryDraftItem(item, index) {
  const formData = cleanObject(item.form_data) || {};
  const type = normalizeReupholsteryType(formData.reupholsteryType || item.reupholsteryType || item.type || item.item_type || item.item_name);
  const normalizedFormData = {
    ...formData,
    category: 'reupholstery',
    reupholsteryType: type,
    materialType: assertAllowed('reupholstery materialType', formData.materialType || item.materialType || 'fabric', REUPHOLSTERY_VALID.materialType, { required: true }),
    scope: assertAllowed('reupholstery scope', formData.scope || item.scope, REUPHOLSTERY_VALID.scope, { required: true }),
    condition: assertAllowed('reupholstery condition', formData.condition || item.condition, REUPHOLSTERY_VALID.condition, { required: true }),
    width: toNullableNumber(formData.width ?? item.width),
    depth: toNullableNumber(formData.depth ?? item.depth),
    height: toNullableNumber(formData.height ?? item.height),
    quantity: toNullableNumber(formData.quantity ?? item.quantity) || 1,
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials)
  };

  const description = buildReupholsteryDescription(normalizedFormData, { ...item, type });
  const itemName = cleanText(item.item_name || item.name || normalizedFormData.custom_name, 500) || `REUPHOLSTER ${REUPHOLSTERY_TYPE_LABELS[type] || 'ITEM'}`;

  return {
    ...item,
    category: 'reupholstery',
    type,
    item_type: type,
    item_name: itemName,
    name: itemName,
    description,
    width: normalizedFormData.width,
    depth: normalizedFormData.depth,
    height: normalizedFormData.height,
    quantity: normalizedFormData.quantity,
    sidemark: cleanText(item.sidemark || normalizedFormData.sidemark || item.room || '', 500) || null,
    form_data: {
      ...normalizedFormData,
      custom_name: itemName,
      source: formData.source || 'stitch',
      normalized_by: 'prestigio-write-service'
    },
    estimated_fabric_yardage: toNullableNumber(item.estimated_fabric_yardage || item.com_yardage || formData.estimatedFabricYardage || normalizedFormData.estimatedFabricYardage)
  };
}

function normalizePillowDraftItem(item, index) {
  const formData = cleanObject(item.form_data) || {};
  const type = normalizePillowType(formData.pillowType || item.pillowType || item.type || item.item_type);
  const quantity = toNullableNumber(formData.quantity ?? item.quantity) || 1;
  const normalizedFormData = {
    ...formData,
    category: 'pillows',
    pillowType: type,
    pillowFill: formData.pillowFill || item.pillowFill || item.fill,
    construction: formData.construction || item.construction || 'blind-seam',
    zipper: formData.zipper || item.zipper || 'no',
    width: toNullableNumber(formData.width ?? item.width),
    height: toNullableNumber(formData.height ?? item.height),
    box: toNullableNumber(formData.box ?? item.box),
    diameter: toNullableNumber(formData.diameter ?? item.diameter),
    medallionBoxed: Boolean(formData.medallionBoxed ?? item.medallionBoxed),
    medallionBoxDepth: toNullableNumber(formData.medallionBoxDepth ?? item.medallionBoxDepth),
    continuousBoxing: Boolean(formData.continuousBoxing ?? item.continuousBoxing),
    medallionContinuous: Boolean(formData.medallionContinuous ?? item.medallionContinuous),
    fillOther: formData.fillOther || item.fillOther || '',
    room: formData.room || item.room || null,
    quantity,
    isOutdoor: Boolean(formData.isOutdoor ?? item.isOutdoor),
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials)
  };

  const description = buildPillowDescription(normalizedFormData, item);
  const costBreakdown = normalizeQuoteRevisionCostBreakdownLines(item.cost_breakdown || item.lineItems);
  const calculatedUnitPrice = item.sell_price === undefined && costBreakdown
    ? calculatePillowUnitPriceFromBreakdown(costBreakdown, quantity)
    : null;
  const itemName = cleanText(item.item_name || item.name || normalizedFormData.custom_name, 500) || 'NEW CUSTOM PILLOWS';

  return {
    ...item,
    category: 'pillows',
    type,
    item_type: type,
    item_name: itemName,
    name: itemName,
    description,
    width: normalizedFormData.width,
    height: normalizedFormData.height,
    quantity,
    sidemark: cleanText(item.sidemark || normalizedFormData.sidemark || item.room || '', 500) || null,
    sell_price: item.sell_price !== undefined ? toNullableNumber(item.sell_price) : calculatedUnitPrice,
    cost_breakdown: costBreakdown || cleanObject(item.cost_breakdown),
    form_data: {
      ...normalizedFormData,
      custom_name: itemName,
      source: formData.source || 'stitch',
      normalized_by: 'prestigio-write-service'
    },
    estimated_fabric_yardage: toNullableNumber(item.estimated_fabric_yardage || formData.estimatedFabricYardage || normalizedFormData.estimatedFabricYardage),
    estimated_fabric_cost: toNullableNumber(item.estimated_fabric_cost || formData.estimatedFabricCost || normalizedFormData.estimatedFabricCost)
  };
}

function normalizeCushionDraftItem(item, index) {
  const formData = cleanObject(item.form_data) || {};
  const type = normalizeCushionType(formData.cushionType || item.cushionType || item.type || item.item_type);
  const quantity = toNullableNumber(formData.quantity ?? item.quantity) || 1;
  const normalizedFormData = {
    ...formData,
    category: 'cushions',
    cushionType: type,
    type,
    quantity,
    length: toNullableNumber(formData.length ?? item.length),
    depth: toNullableNumber(formData.depth ?? item.depth),
    thickness: toNullableNumber(formData.thickness ?? item.thickness),
    cushionFill: formData.cushionFill || formData.fill || item.cushionFill || item.fill || 'foam-dacron',
    fill: formData.cushionFill || formData.fill || item.cushionFill || item.fill || 'foam-dacron',
    envelopeFill: formData.envelopeFill || item.envelopeFill || 'down-50',
    solidDownFill: formData.solidDownFill || item.solidDownFill || 'down-50',
    foamType: formData.foamType || item.foamType || 'hrfoam',
    construction: formData.construction || item.construction || 'blind-seam',
    ties: formData.ties || item.ties || 'no',
    zipper: formData.zipper || item.zipper || 'yes',
    room: formData.room || item.room || null,
    isOutdoor: Boolean(formData.isOutdoor ?? item.isOutdoor),
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials),
    fabricWidth: toNullableNumber(formData.fabricWidth ?? item.fabricWidth),
    fabricCostPerYard: toNullableNumber(formData.fabricCostPerYard ?? item.fabricCostPerYard),
    estimatedFabricYardage: toNullableNumber(formData.estimatedFabricYardage ?? item.estimatedFabricYardage ?? item.estimated_fabric_yardage),
    estimatedFabricCost: toNullableNumber(formData.estimatedFabricCost ?? item.estimatedFabricCost ?? item.estimated_fabric_cost)
  };

  const description = buildCushionDescription(normalizedFormData, item);
  const costBreakdown = normalizeQuoteRevisionCostBreakdownLines(item.cost_breakdown || item.lineItems);
  const calculatedUnitPrice = item.sell_price === undefined && costBreakdown
    ? calculateCushionUnitPriceFromBreakdown(costBreakdown)
    : null;
  const itemName = cleanText(item.item_name || item.name || normalizedFormData.custom_name, 500) || 'NEW CUSTOM CUSHION';

  return {
    ...item,
    category: 'cushions',
    type,
    item_type: type,
    item_name: itemName,
    name: itemName,
    description,
    length: normalizedFormData.length,
    depth: normalizedFormData.depth,
    height: normalizedFormData.thickness,
    quantity,
    room: cleanText(normalizedFormData.room, 500),
    sidemark: cleanText(item.sidemark || normalizedFormData.sidemark || item.room || '', 500) || null,
    sell_price: item.sell_price !== undefined ? toNullableNumber(item.sell_price) : calculatedUnitPrice,
    cost_breakdown: costBreakdown || cleanObject(item.cost_breakdown),
    form_data: {
      ...normalizedFormData,
      custom_name: itemName,
      source: formData.source || 'stitch',
      normalized_by: 'prestigio-write-service'
    },
    estimated_fabric_yardage: toNullableNumber(item.estimated_fabric_yardage || normalizedFormData.estimatedFabricYardage),
    estimated_fabric_cost: toNullableNumber(item.estimated_fabric_cost || normalizedFormData.estimatedFabricCost)
  };
}

function normalizeSeatingDraftItem(item, index) {
  const formData = cleanObject(item.form_data) || {};
  const type = normalizeKey(formData.type || item.type || item.item_type || 'sofa') || 'sofa';
  const quantity = toNullableNumber(formData.quantity ?? item.quantity) || 1;
  const normalizedFormData = {
    ...formData,
    category: 'seating',
    type,
    quantity,
    room: formData.room || item.room || null,
    isOutdoor: Boolean(formData.isOutdoor ?? item.isOutdoor),
    width: toNullableNumber(formData.width ?? item.width),
    depth: toNullableNumber(formData.depth ?? item.depth),
    height: toNullableNumber(formData.height ?? item.height),
    shape: formData.shape || item.shape || '',
    pieces: toNullableNumber(formData.pieces ?? item.pieces),
    sectionWidths: Array.isArray(formData.sectionWidths) ? formData.sectionWidths : cleanArray(item.sectionWidths),
    wallTemplateRequired: Boolean(formData.wallTemplateRequired ?? item.wallTemplateRequired),
    seatSpecEnabled: Boolean(formData.seatSpecEnabled ?? item.seatSpecEnabled),
    backSpecEnabled: Boolean(formData.backSpecEnabled ?? item.backSpecEnabled),
    seatStyle: formData.seatStyle || item.seatStyle || '',
    seatFill: formData.seatFill || item.seatFill || '',
    seatCount: toNullableNumber(formData.seatCount ?? item.seatCount),
    seatInsert: formData.seatInsert || item.seatInsert || '',
    seatSeam: formData.seatSeam || item.seatSeam || '',
    seatFoamType: formData.seatFoamType || item.seatFoamType || '',
    seatFoam: formData.seatFoam || item.seatFoam || '',
    backStyle: formData.backStyle || item.backStyle || '',
    backFill: formData.backFill || item.backFill || '',
    backInsert: formData.backInsert || item.backInsert || '',
    backCount: toNullableNumber(formData.backCount ?? item.backCount),
    backSeam: formData.backSeam || item.backSeam || '',
    backFoamType: formData.backFoamType || item.backFoamType || '',
    backFoam: formData.backFoam || item.backFoam || '',
    tightBackAddon: Boolean(formData.tightBackAddon ?? item.tightBackAddon),
    tightBackAddonCount: toNullableNumber(formData.tightBackAddonCount ?? item.tightBackAddonCount),
    tightBackAddonInsert: formData.tightBackAddonInsert || item.tightBackAddonInsert || '',
    tightBackAddonFoamType: formData.tightBackAddonFoamType || item.tightBackAddonFoamType || '',
    tightBackAddonFoam: formData.tightBackAddonFoam || item.tightBackAddonFoam || '',
    tightBackAddonFill: formData.tightBackAddonFill || item.tightBackAddonFill || '',
    tightBackAddonSeam: formData.tightBackAddonSeam || item.tightBackAddonSeam || '',
    swivelBase: Boolean(formData.swivelBase ?? item.swivelBase),
    slipcover: Boolean(formData.slipcover ?? item.slipcover),
    slipcoverHours: toNullableNumber(formData.slipcoverHours ?? item.slipcoverHours),
    slipcoverRate: toNullableNumber(formData.slipcoverRate ?? item.slipcoverRate),
    legType: formData.legType || item.legType || '',
    armStyle: formData.armStyle || item.armStyle || '',
    woodSpecies: formData.woodSpecies || item.woodSpecies || '',
    finishSample: formData.finishSample || item.finishSample || '',
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials),
    estimatedFabricYardage: toNullableNumber(formData.estimatedFabricYardage ?? item.estimatedFabricYardage ?? item.estimated_fabric_yardage),
    estimatedFabricCost: toNullableNumber(formData.estimatedFabricCost ?? item.estimatedFabricCost ?? item.estimated_fabric_cost),
    fabricCostPerYard: toNullableNumber(formData.fabricCostPerYard ?? item.fabricCostPerYard)
  };
  const costBreakdown = normalizeQuoteRevisionCostBreakdownLines(item.cost_breakdown || item.lineItems);
  const calculatedUnitPrice = item.sell_price === undefined && costBreakdown
    ? calculateSeatingUnitPriceFromBreakdown(costBreakdown)
    : null;
  const itemName = cleanText(item.item_name || item.name || normalizedFormData.custom_name, 500) || `NEW CUSTOM ${type.toUpperCase()}`;
  const description = cleanText(item.description, 5000) || quoteDescriptionGenerators.generateSeatingDescription({
    ...item,
    ...normalizedFormData,
    materials: normalizedFormData.materials
  });

  return {
    ...item,
    category: 'seating',
    type,
    item_type: type,
    item_name: itemName,
    name: itemName,
    description,
    width: normalizedFormData.width,
    depth: normalizedFormData.depth,
    height: normalizedFormData.height,
    quantity,
    room: cleanText(normalizedFormData.room, 500),
    sidemark: cleanText(item.sidemark || normalizedFormData.sidemark || item.room || '', 500) || null,
    sell_price: item.sell_price !== undefined ? toNullableNumber(item.sell_price) : calculatedUnitPrice,
    cost_breakdown: costBreakdown || cleanObject(item.cost_breakdown),
    form_data: {
      ...normalizedFormData,
      custom_name: itemName,
      source: formData.source || 'stitch',
      normalized_by: 'prestigio-write-service'
    },
    estimated_fabric_yardage: toNullableNumber(item.estimated_fabric_yardage || normalizedFormData.estimatedFabricYardage),
    estimated_fabric_cost: toNullableNumber(item.estimated_fabric_cost || normalizedFormData.estimatedFabricCost)
  };
}

function buildBedDescription(formData, item) {
  return quoteDescriptionGenerators.generateBedDescription({
    ...item,
    ...formData,
    type: formData.bedType || formData.type || item.type || item.item_type,
    size: formData.bedSize || formData.size || item.bedSize || item.size,
    headboardStyle: formData.headboardStyle || formData.hbStyle || item.headboardStyle || item.hbStyle,
    edge: formData.bedEdge || formData.edge || item.bedEdge || item.edge,
    base: formData.bedBase || formData.base || item.bedBase || item.base,
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials)
  });
}

function normalizeBedDraftItem(item, index) {
  const formData = cleanObject(item.form_data) || {};
  const type = normalizeKey(formData.bedType || formData.type || item.bedType || item.type || item.item_type || 'headboard');
  const quantity = toNullableNumber(formData.quantity ?? item.quantity) || 1;
  const normalizedFormData = {
    ...formData,
    category: 'bed',
    bedType: type || 'headboard',
    type: type || 'headboard',
    quantity,
    room: formData.room || item.room || null,
    bedSize: formData.bedSize || formData.size || item.bedSize || item.size || 'queen',
    size: formData.bedSize || formData.size || item.bedSize || item.size || 'queen',
    headboardHeight: toNullableNumber(formData.headboardHeight ?? formData.hbHeight ?? item.headboardHeight ?? item.hbHeight),
    hbHeight: toNullableNumber(formData.headboardHeight ?? formData.hbHeight ?? item.headboardHeight ?? item.hbHeight),
    width: toNullableNumber(formData.width ?? item.width),
    depth: toNullableNumber(formData.depth ?? item.depth),
    footboardHeight: toNullableNumber(formData.footboardHeight ?? formData.fbHeight ?? item.footboardHeight ?? item.fbHeight),
    fbHeight: toNullableNumber(formData.footboardHeight ?? formData.fbHeight ?? item.footboardHeight ?? item.fbHeight),
    headboardStyle: formData.headboardStyle || formData.hbStyle || item.headboardStyle || item.hbStyle || 'pullover',
    hbStyle: formData.headboardStyle || formData.hbStyle || item.headboardStyle || item.hbStyle || 'pullover',
    bedEdge: formData.bedEdge || formData.edge || item.bedEdge || item.edge || 'not-specified',
    edge: formData.bedEdge || formData.edge || item.bedEdge || item.edge || 'not-specified',
    bedBase: formData.bedBase || formData.base || item.bedBase || item.base || 'attached',
    base: formData.bedBase || formData.base || item.bedBase || item.base || 'attached',
    woodSpecies: formData.woodSpecies || item.woodSpecies || '',
    finishSample: formData.finishSample || item.finishSample || '',
    bedFoamThickness: toNullableNumber(formData.bedFoamThickness ?? formData.foamThickness ?? item.bedFoamThickness ?? item.foamThickness),
    foamThickness: toNullableNumber(formData.bedFoamThickness ?? formData.foamThickness ?? item.bedFoamThickness ?? item.foamThickness),
    bedConstructionNotes: formData.bedConstructionNotes || item.bedConstructionNotes || item.constructionNotes || '',
    slipcover: Boolean(formData.slipcover ?? item.slipcover),
    slipcoverHours: toNullableNumber(formData.slipcoverHours ?? item.slipcoverHours),
    slipcoverRate: toNullableNumber(formData.slipcoverRate ?? item.slipcoverRate),
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials),
    estimatedFabricYardage: toNullableNumber(formData.estimatedFabricYardage ?? item.estimatedFabricYardage ?? item.estimated_fabric_yardage),
    estimatedFabricCost: toNullableNumber(formData.estimatedFabricCost ?? item.estimatedFabricCost ?? item.estimated_fabric_cost),
    fabricCostPerYard: toNullableNumber(formData.fabricCostPerYard ?? item.fabricCostPerYard)
  };
  const costBreakdown = normalizeQuoteRevisionCostBreakdownLines(item.cost_breakdown || item.lineItems);
  const calculatedUnitPrice = item.sell_price === undefined && costBreakdown
    ? calculateBedUnitPriceFromBreakdown(costBreakdown)
    : null;
  const itemName = cleanText(item.item_name || item.name || normalizedFormData.custom_name, 500) || 'NEW CUSTOM BED';
  const description = item.description ? cleanText(item.description, 5000) : buildBedDescription(normalizedFormData, item);

  return {
    ...item,
    category: 'bed',
    type: normalizedFormData.type,
    item_type: normalizedFormData.type,
    item_name: itemName,
    name: itemName,
    description,
    width: normalizedFormData.width,
    depth: normalizedFormData.depth,
    height: normalizedFormData.headboardHeight,
    quantity,
    room: cleanText(normalizedFormData.room, 500),
    sidemark: cleanText(item.sidemark || normalizedFormData.sidemark || item.room || '', 500) || null,
    sell_price: item.sell_price !== undefined ? toNullableNumber(item.sell_price) : calculatedUnitPrice,
    cost_breakdown: costBreakdown || cleanObject(item.cost_breakdown),
    form_data: {
      ...normalizedFormData,
      custom_name: itemName,
      source: formData.source || 'stitch',
      normalized_by: 'prestigio-write-service'
    },
    estimated_fabric_yardage: toNullableNumber(item.estimated_fabric_yardage || normalizedFormData.estimatedFabricYardage),
    estimated_fabric_cost: toNullableNumber(item.estimated_fabric_cost || normalizedFormData.estimatedFabricCost)
  };
}

function buildOttomanDescription(formData, item) {
  return quoteDescriptionGenerators.generateOttomanDescription({
    ...item,
    ...formData,
    type: formData.ottomanType || formData.type || item.type || item.item_type,
    fill: formData.ottomanFill || formData.fill || item.fill,
    baseType: formData.baseType || formData.base || item.baseType || item.base,
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials)
  });
}

function normalizeOttomanDraftItem(item, index) {
  const formData = cleanObject(item.form_data) || {};
  const type = normalizeKey(formData.ottomanType || formData.type || item.ottomanType || item.type || item.item_type || 'ottoman');
  const quantity = toNullableNumber(formData.quantity ?? item.quantity) || 1;
  const normalizedFormData = {
    ...formData,
    category: 'ottoman',
    ottomanType: type || 'ottoman',
    type: type || 'ottoman',
    quantity,
    room: formData.room || item.room || null,
    isOutdoor: Boolean(formData.isOutdoor ?? item.isOutdoor),
    length: toNullableNumber(formData.length ?? item.length),
    width: toNullableNumber(formData.width ?? item.width),
    height: toNullableNumber(formData.height ?? item.height),
    topStyle: formData.topStyle || item.topStyle || 'tight-seat',
    ottomanFill: formData.ottomanFill || formData.fill || item.ottomanFill || item.fill || 'foam-dacron',
    fill: formData.ottomanFill || formData.fill || item.ottomanFill || item.fill || 'foam-dacron',
    wrapType: formData.wrapType || item.wrapType || 'down-50',
    foamType: formData.foamType || item.foamType || 'hrfoam',
    foamThickness: toNullableNumber(formData.foamThickness ?? item.foamThickness),
    edge: formData.edge || item.edge || 'blind-seam',
    baseType: formData.baseType || formData.base || item.baseType || item.base || 'attached-legs',
    legFinish: formData.legFinish || item.legFinish || '',
    legColor: formData.legColor || item.legColor || '',
    slipcover: Boolean(formData.slipcover ?? item.slipcover),
    slipcoverHours: toNullableNumber(formData.slipcoverHours ?? item.slipcoverHours),
    slipcoverRate: toNullableNumber(formData.slipcoverRate ?? item.slipcoverRate),
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials)
  };
  const costBreakdown = normalizeQuoteRevisionCostBreakdownLines(item.cost_breakdown || item.lineItems);
  const calculatedUnitPrice = item.sell_price === undefined && costBreakdown
    ? calculateOttomanUnitPriceFromBreakdown(costBreakdown)
    : null;
  const itemName = cleanText(item.item_name || item.name || normalizedFormData.custom_name, 500) || 'NEW CUSTOM OTTOMAN';
  const description = item.description ? cleanText(item.description, 5000) : buildOttomanDescription(normalizedFormData, item);

  return {
    ...item,
    category: 'ottoman',
    type: normalizedFormData.type,
    item_type: normalizedFormData.type,
    item_name: itemName,
    name: itemName,
    description,
    width: normalizedFormData.width,
    depth: normalizedFormData.length,
    height: normalizedFormData.height,
    quantity,
    room: cleanText(normalizedFormData.room, 500),
    sidemark: cleanText(item.sidemark || normalizedFormData.sidemark || item.room || '', 500) || null,
    sell_price: item.sell_price !== undefined ? toNullableNumber(item.sell_price) : calculatedUnitPrice,
    cost_breakdown: costBreakdown || cleanObject(item.cost_breakdown),
    form_data: {
      ...normalizedFormData,
      custom_name: itemName,
      source: formData.source || 'stitch',
      normalized_by: 'prestigio-write-service'
    }
  };
}

function buildSoftgoodsDescription(formData, item) {
  return quoteDescriptionGenerators.generateSoftgoodsDescription({
    ...item,
    ...formData,
    type: formData.softgoodsType || formData.type || item.type || item.item_type,
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials)
  });
}

function normalizeSoftgoodsDraftItem(item, index) {
  const formData = cleanObject(item.form_data) || {};
  const type = normalizeKey(formData.softgoodsType || formData.type || item.softgoodsType || item.type || item.item_type || 'other');
  const quantity = toNullableNumber(formData.quantity ?? item.quantity) || 1;
  const normalizedFormData = {
    ...formData,
    category: 'softgoods',
    softgoodsType: type || 'other',
    type: type || 'other',
    quantity,
    room: formData.room || item.room || null,
    bedsize: formData.bedsize || formData.bedSize || item.bedsize || item.bedSize || 'queen',
    length: toNullableNumber(formData.length ?? item.length),
    width: toNullableNumber(formData.width ?? item.width),
    sided: formData.sided || item.sided || 'single',
    panels: toNullableNumber(formData.panels ?? item.panels),
    edge: formData.edge || item.edge || 'not-specified',
    lining: formData.lining || item.lining || 'no',
    slipPieceType: formData.slipPieceType || item.slipPieceType || null,
    slipClosure: formData.slipClosure || item.slipClosure || null,
    slipFit: formData.slipFit || item.slipFit || null,
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials),
    fabricWidth: toNullableNumber(formData.fabricWidth ?? item.fabricWidth),
    fabricCostPerYard: toNullableNumber(formData.fabricCostPerYard ?? item.fabricCostPerYard),
    estimatedFabricYardage: toNullableNumber(formData.estimatedFabricYardage ?? item.estimatedFabricYardage ?? item.estimated_fabric_yardage),
    estimatedFabricCost: toNullableNumber(formData.estimatedFabricCost ?? item.estimatedFabricCost ?? item.estimated_fabric_cost)
  };
  const costBreakdown = normalizeQuoteRevisionCostBreakdownLines(item.cost_breakdown || item.lineItems);
  const calculatedUnitPrice = item.sell_price === undefined && costBreakdown
    ? calculateSoftgoodsUnitPriceFromBreakdown(costBreakdown)
    : null;
  const itemName = cleanText(item.item_name || item.name || normalizedFormData.custom_name, 500) || 'NEW CUSTOM SOFTGOODS';
  const description = item.description ? cleanText(item.description, 5000) : buildSoftgoodsDescription(normalizedFormData, item);

  return {
    ...item,
    category: 'softgoods',
    type: normalizedFormData.type,
    item_type: normalizedFormData.type,
    item_name: itemName,
    name: itemName,
    description,
    width: normalizedFormData.width,
    height: normalizedFormData.length,
    quantity,
    room: cleanText(normalizedFormData.room, 500),
    sidemark: cleanText(item.sidemark || normalizedFormData.sidemark || item.room || '', 500) || null,
    sell_price: item.sell_price !== undefined ? toNullableNumber(item.sell_price) : calculatedUnitPrice,
    cost_breakdown: costBreakdown || cleanObject(item.cost_breakdown),
    form_data: {
      ...normalizedFormData,
      custom_name: itemName,
      source: formData.source || 'stitch',
      normalized_by: 'prestigio-write-service'
    },
    estimated_fabric_yardage: toNullableNumber(item.estimated_fabric_yardage || normalizedFormData.estimatedFabricYardage),
    estimated_fabric_cost: toNullableNumber(item.estimated_fabric_cost || normalizedFormData.estimatedFabricCost)
  };
}

function buildPatioDescription(formData, item) {
  return quoteDescriptionGenerators.generatePatioDescription({
    ...item,
    ...formData,
    type: formData.patioType || formData.type || item.type || item.item_type,
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials)
  });
}

function normalizePatioDraftItem(item, index) {
  const formData = cleanObject(item.form_data) || {};
  const type = normalizeKey(formData.patioType || formData.type || item.patioType || item.type || item.item_type || 'chair');
  const quantity = toNullableNumber(formData.quantity ?? item.quantity) || 1;
  const normalizedFormData = {
    ...formData,
    category: 'patio',
    patioType: type || 'chair',
    type: type || 'chair',
    quantity,
    room: formData.room || item.room || null,
    width: toNullableNumber(formData.width ?? item.width),
    depth: toNullableNumber(formData.depth ?? item.depth),
    height: toNullableNumber(formData.height ?? item.height),
    seatCount: toNullableNumber(formData.seatCount ?? item.seatCount) || 1,
    seatThickness: toNullableNumber(formData.seatThickness ?? item.seatThickness) || 4,
    seatFill: formData.seatFill || item.seatFill || 'foam-dacron',
    seatEnvelopeFill: formData.seatEnvelopeFill || item.seatEnvelopeFill || 'down-50',
    backEnabled: Boolean(formData.backEnabled ?? item.backEnabled ?? true),
    backCount: toNullableNumber(formData.backCount ?? item.backCount) || 1,
    backThickness: toNullableNumber(formData.backThickness ?? item.backThickness) || 4,
    backFill: formData.backFill || item.backFill || 'fiber-fill',
    backEnvelopeFill: formData.backEnvelopeFill || item.backEnvelopeFill || 'down-50',
    useCushionDims: Boolean(formData.useCushionDims ?? item.useCushionDims),
    seatLength: toNullableNumber(formData.seatLength ?? item.seatLength),
    seatDepth: toNullableNumber(formData.seatDepth ?? item.seatDepth),
    backLength: toNullableNumber(formData.backLength ?? item.backLength),
    backWidth: toNullableNumber(formData.backWidth ?? item.backWidth),
    construction: formData.construction || item.construction || 'blind-seam',
    ties: formData.ties || item.ties || 'no',
    zipper: formData.zipper || item.zipper || 'no',
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials),
    estimatedFabricYardage: toNullableNumber(formData.estimatedFabricYardage ?? item.estimatedFabricYardage ?? item.estimated_fabric_yardage),
    estimatedFabricCost: toNullableNumber(formData.estimatedFabricCost ?? item.estimatedFabricCost ?? item.estimated_fabric_cost),
    fabricCostPerYard: toNullableNumber(formData.fabricCostPerYard ?? item.fabricCostPerYard)
  };
  const costBreakdown = normalizeQuoteRevisionCostBreakdownLines(item.cost_breakdown || item.lineItems);
  const calculatedUnitPrice = item.sell_price === undefined && costBreakdown
    ? calculatePatioUnitPriceFromBreakdown(costBreakdown)
    : null;
  const itemName = cleanText(item.item_name || item.name || normalizedFormData.custom_name, 500) || 'NEW CUSTOM OUTDOOR PATIO CUSHIONS';
  const description = item.description ? cleanText(item.description, 5000) : buildPatioDescription(normalizedFormData, item);

  return {
    ...item,
    category: 'patio',
    type: normalizedFormData.type,
    item_type: normalizedFormData.type,
    item_name: itemName,
    name: itemName,
    description,
    width: normalizedFormData.width,
    depth: normalizedFormData.depth,
    height: normalizedFormData.height,
    quantity,
    room: cleanText(normalizedFormData.room, 500),
    sidemark: cleanText(item.sidemark || normalizedFormData.sidemark || item.room || '', 500) || null,
    sell_price: item.sell_price !== undefined ? toNullableNumber(item.sell_price) : calculatedUnitPrice,
    cost_breakdown: costBreakdown || cleanObject(item.cost_breakdown),
    form_data: {
      ...normalizedFormData,
      custom_name: itemName,
      source: formData.source || 'stitch',
      normalized_by: 'prestigio-write-service'
    },
    estimated_fabric_yardage: toNullableNumber(item.estimated_fabric_yardage || normalizedFormData.estimatedFabricYardage),
    estimated_fabric_cost: toNullableNumber(item.estimated_fabric_cost || normalizedFormData.estimatedFabricCost)
  };
}

function buildRestuffingDescription(formData, item) {
  return quoteDescriptionGenerators.generateRestuffingDescription({
    ...item,
    ...formData,
    type: formData.restuffingType || formData.type || item.restuffingType || item.type || item.item_type,
    newFill: formData.newFill || formData.newFillType || item.newFill || item.newFillType,
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials)
  });
}

function normalizeRestuffingDraftItem(item, index) {
  const formData = cleanObject(item.form_data) || {};
  const type = normalizeKey(formData.restuffingType || formData.type || item.restuffingType || item.type || item.item_type || 'seat-cushion');
  const quantity = toNullableNumber(formData.quantity ?? item.quantity) || 1;
  const normalizedFormData = {
    ...formData,
    category: 'restuffing',
    restuffingType: type || 'seat-cushion',
    type: type || 'seat-cushion',
    quantity,
    room: formData.room || item.room || null,
    isOutdoor: Boolean(formData.isOutdoor ?? item.isOutdoor),
    width: toNullableNumber(formData.width ?? item.width),
    depth: toNullableNumber(formData.depth ?? item.depth),
    thickness: toNullableNumber(formData.thickness ?? item.thickness),
    currentFill: formData.currentFill || item.currentFill || 'unknown',
    newFill: formData.newFill || formData.newFillType || item.newFill || item.newFillType || 'same',
    newFillType: formData.newFill || formData.newFillType || item.newFill || item.newFillType || 'same',
    newCover: Boolean(formData.newCover ?? item.newCover),
    notes: formData.notes || item.notes || '',
    materials: cleanArray(formData.materials).length ? cleanArray(formData.materials) : cleanArray(item.materials)
  };
  const costBreakdown = normalizeQuoteRevisionCostBreakdownLines(item.cost_breakdown || item.lineItems);
  const calculatedUnitPrice = item.sell_price === undefined && costBreakdown
    ? calculateRestuffingUnitPriceFromBreakdown(costBreakdown, quantity)
    : null;
  const itemName = cleanText(item.item_name || item.name || normalizedFormData.custom_name, 500) || 'RESTUFF CUSHION';
  const description = item.description ? cleanText(item.description, 5000) : buildRestuffingDescription(normalizedFormData, item);

  return {
    ...item,
    category: 'restuffing',
    type: normalizedFormData.type,
    item_type: normalizedFormData.type,
    item_name: itemName,
    name: itemName,
    description,
    width: normalizedFormData.width,
    depth: normalizedFormData.depth,
    height: normalizedFormData.thickness,
    quantity,
    room: cleanText(normalizedFormData.room, 500),
    sidemark: cleanText(item.sidemark || normalizedFormData.sidemark || item.room || '', 500) || null,
    sell_price: item.sell_price !== undefined ? toNullableNumber(item.sell_price) : calculatedUnitPrice,
    cost_breakdown: costBreakdown || cleanObject(item.cost_breakdown),
    form_data: {
      ...normalizedFormData,
      custom_name: itemName,
      source: formData.source || 'stitch',
      normalized_by: 'prestigio-write-service'
    }
  };
}

function normalizeDraftItem(item, index) {
  const formData = cleanObject(item.form_data) || {};
  const category = normalizeKey(item.category || formData.category || item.item_type || item.type);
  if (category === 'reupholstery') {
    return normalizeReupholsteryDraftItem(item, index);
  }
  if (category === 'pillows' || category === 'pillow') {
    return normalizePillowDraftItem(item, index);
  }
  if (category === 'cushions' || category === 'cushion') {
    return normalizeCushionDraftItem(item, index);
  }
  if (category === 'seating' || category === 'seat' || category === 'custom-furniture') {
    return normalizeSeatingDraftItem(item, index);
  }
  if (category === 'bed' || category === 'beds') {
    return normalizeBedDraftItem(item, index);
  }
  if (category === 'ottoman' || category === 'ottomans') {
    return normalizeOttomanDraftItem(item, index);
  }
  if (category === 'softgoods' || category === 'soft-goods' || category === 'slipcover') {
    return normalizeSoftgoodsDraftItem(item, index);
  }
  if (category === 'patio' || category === 'outdoor') {
    return normalizePatioDraftItem(item, index);
  }
  if (category === 'restuffing' || category === 'restuff') {
    return normalizeRestuffingDraftItem(item, index);
  }
  return item;
}

function hostWorkspaceDir() {
  return process.env.OPENCLAW_WORKSPACE_DIR || '/Users/chrisreyes/.openclaw/workspace';
}

function attachmentRoots() {
  const workspace = hostWorkspaceDir();
  return [
    path.resolve(workspace, 'mail-chris', 'attachments'),
    path.resolve(workspace, 'mail', 'attachments'),
    path.resolve(workspace, 'mail-gmail', 'attachments'),
    path.resolve('/home/node/.openclaw/workspace/mail-chris/attachments'),
    path.resolve('/home/node/.openclaw/workspace/mail/attachments'),
    path.resolve('/home/node/.openclaw/workspace/mail-gmail/attachments')
  ];
}

function normalizeAttachmentPath(filePath) {
  const raw = String(filePath || '').trim();
  const containerPrefix = '/home/node/.openclaw/workspace';
  if (raw === containerPrefix || raw.startsWith(containerPrefix + path.sep)) {
    return path.join(hostWorkspaceDir(), raw.slice(containerPrefix.length));
  }
  return raw;
}

function isAllowedAttachmentPath(filePath) {
  const resolved = path.resolve(normalizeAttachmentPath(filePath));
  return attachmentRoots().some(root => resolved === root || resolved.startsWith(root + path.sep));
}

function sanitizeStorageName(value) {
  return String(value || 'image')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 160) || 'image';
}

function inferImageContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return null;
}

function isPublicUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

async function uploadQuoteImage(filePath) {
  const normalizedPath = normalizeAttachmentPath(filePath);
  if (!normalizedPath || !isAllowedAttachmentPath(normalizedPath)) {
    throw new Error(`Reference image path is outside allowed mail attachment roots: ${filePath}`);
  }
  const stat = fs.statSync(normalizedPath);
  if (!stat.isFile()) {
    throw new Error(`Reference image path is not a file: ${filePath}`);
  }
  if (stat.size > MAX_QUOTE_IMAGE_BYTES) {
    throw new Error(`Reference image is too large: ${path.basename(normalizedPath)}`);
  }
  const contentType = inferImageContentType(normalizedPath);
  if (!contentType) {
    throw new Error(`Reference image type is not supported: ${path.basename(normalizedPath)}`);
  }

  const storageName = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}_${sanitizeStorageName(path.basename(normalizedPath))}`;
  const body = fs.readFileSync(normalizedPath);
  const url = `${SUPABASE_URL}/storage/v1/object/${QUOTE_IMAGE_BUCKET}/${encodeURIComponent(storageName)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      'Content-Type': contentType,
      'x-upsert': 'false'
    },
    body
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Quote image upload failed ${res.status}: ${text}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/${QUOTE_IMAGE_BUCKET}/${encodeURIComponent(storageName)}`;
}

async function resolveDraftReferenceImages(item) {
  const candidates = [
    ...cleanArray(item.reference_images),
    ...cleanArray(item.referenceImages),
    ...cleanArray(item.reference_image_paths),
    ...cleanArray(item.referenceImagePaths)
  ].map(value => String(value || '').trim()).filter(Boolean);

  if (!candidates.length) return null;

  const urls = [];
  for (const candidate of candidates) {
    if (isPublicUrl(candidate)) {
      urls.push(candidate);
    } else {
      urls.push(await uploadQuoteImage(candidate));
    }
  }
  return urls.length ? urls : null;
}

async function buildDraftQuotePayload(fields) {
  const quote = cleanObject(fields.quote) || {};
  const items = Array.isArray(fields.items) ? fields.items.map((item, index) => normalizeDraftItem(item, index)) : [];

  if (items.length === 0) {
    throw new Error('create-draft-quote requires at least one item');
  }
  if (!quote.client_id) {
    throw new Error('create-draft-quote requires quote.client_id. Resolve or confirm the client before writing.');
  }

  const grandTotal = toNullableNumber(quote.grand_total);
  const siteVisitTotal = getDraftQuoteSiteVisitTotal(quote);
  const itemTotal = sumDraftQuoteItems(items);
  return {
    quote: {
      client_id: quote.client_id,
      project_id: quote.project_id || null,
      sidemark: cleanText(quote.sidemark || quote.project_name || quote.client_name || 'Draft Quote', 500),
      status: 'draft',
      grand_total: grandTotal !== null ? grandTotal : Math.round((itemTotal + siteVisitTotal) * 100) / 100,
      site_visit_hours: toNullableNumber(quote.site_visit_hours),
      site_visit_rate: toNullableNumber(quote.site_visit_rate),
      site_visit_total: siteVisitTotal > 0 ? siteVisitTotal : toNullableNumber(quote.site_visit_total),
      description: cleanText(quote.description, 3000) || buildDraftQuoteDescription(items)
    },
    items: await Promise.all(items.map(async (item, index) => {
      const quantity = toNullableNumber(item.quantity) || 1;
      const sellPrice = toNullableNumber(item.sell_price ?? item.price ?? item.total);
      const category = cleanText(item.category, 100) || cleanText(item.item_type || item.type, 100);
      const itemName = cleanText(item.item_name || item.name || item.item || category || `Draft item ${index + 1}`, 500);
      const description = cleanText(item.description || itemName, 5000);
      return {
        item_type: cleanText(item.item_type || item.type || itemName, 200),
        item_name: itemName,
        category,
        description,
        width: toNullableNumber(item.width),
        depth: toNullableNumber(item.depth),
        height: toNullableNumber(item.height),
        quantity,
        room: cleanText(item.room || item.sidemark_room, 500),
        sidemark: cleanText(item.sidemark || item.room || itemName, 500),
        reference_images: await resolveDraftReferenceImages(item),
        sell_price: sellPrice,
        cost_breakdown: cleanObject(item.cost_breakdown),
        form_data: cleanObject(item.form_data) || {
          quote_intake_draft: true,
          source: 'stitch',
          assumptions: Array.isArray(item.assumptions) ? item.assumptions : [],
          client_questions: Array.isArray(item.client_questions) ? item.client_questions : [],
          fabric_notes: cleanText(item.fabric_notes || item.com_notes, 1000),
          com_yardage: toNullableNumber(item.com_yardage || item.estimated_fabric_yardage),
          confidence: cleanText(item.confidence, 200)
        },
        estimated_fabric_yardage: toNullableNumber(item.estimated_fabric_yardage || item.com_yardage),
        status: 'quote',
        quote_item_status: 'quoted'
      };
    }))
  };
}

async function supabaseRequest(table, method, body, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers: {
      ...HEADERS,
      Prefer: 'return=representation'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${table} ${method} ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

async function findExistingClient(client) {
  const name = cleanText(client.name || client.company, 500);
  const email = cleanEmail(client.email);
  const candidates = [];

  if (email) {
    candidates.push(
      supabaseRequest('clients', 'GET', undefined, `?select=id,name,company,email&email=ilike.${encodeURIComponent(email)}&limit=5`)
        .catch(() => [])
    );
  }
  if (name) {
    const term = encodeURIComponent(`*${name}*`);
    candidates.push(
      supabaseRequest('clients', 'GET', undefined, `?select=id,name,company,email&or=(name.ilike.${term},company.ilike.${term})&limit=10`)
        .catch(() => [])
    );
  }

  const results = (await Promise.all(candidates)).flat();
  const seen = new Set();
  return results.filter((row) => {
    if (!row?.id || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

async function createClientProject(fields) {
  const clientInput = cleanObject(fields.client) || {};
  const projectInput = cleanObject(fields.project) || null;
  const clientName = cleanText(clientInput.name || clientInput.company, 500);

  if (!clientName) {
    throw new Error('create-client-project requires client.name or client.company');
  }

  const existingClients = await findExistingClient(clientInput);
  if (existingClients.length > 0) {
    return {
      message: `Possible existing client match found. Did not create a duplicate.`,
      duplicate_risk: true,
      existing_clients: existingClients
    };
  }

  const clientPayload = {
    name: cleanText(clientInput.name, 500) || clientName,
    company: cleanText(clientInput.company, 500),
    email: cleanEmail(clientInput.email),
    phone: cleanText(clientInput.phone, 100),
    address: cleanText(clientInput.address, 1000)
  };

  const clientRows = await supabaseRequest('clients', 'POST', clientPayload, '?select=*');
  const client = Array.isArray(clientRows) ? clientRows[0] : clientRows;
  if (!client?.id) {
    throw new Error('Client insert did not return an id');
  }

  let project = null;
  if (projectInput && cleanText(projectInput.name, 500)) {
    const projectPayload = {
      name: cleanText(projectInput.name, 500),
      client_id: client.id,
      status: cleanText(projectInput.status, 100) || 'quoting',
      due_date: cleanText(projectInput.due_date, 50)
    };
    try {
      const projectRows = await supabaseRequest('projects', 'POST', projectPayload, '?select=*');
      project = Array.isArray(projectRows) ? projectRows[0] : projectRows;
    } catch (err) {
      await supabaseRequest('clients', 'DELETE', undefined, `?id=eq.${client.id}`);
      throw err;
    }
  }

  return {
    message: project
      ? `Created client ${client.name || client.company} and project ${project.name}`
      : `Created client ${client.name || client.company}`,
    client,
    project
  };
}

async function createDraftQuote(fields) {
  const payload = await buildDraftQuotePayload(fields);
  const quoteRows = await supabaseRequest('quotes', 'POST', payload.quote, '?select=*');
  const quote = Array.isArray(quoteRows) ? quoteRows[0] : quoteRows;
  if (!quote?.id) {
    throw new Error('Draft quote insert did not return an id');
  }

  const itemPayloads = payload.items.map(item => ({ ...item, quote_id: quote.id }));
  let items = [];
  try {
    items = await supabaseRequest('order_items', 'POST', itemPayloads, '?select=id,item_name,sidemark,sell_price,quantity,status,quote_item_status');
  } catch (err) {
    await supabaseRequest('quotes', 'DELETE', undefined, `?id=eq.${quote.id}`);
    throw err;
  }

  return {
    message: `Created draft quote ${quote.quote_number || quote.id} with ${itemPayloads.length} item(s)`,
    quote_url: buildModernQuoteUrl(quote.id),
    quote,
    items
  };
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function quoteRevisionItemLineTotal(item) {
  return roundCurrency((Number(item.sell_price) || 0) * (Number(item.quantity) || 1));
}

function quoteRevisionShortText(value, max = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function quoteRevisionHasUnsafeStatus(item) {
  const statuses = [item.status, item.item_status, item.quote_item_status]
    .filter(Boolean)
    .map(status => String(status).toLowerCase());
  return statuses.some(status => [
    'won',
    'approved',
    'ordered',
    'in_production',
    'in-production',
    'production',
    'complete',
    'completed',
    'received'
  ].includes(status));
}

function buildQuoteRevisionItemUpdates(updates) {
  const raw = cleanObject(updates) || {};
  const patch = {};

  const textFields = {
    item_type: 200,
    item_name: 500,
    custom_name: 500,
    category: 100,
    description: 5000,
    room: 500,
    sidemark: 500,
    quote_item_status: 100,
    status: 100
  };
  for (const [field, max] of Object.entries(textFields)) {
    if (raw[field] !== undefined) patch[field] = cleanText(raw[field], max);
  }

  const numberFields = [
    'quantity',
    'sell_price',
    'width',
    'depth',
    'height',
    'estimated_fabric_yardage',
    'actual_fabric_yardage'
  ];
  for (const field of numberFields) {
    if (raw[field] !== undefined) patch[field] = toNullableNumber(raw[field]);
  }

  const booleanFields = [
    'new_foam',
    'new_springs',
    'new_webbing',
    'frame_repair',
    'new_fill',
    'strip_old',
    'tufting',
    'nailheads'
  ];
  for (const field of booleanFields) {
    if (raw[field] !== undefined) patch[field] = Boolean(raw[field]);
  }

  if (raw.cost_breakdown !== undefined) {
    patch.cost_breakdown = cleanObject(raw.cost_breakdown);
  }
  if (raw.form_data !== undefined) {
    patch.form_data = cleanObject(raw.form_data);
  }
  if (raw.reference_images !== undefined) {
    patch.reference_images = Array.isArray(raw.reference_images) ? raw.reference_images : [];
  }

  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

function deepMergeQuoteRevisionObjects(base, updates) {
  const baseObject = cleanObject(base) || {};
  const updateObject = cleanObject(updates) || {};
  const merged = { ...baseObject };
  for (const [key, value] of Object.entries(updateObject)) {
    if (cleanObject(value) && cleanObject(merged[key])) {
      merged[key] = deepMergeQuoteRevisionObjects(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeQuoteRevisionPatchIntoItem(item, patch) {
  const merged = { ...patch };
  if (patch.form_data !== undefined) {
    merged.form_data = deepMergeQuoteRevisionObjects(item.form_data, patch.form_data);
  }
  if (patch.cost_breakdown !== undefined) {
    merged.cost_breakdown = normalizeQuoteRevisionCostBreakdownLines(
      deepMergeQuoteRevisionObjects(item.cost_breakdown, patch.cost_breakdown)
    );
  }
  const category = normalizeKey(
    merged.category ||
    item.category ||
    merged.form_data?.category ||
    item.form_data?.category ||
    ''
  );
  const looksLikeReupholsteryBreakdown = Boolean(
    category !== 'seating' &&
    category !== 'custom-furniture' &&
    category !== 'bed' &&
    category !== 'beds' &&
    category !== 'patio' &&
    category !== 'outdoor' &&
    category !== 'restuffing' &&
    category !== 'restuff' &&
    merged.cost_breakdown && (
      merged.cost_breakdown.labor_upholstery ||
      merged.cost_breakdown.seat_foam ||
      merged.cost_breakdown.back_foam ||
      merged.cost_breakdown.seat_fill ||
      merged.cost_breakdown.back_fill ||
      merged.cost_breakdown.springs ||
      category === 'reupholstery'
    )
  );
  const looksLikePillowBreakdown = Boolean(
    merged.cost_breakdown && (
      (merged.cost_breakdown.fill && category !== 'cushions' && category !== 'cushion') ||
      category === 'pillows' ||
      category === 'pillow'
    )
  );
  const looksLikeCushionBreakdown = Boolean(
    merged.cost_breakdown && (
      merged.cost_breakdown.foam ||
      merged.cost_breakdown.fill ||
      category === 'cushions' ||
      category === 'cushion'
    )
  );
  const looksLikeSeatingBreakdown = Boolean(
    merged.cost_breakdown && (
      category !== 'patio' &&
      category !== 'outdoor' &&
      (merged.cost_breakdown.frame ||
      merged.cost_breakdown.seat_foam ||
      merged.cost_breakdown.back_foam ||
      merged.cost_breakdown.frame_padding ||
      merged.cost_breakdown.arm_foam ||
      category === 'seating' ||
      category === 'custom-furniture')
    )
  );
  const looksLikeBedBreakdown = Boolean(
    category !== 'ottoman' &&
    category !== 'ottomans' &&
    merged.cost_breakdown && (
      category === 'bed' ||
      category === 'beds' ||
      merged.cost_breakdown.frame ||
      merged.cost_breakdown.legs ||
      merged.cost_breakdown.foam
    )
  );
  const looksLikeOttomanBreakdown = Boolean(
    merged.cost_breakdown && (
      category === 'ottoman' ||
      category === 'ottomans' ||
      merged.cost_breakdown.wrap
    )
  );
  const looksLikeSoftgoodsBreakdown = Boolean(
    merged.cost_breakdown && (
      category === 'softgoods' ||
      category === 'soft-goods' ||
      category === 'slipcover'
    )
  );
  const looksLikePatioBreakdown = Boolean(
    merged.cost_breakdown && (
      category === 'patio' ||
      category === 'outdoor'
    )
  );
  const looksLikeRestuffingBreakdown = Boolean(
    merged.cost_breakdown && (
      category === 'restuffing' ||
      category === 'restuff'
    )
  );
  if (merged.sell_price === undefined && looksLikeReupholsteryBreakdown) {
    const calculatedPrice = calculateReupholsteryUnitPriceFromBreakdown(merged.cost_breakdown);
    if (calculatedPrice !== null) {
      merged.sell_price = calculatedPrice;
    }
  }
  if (merged.sell_price === undefined && looksLikePillowBreakdown) {
    const calculatedPrice = calculatePillowUnitPriceFromBreakdown(merged.cost_breakdown, merged.quantity ?? item.quantity);
    if (calculatedPrice !== null) {
      merged.sell_price = calculatedPrice;
    }
  }
  if (merged.sell_price === undefined && looksLikeCushionBreakdown) {
    const calculatedPrice = calculateCushionUnitPriceFromBreakdown(merged.cost_breakdown);
    if (calculatedPrice !== null) {
      merged.sell_price = calculatedPrice;
    }
  }
  if (merged.sell_price === undefined && looksLikeSeatingBreakdown) {
    const calculatedPrice = calculateSeatingUnitPriceFromBreakdown(merged.cost_breakdown);
    if (calculatedPrice !== null) {
      merged.sell_price = calculatedPrice;
    }
  }
  if (merged.sell_price === undefined && looksLikeBedBreakdown) {
    const calculatedPrice = calculateBedUnitPriceFromBreakdown(merged.cost_breakdown);
    if (calculatedPrice !== null) {
      merged.sell_price = calculatedPrice;
    }
  }
  if (merged.sell_price === undefined && looksLikeOttomanBreakdown) {
    const calculatedPrice = calculateOttomanUnitPriceFromBreakdown(merged.cost_breakdown);
    if (calculatedPrice !== null) {
      merged.sell_price = calculatedPrice;
    }
  }
  if (merged.sell_price === undefined && looksLikeSoftgoodsBreakdown) {
    const calculatedPrice = calculateSoftgoodsUnitPriceFromBreakdown(merged.cost_breakdown);
    if (calculatedPrice !== null) {
      merged.sell_price = calculatedPrice;
    }
  }
  if (merged.sell_price === undefined && looksLikePatioBreakdown) {
    const calculatedPrice = calculatePatioUnitPriceFromBreakdown(merged.cost_breakdown);
    if (calculatedPrice !== null) {
      merged.sell_price = calculatedPrice;
    }
  }
  if (merged.sell_price === undefined && looksLikeRestuffingBreakdown) {
    const calculatedPrice = calculateRestuffingUnitPriceFromBreakdown(merged.cost_breakdown, merged.quantity ?? item.quantity);
    if (calculatedPrice !== null) {
      merged.sell_price = calculatedPrice;
    }
  }
  const finalItem = applyQuoteRevisionItemPatch(item, merged);
  const finalFormData = syncReupholsteryFormBooleans(finalItem.form_data, finalItem);
  const finalCategory = normalizeKey(
    finalItem.category ||
    finalFormData.category ||
    ''
  );
  const shouldRegenerateReupholsteryDescription = (
    merged.description === undefined &&
    (category === 'reupholstery' || finalCategory === 'reupholstery') &&
    (
      patch.form_data !== undefined ||
      patch.cost_breakdown !== undefined ||
      Object.keys(REUPHOLSTERY_BOOLEAN_FIELD_MAP).some(key => patch[key] !== undefined)
    )
  );
  if (shouldRegenerateReupholsteryDescription) {
    merged.form_data = {
      ...finalFormData,
      category: 'reupholstery'
    };
    merged.description = buildReupholsteryDescription(merged.form_data, {
      ...finalItem,
      form_data: merged.form_data
    });
  }
  const shouldRegeneratePillowDescription = (
    merged.description === undefined &&
    (category === 'pillows' || category === 'pillow' || finalCategory === 'pillows' || finalCategory === 'pillow') &&
    (
      patch.form_data !== undefined ||
      patch.cost_breakdown !== undefined
    )
  );
  if (shouldRegeneratePillowDescription) {
    merged.form_data = {
      ...(cleanObject(finalItem.form_data) || {}),
      ...(cleanObject(merged.form_data) || {}),
      category: 'pillows'
    };
    merged.description = buildPillowDescription(merged.form_data, {
      ...finalItem,
      form_data: merged.form_data
    });
  }
  const shouldRegenerateCushionDescription = (
    merged.description === undefined &&
    (category === 'cushions' || category === 'cushion' || finalCategory === 'cushions' || finalCategory === 'cushion') &&
    (
      patch.form_data !== undefined ||
      patch.cost_breakdown !== undefined
    )
  );
  if (shouldRegenerateCushionDescription) {
    merged.form_data = {
      ...(cleanObject(finalItem.form_data) || {}),
      ...(cleanObject(merged.form_data) || {}),
      category: 'cushions'
    };
    merged.description = buildCushionDescription(merged.form_data, {
      ...finalItem,
      form_data: merged.form_data
    });
  }
  const shouldRegenerateSeatingDescription = (
    merged.description === undefined &&
    (category === 'seating' || category === 'custom-furniture' || finalCategory === 'seating' || finalCategory === 'custom-furniture') &&
    (
      patch.form_data !== undefined ||
      patch.cost_breakdown !== undefined
    )
  );
  if (shouldRegenerateSeatingDescription) {
    merged.form_data = {
      ...(cleanObject(finalItem.form_data) || {}),
      ...(cleanObject(merged.form_data) || {}),
      category: 'seating'
    };
    merged.description = quoteDescriptionGenerators.generateSeatingDescription({
      ...finalItem,
      ...merged.form_data,
      materials: cleanArray(merged.form_data.materials).length ? cleanArray(merged.form_data.materials) : cleanArray(finalItem.materials)
    });
  }
  const shouldRegenerateBedDescription = (
    merged.description === undefined &&
    (category === 'bed' || category === 'beds' || finalCategory === 'bed' || finalCategory === 'beds') &&
    (
      patch.form_data !== undefined ||
      patch.cost_breakdown !== undefined
    )
  );
  if (shouldRegenerateBedDescription) {
    merged.form_data = {
      ...(cleanObject(finalItem.form_data) || {}),
      ...(cleanObject(merged.form_data) || {}),
      category: 'bed'
    };
    merged.description = buildBedDescription(merged.form_data, {
      ...finalItem,
      form_data: merged.form_data
    });
  }
  const shouldRegenerateOttomanDescription = (
    merged.description === undefined &&
    (category === 'ottoman' || category === 'ottomans' || finalCategory === 'ottoman' || finalCategory === 'ottomans') &&
    (
      patch.form_data !== undefined ||
      patch.cost_breakdown !== undefined
    )
  );
  if (shouldRegenerateOttomanDescription) {
    merged.form_data = {
      ...(cleanObject(finalItem.form_data) || {}),
      ...(cleanObject(merged.form_data) || {}),
      category: 'ottoman'
    };
    merged.description = buildOttomanDescription(merged.form_data, {
      ...finalItem,
      form_data: merged.form_data
    });
  }
  const shouldRegenerateSoftgoodsDescription = (
    merged.description === undefined &&
    (category === 'softgoods' || category === 'soft-goods' || category === 'slipcover' || finalCategory === 'softgoods' || finalCategory === 'soft-goods' || finalCategory === 'slipcover') &&
    (
      patch.form_data !== undefined ||
      patch.cost_breakdown !== undefined
    )
  );
  if (shouldRegenerateSoftgoodsDescription) {
    merged.form_data = {
      ...(cleanObject(finalItem.form_data) || {}),
      ...(cleanObject(merged.form_data) || {}),
      category: 'softgoods'
    };
    merged.description = buildSoftgoodsDescription(merged.form_data, {
      ...finalItem,
      form_data: merged.form_data
    });
  }
  const shouldRegeneratePatioDescription = (
    merged.description === undefined &&
    (category === 'patio' || category === 'outdoor' || finalCategory === 'patio' || finalCategory === 'outdoor') &&
    (
      patch.form_data !== undefined ||
      patch.cost_breakdown !== undefined
    )
  );
  if (shouldRegeneratePatioDescription) {
    merged.form_data = {
      ...(cleanObject(finalItem.form_data) || {}),
      ...(cleanObject(merged.form_data) || {}),
      category: 'patio'
    };
    merged.description = buildPatioDescription(merged.form_data, {
      ...finalItem,
      form_data: merged.form_data
    });
  }
  const shouldRegenerateRestuffingDescription = (
    merged.description === undefined &&
    (category === 'restuffing' || category === 'restuff' || finalCategory === 'restuffing' || finalCategory === 'restuff') &&
    (
      patch.form_data !== undefined ||
      patch.cost_breakdown !== undefined
    )
  );
  if (shouldRegenerateRestuffingDescription) {
    merged.form_data = {
      ...(cleanObject(finalItem.form_data) || {}),
      ...(cleanObject(merged.form_data) || {}),
      category: 'restuffing'
    };
    merged.description = buildRestuffingDescription(merged.form_data, {
      ...finalItem,
      form_data: merged.form_data
    });
  }
  return merged;
}

function applyQuoteRevisionItemPatch(item, patch) {
  return { ...item, ...patch };
}

async function resolveExistingQuote(quoteInput) {
  const quote = cleanObject(quoteInput) || {};
  let query = '?select=*&limit=2';
  if (quote.quote_id || quote.id) {
    query += `&id=eq.${encodeURIComponent(quote.quote_id || quote.id)}`;
  } else if (quote.xero_quote_number) {
    query += `&xero_quote_number=eq.${encodeURIComponent(quote.xero_quote_number)}`;
  } else if (quote.quote_number) {
    query += `&quote_number=eq.${encodeURIComponent(quote.quote_number)}`;
  } else {
    throw new Error('revise-existing-quote requires quote_id, xero_quote_number, or quote_number');
  }

  const rows = await supabaseRequest('quotes', 'GET', undefined, query);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('No matching quote found');
  }
  if (rows.length > 1) {
    throw new Error('Quote lookup matched more than one quote; use quote_id');
  }
  return rows[0];
}

async function fetchExistingQuoteItems(quoteId) {
  const query = `?select=*&quote_id=eq.${encodeURIComponent(quoteId)}&order=created_at.asc`;
  const rows = await supabaseRequest('order_items', 'GET', undefined, query);
  return Array.isArray(rows) ? rows : [];
}

function buildResolvedQuoteRevisionPlan(fields, quote, items) {
  const operations = cleanArray(fields.operations);
  if (operations.length === 0) {
    throw new Error('revise-existing-quote requires at least one operation');
  }

  const unsupported = operations.filter(op => !['remove_item', 'update_item'].includes(op.op));
  if (unsupported.length) {
    throw new Error(`Unsupported revision operation(s): ${unsupported.map(op => op.op).join(', ')}`);
  }

  const itemById = new Map(items.map(item => [item.id, item]));
  const removeIds = new Set();
  const removed = [];
  const updated = [];
  const updatePatches = new Map();

  for (const op of operations) {
    if (!op.item_id) {
      throw new Error(`${op.op} operation missing item_id`);
    }
    const item = itemById.get(op.item_id);
    if (!item) {
      throw new Error(`Item ${op.item_id} does not belong to quote ${quote.id}`);
    }
    if (item.po_id) {
      throw new Error(`Refusing to revise item ${op.item_id}; it is tied to PO ${item.po_id}`);
    }
    if (quoteRevisionHasUnsafeStatus(item)) {
      throw new Error(`Refusing to revise item ${op.item_id}; status is no longer a quote-only row`);
    }

    if (op.op === 'remove_item') {
      if (removeIds.has(op.item_id)) {
        throw new Error(`Duplicate remove_item operation for ${op.item_id}`);
      }
      if (updatePatches.has(op.item_id)) {
        throw new Error(`Item ${op.item_id} cannot be both updated and removed`);
      }
      removeIds.add(op.item_id);
      removed.push({ item, reason: op.reason || '' });
      continue;
    }

    if (op.op === 'update_item') {
      if (removeIds.has(op.item_id)) {
        throw new Error(`Item ${op.item_id} cannot be both removed and updated`);
      }
      if (updatePatches.has(op.item_id)) {
        throw new Error(`Duplicate update_item operation for ${op.item_id}`);
      }
      const patch = buildQuoteRevisionItemUpdates(op.updates);
      if (!Object.keys(patch).length) {
        throw new Error(`update_item operation for ${op.item_id} has no supported updates`);
      }
      const mergedPatch = mergeQuoteRevisionPatchIntoItem(item, patch);
      updatePatches.set(op.item_id, mergedPatch);
      updated.push({ before: item, after: applyQuoteRevisionItemPatch(item, mergedPatch), patch: mergedPatch, reason: op.reason || '' });
    }
  }

  const finalItems = items
    .filter(item => !removeIds.has(item.id))
    .map(item => updatePatches.has(item.id) ? applyQuoteRevisionItemPatch(item, updatePatches.get(item.id)) : item);
  if (finalItems.length === 0) {
    throw new Error('Revision would remove every quote item; refusing');
  }

  const itemTotalBefore = roundCurrency(items.reduce((sum, item) => sum + quoteRevisionItemLineTotal(item), 0));
  const itemTotalAfter = roundCurrency(finalItems.reduce((sum, item) => sum + quoteRevisionItemLineTotal(item), 0));
  const siteVisitTotal = roundCurrency(quote.site_visit_total || 0);
  const beforeTotal = roundCurrency(itemTotalBefore + siteVisitTotal);
  const afterTotal = roundCurrency(itemTotalAfter + siteVisitTotal);

  const expected = cleanObject(fields.expected) || {};
  if (expected.before_total !== undefined && roundCurrency(expected.before_total) !== beforeTotal) {
    throw new Error(`Expected before_total ${formatMoney(expected.before_total)} but current quote totals ${formatMoney(beforeTotal)}`);
  }
  if (expected.after_total !== undefined && roundCurrency(expected.after_total) !== afterTotal) {
    throw new Error(`Expected after_total ${formatMoney(expected.after_total)} but revision would total ${formatMoney(afterTotal)}`);
  }

  return {
    quote: {
      id: quote.id,
      sidemark: quote.sidemark || null,
      status: quote.status || null,
      quote_number: quote.quote_number || null,
      xero_quote_number: quote.xero_quote_number || null,
      xero_quote_id: quote.xero_quote_id || null
    },
    revision_reason: cleanText(fields.revision_reason, 1000),
    totals: {
      before: beforeTotal,
      after: afterTotal,
      site_visit_total: siteVisitTotal
    },
    remove_item_ids: Array.from(removeIds),
    update_item_patches: Object.fromEntries(updatePatches.entries()),
    removed: removed.map(({ item, reason }) => ({
      id: item.id,
      item_type: item.item_type || null,
      custom_name: item.custom_name || item.sidemark || null,
      description: quoteRevisionShortText(item.description),
      quantity: Number(item.quantity) || 1,
      sell_price: Number(item.sell_price) || 0,
      line_total: quoteRevisionItemLineTotal(item),
      reason
    })),
    updated: updated.map(({ before, after, patch, reason }) => ({
      id: before.id,
      custom_name: before.custom_name || before.sidemark || null,
      quantity_before: Number(before.quantity) || 1,
      quantity_after: Number(after.quantity) || 1,
      sell_price_before: Number(before.sell_price) || 0,
      sell_price_after: Number(after.sell_price) || 0,
      line_total_before: quoteRevisionItemLineTotal(before),
      line_total_after: quoteRevisionItemLineTotal(after),
      fields: Object.keys(patch),
      reason
    })),
    kept: finalItems.map(item => ({
      id: item.id,
      item_type: item.item_type || null,
      custom_name: item.custom_name || item.sidemark || null,
      description: quoteRevisionShortText(item.description),
      quantity: Number(item.quantity) || 1,
      sell_price: Number(item.sell_price) || 0,
      line_total: quoteRevisionItemLineTotal(item)
    })),
    source_context: cleanObject(fields.source_context) || null
  };
}

function summarizeResolvedQuoteRevisionPlan(plan) {
  const label = plan.quote.xero_quote_number || plan.quote.quote_number || plan.quote.id;
  const lines = [
    `Revise existing quote ${label}${plan.quote.sidemark ? ` / ${plan.quote.sidemark}` : ''}`,
    `Total: ${formatMoney(plan.totals.before)} -> ${formatMoney(plan.totals.after)}`,
    '',
    'Remove:'
  ];
  for (const item of plan.removed) {
    lines.push(`- ${item.quantity} x ${formatMoney(item.sell_price)} = ${formatMoney(item.line_total)} | ${item.custom_name || item.item_type || item.id}`);
    if (item.description) lines.push(`  ${item.description}`);
    if (item.reason) lines.push(`  Reason: ${item.reason}`);
  }
  if (plan.updated.length) {
    lines.push('', 'Update:');
    for (const item of plan.updated) {
      lines.push(`- ${item.custom_name || item.id}: ${formatMoney(item.line_total_before)} -> ${formatMoney(item.line_total_after)} | fields: ${item.fields.join(', ')}`);
      if (item.reason) lines.push(`  Reason: ${item.reason}`);
    }
  }
  lines.push('', 'Keep:');
  for (const item of plan.kept) {
    lines.push(`- ${item.quantity} x ${formatMoney(item.sell_price)} = ${formatMoney(item.line_total)} | ${item.custom_name || item.item_type || item.id}`);
    if (item.description) lines.push(`  ${item.description}`);
  }
  if (plan.quote.xero_quote_id || plan.quote.xero_quote_number) {
    lines.push('', 'Xero note: this revises Prestigio only. Use the normal resend/update-to-Xero flow afterward so Xero/PDF match.');
  }
  return lines.join('\n');
}

function computeResolvedQuoteRevisionDigest(plan) {
  const secret = process.env.STITCH_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!secret) return null;
  return crypto
    .createHmac('sha256', secret)
    .update(stableJson({ action: 'revise-existing-quote', plan }))
    .digest('base64url');
}

function buildQuoteDescriptionFromRemainingItems(items) {
  return cleanArray(items)
    .map(item => cleanText(item.description, 1000))
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 3000) || null;
}

async function reviseExistingQuote(fields) {
  const quote = await resolveExistingQuote(fields.quote);
  const items = await fetchExistingQuoteItems(quote.id);
  const plan = buildResolvedQuoteRevisionPlan(fields, quote, items);
  const remainingItems = items
    .filter(item => !plan.remove_item_ids.includes(item.id))
    .map(item => {
      const patch = plan.update_item_patches[item.id];
      return patch ? applyQuoteRevisionItemPatch(item, patch) : item;
    });

  for (const [itemId, patch] of Object.entries(plan.update_item_patches)) {
    await supabaseRequest(
      'order_items',
      'PATCH',
      { ...patch, updated_at: new Date().toISOString() },
      `?id=eq.${encodeURIComponent(itemId)}&select=*`
    );
  }

  if (plan.remove_item_ids.length) {
    await supabaseRequest(
      'order_items',
      'DELETE',
      undefined,
      `?id=in.(${plan.remove_item_ids.map(id => encodeURIComponent(id)).join(',')})`
    );
  }

  const quoteRows = await supabaseRequest(
    'quotes',
    'PATCH',
    {
      grand_total: plan.totals.after,
      description: buildQuoteDescriptionFromRemainingItems(remainingItems),
      updated_at: new Date().toISOString()
    },
    `?id=eq.${encodeURIComponent(quote.id)}&select=*`
  );
  const updatedQuote = Array.isArray(quoteRows) ? quoteRows[0] : quoteRows;

  return {
    message: `Revised quote ${quote.xero_quote_number || quote.quote_number || quote.id}: ${formatMoney(plan.totals.before)} -> ${formatMoney(plan.totals.after)}`,
    quote: updatedQuote,
    removed_item_ids: plan.remove_item_ids,
    updated_item_ids: plan.updated.map(item => item.id),
    kept_item_ids: plan.kept.map(item => item.id),
    before_total: plan.totals.before,
    after_total: plan.totals.after,
    xero_note: (quote.xero_quote_id || quote.xero_quote_number)
      ? 'Prestigio was revised locally. Use the normal resend/update-to-Xero flow so Xero and the client PDF match.'
      : null
  };
}

// --- Call Supabase edge function ---
async function callEdgeFunction(action, fields) {
  const payload = { action, ...fields };
  const functionName =
    action === 'apply-credit' ? 'xero-apply-credit' :
    action === 'search-xero-invoices' ? 'xero-search-invoices' :
    action === 'search-xero-quotes' ? 'xero-search-quotes' :
    action === 'search-xero-bank-transactions' ? 'xero-search-bank-transactions' :
    action === 'search-xero-credit-notes' ? 'xero-search-credit-notes' :
    action === 'create-invoice' ? 'xero-create-invoice' :
    action === 'record-payment' ? 'xero-record-payment' :
    action === 'email-invoice' ? 'xero-email-invoice' :
    action === 'send-invoice-email' ? 'xero-send-invoice-email' :
    action === 'create-xero-contact' ? 'xero-create-contact' :
    'stitch-write';
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Edge function ${res.status}: ${body}`);
  }

  try {
    return JSON.parse(body);
  } catch (_) {
    return { message: body };
  }
}

// --- File watcher ---
let lastLegacyMtime = 0;
let watcherBusy = false;
let lastCleanupAt = 0;

async function processWriteRequest(request, { requestId, legacy = false } = {}) {
  const action = request.action;
  console.log(`[write] ${action} item_id=${request.item_id || '(none)'}`);

  const allowedFields = ACTION_FIELDS[action];
  if (!allowedFields) {
    writeResponse({
      success: false,
      action: action,
      error: `Unknown action: ${action}`,
      completed_at: new Date().toISOString()
    }, { requestId, legacy });
    return;
  }

  const fields = {};
  for (const key of allowedFields) {
    if (request[key] !== undefined) {
      fields[key] = request[key];
    }
  }

  if (action === 'revise-existing-quote') {
    try {
      const quote = await resolveExistingQuote(fields.quote);
      const items = await fetchExistingQuoteItems(quote.id);
      const plan = buildResolvedQuoteRevisionPlan(fields, quote, items);
      const digest = computeResolvedQuoteRevisionDigest(plan);
      if (!digest) {
        writeResponse({
          success: false,
          error: 'Missing confirmation secret for confirmable action',
          completed_at: new Date().toISOString()
        }, { requestId, legacy });
        return;
      }
      if (!fields.confirmed) {
        writeResponse({
          success: false,
          requires_confirmation: true,
          action: action,
          summary: summarizeResolvedQuoteRevisionPlan(plan),
          confirm_digest: digest,
          completed_at: new Date().toISOString()
        }, { requestId, legacy });
        return;
      }
      if (fields.confirm_digest !== digest) {
        writeResponse({
          success: false,
          error: 'DIGEST_MISMATCH',
          message: 'Confirmation digest does not match. The quote or payload may have changed.',
          completed_at: new Date().toISOString()
        }, { requestId, legacy });
        return;
      }
    } catch (err) {
      writeResponse({
        success: false,
        action: action,
        error: err.message,
        completed_at: new Date().toISOString()
      }, { requestId, legacy });
      return;
    }
  }

  if (action !== 'revise-existing-quote' && CONFIRMABLE_ACTIONS.includes(action)) {
    const digest = computeConfirmDigest(action, fields);
    if (!digest) {
      writeResponse({
        success: false,
        error: 'Missing confirmation secret for confirmable action',
        completed_at: new Date().toISOString()
      }, { requestId, legacy });
      return;
    }

    if (!fields.confirmed) {
      writeResponse({
        success: false,
        requires_confirmation: true,
        action: action,
        summary: buildConfirmSummary(action, fields),
        confirm_digest: digest,
        completed_at: new Date().toISOString()
      }, { requestId, legacy });
      return;
    }

    if (fields.confirm_digest !== digest) {
      writeResponse({
        success: false,
        error: 'DIGEST_MISMATCH',
        message: 'Confirmation digest does not match. The payload may have changed.',
        completed_at: new Date().toISOString()
      }, { requestId, legacy });
      return;
    }
  }

  try {
    const result = action === 'create-draft-quote'
      ? await createDraftQuote(fields)
      : action === 'create-client-project'
        ? await createClientProject(fields)
        : action === 'revise-existing-quote'
          ? await reviseExistingQuote(fields)
          : await callEdgeFunction(action, fields);
    writeResponse({
      success: true,
      action: action,
      item_id: request.item_id || request.order_item_id || null,
      message: result.message || 'OK',
      result: result,
      completed_at: new Date().toISOString()
    }, { requestId, legacy });
    console.log(`[done] ${action} item_id=${request.item_id || '(none)'}`);
  } catch (err) {
    console.error(`[error] ${action}: ${err.message}`);
    writeResponse({
      success: false,
      action: action,
      item_id: request.item_id || request.order_item_id || null,
      error: err.message,
      completed_at: new Date().toISOString()
    }, { requestId, legacy });
  }
}

function maybeCleanupBusFiles() {
  if (Date.now() - lastCleanupAt < 60_000) return;
  cleanupOldBusFiles();
  lastCleanupAt = Date.now();
}

async function processLegacyRequest() {
  if (!fs.existsSync(LEGACY_REQUEST_FILE)) return;
  const stat = fs.statSync(LEGACY_REQUEST_FILE);
  const mtime = stat.mtimeMs;
  if (mtime <= lastLegacyMtime) return;
  if (!isStableFile(LEGACY_REQUEST_FILE)) return;
  lastLegacyMtime = mtime;

  const raw = fs.readFileSync(LEGACY_REQUEST_FILE, 'utf8');
  const request = JSON.parse(raw);
  const requestId = request.requestId ? sanitizeRequestId(request.requestId) : undefined;
  await processWriteRequest(request, { requestId, legacy: true });
}

async function processRequestFile(filePath) {
  const requestId = sanitizeRequestId(path.basename(filePath, '.json'));
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const request = JSON.parse(raw);
    await processWriteRequest(request, { requestId, legacy: false });
  } catch (err) {
    console.error(`[watcher error] ${err.message}`);
    writeResponse({
      success: false,
      error: err.message,
      completed_at: new Date().toISOString()
    }, { requestId, legacy: false });
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {
      // best effort cleanup
    }
  }
}

async function checkForRequest() {
  if (watcherBusy) return;
  watcherBusy = true;
  try {
    ensureBusDirs();
    maybeCleanupBusFiles();

    for (const filePath of listPendingRequestFiles(REQUEST_DIR)) {
      await processRequestFile(filePath);
    }

    await processLegacyRequest();
  } catch (err) {
    console.error(`[watcher error] ${err.message}`);
  } finally {
    watcherBusy = false;
  }
}

if (require.main === module) {
  setInterval(() => {
    checkForRequest().catch(err => {
      console.error(`[watcher error] ${err.message}`);
    });
  }, POLL_INTERVAL_MS);

  // --- HTTP health endpoint ---
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'prestigio-write-service' }));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, () => {
    console.log(`Prestigio write service running on port ${PORT}`);
    console.log(`Watching ${LEGACY_REQUEST_FILE} and ${REQUEST_DIR} for write requests`);
    console.log(`Health: http://localhost:${PORT}/health`);
  });
}

module.exports = {
  buildConfirmSummary,
  getDraftQuoteSiteVisitTotal,
  summarizeDraftQuotePricingModes,
  sumDraftQuoteItems
};
