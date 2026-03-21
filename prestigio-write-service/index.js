const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- Config ---
const PORT = 3006;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MOUNT_PATH = process.env.MOUNT_PATH || '/data';
const REQUEST_FILE = path.join(MOUNT_PATH, 'write-request.json');
const RESPONSE_FILE = path.join(MOUNT_PATH, 'write-response.json');

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
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
  'send-invoice-email': ['invoiceId', 'xeroInvoiceId', 'xeroInvoiceNumber', 'ccEmails', 'recipientOverrideEmails', 'requested_at']
};

const CONFIRMABLE_ACTIONS = ['set-order-item-production-field', 'set-item-spec-field'];

function computeConfirmDigest(action, params) {
  const secret = process.env.STITCH_SERVICE_KEY;
  if (!secret) {
    return null;
  }
  let canonical;

  if (action === 'set-order-item-production-field') {
    canonical = `${action}:${params.item_id}:${params.field}:${JSON.stringify(params.value)}`;
  } else if (action === 'set-item-spec-field') {
    canonical = `${action}:${params.item_id}:${params.spec_id}:${params.field}:${JSON.stringify(params.value)}`;
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
  return `${action} on ${params.item_id}`;
}

// --- Write response atomically ---
function writeResponse(data) {
  const tmp = RESPONSE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, RESPONSE_FILE);
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
let lastMtime = 0;

function checkForRequest() {
  try {
    if (!fs.existsSync(REQUEST_FILE)) return;
    const stat = fs.statSync(REQUEST_FILE);
    const mtime = stat.mtimeMs;
    if (mtime <= lastMtime) return;
    lastMtime = mtime;

    const raw = fs.readFileSync(REQUEST_FILE, 'utf8');
    const request = JSON.parse(raw);

    const action = request.action;
    console.log(`[write] ${action} item_id=${request.item_id || '(none)'}`);

    // Validate action
    const allowedFields = ACTION_FIELDS[action];
    if (!allowedFields) {
      writeResponse({
        success: false,
        action: action,
        error: `Unknown action: ${action}`,
        completed_at: new Date().toISOString()
      });
      return;
    }

    // Extract action-specific fields
    const fields = {};
    for (const key of allowedFields) {
      if (request[key] !== undefined) {
        fields[key] = request[key];
      }
    }

    if (CONFIRMABLE_ACTIONS.includes(action)) {
      const digest = computeConfirmDigest(action, fields);
      if (!digest) {
        writeResponse({
          success: false,
          error: 'Missing STITCH_SERVICE_KEY for confirmable action',
          completed_at: new Date().toISOString()
        });
        return;
      }

      if (!fields.confirmed) {
        writeResponse({
          success: false,
          requires_confirmation: true,
          action: action,
          summary: buildConfirmSummary(action, fields),
          confirm_digest: digest
        });
        return;
      }

      if (fields.confirm_digest !== digest) {
        writeResponse({
          success: false,
          error: 'DIGEST_MISMATCH',
          message: 'Confirmation digest does not match. The payload may have changed.'
        });
        return;
      }
    }

    callEdgeFunction(action, fields)
      .then(result => {
        writeResponse({
          success: true,
          action: action,
          item_id: request.item_id || request.order_item_id || null,
          message: result.message || 'OK',
          result: result,
          completed_at: new Date().toISOString()
        });
        console.log(`[done] ${action} item_id=${request.item_id || '(none)'}`);
      })
      .catch(err => {
        console.error(`[error] ${action}: ${err.message}`);
        writeResponse({
          success: false,
          action: action,
          item_id: request.item_id || request.order_item_id || null,
          error: err.message,
          completed_at: new Date().toISOString()
        });
      });
  } catch (err) {
    console.error(`[watcher error] ${err.message}`);
  }
}

setInterval(checkForRequest, 1000);

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
  console.log(`Watching ${REQUEST_FILE} for write requests`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
