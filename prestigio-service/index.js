const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Config ---
const PORT = process.env.PORT || 3005;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DATA_DIR = '/data';
const REQUEST_FILE = path.join(DATA_DIR, 'query-request.json');
const RESPONSE_FILE = path.join(DATA_DIR, 'query-response.json');
const POLL_INTERVAL_MS = 1000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

const CATEGORY_ALIASES = {
  'soft goods': 'softgoods',
  'soft-good': 'softgoods',
  'soft_goods': 'softgoods',
  're-upholstery': 'reupholstery',
  're upholstery': 'reupholstery',
  sectional: 'sectionals'
};

const CATEGORY_CAPABILITIES = {
  seating: { drawingAndFrame: true },
  sectionals: { drawingAndFrame: true },
  ottoman: { drawingAndFrame: true },
  bed: { drawingAndFrame: true },
  pillows: { drawingAndFrame: false, finishingFlow: false },
  softgoods: { drawingAndFrame: false, finishingFlow: false },
  cushions: { drawingAndFrame: false, finishingFlow: false },
  reupholstery: { drawingAndFrame: false, clientItemFlow: true },
  restuffing: { drawingAndFrame: false, fabricFlow: false, seamingFlow: false, finishingFlow: false },
  patio: { drawingAndFrame: false }
};

const DEFAULT_CATEGORY_CAPABILITIES = {
  drawingAndFrame: false,
  fabricFlow: true,
  seamingFlow: true,
  clientItemFlow: false,
  finishingFlow: true
};

function normalizeFields(fields) {
  if (fields === 'full' || fields === 'write') return fields;
  return 'lean';
}

function toStructuredError(source, status, message) {
  return JSON.stringify({
    source,
    status,
    message: String(message || 'Unknown error').slice(0, 200)
  });
}

function parseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    return JSON.parse(message);
  } catch (_) {
    return { message };
  }
}

function extractSupabaseMessage(body) {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
    if (typeof parsed?.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (typeof parsed?.details === 'string' && parsed.details.trim()) {
      return parsed.details.trim();
    }
  } catch (_) {
    // fall through to raw body
  }
  return String(body || 'Unknown Supabase error');
}

// --- Supabase REST helper ---
async function supabaseGet(tableOrView, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${tableOrView}?${params}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(toStructuredError('supabase', res.status, extractSupabaseMessage(body)));
  }
  return res.json();
}

// --- Query implementations ---

async function itemLookup(search, fields) {
  if (!search) throw new Error('search param required');
  const term = encodeURIComponent(`*${search}*`);
  const mode = normalizeFields(fields);

  // Search ALL paths in parallel, then merge and deduplicate
  const [bySidemark, byItemName, byProjectPO, byProjectQuote] = await Promise.all([
    // 1. Sidemark match
    supabaseGet('order_items', [
      'select=id,description,sidemark,item_name,status,category,sell_price,quantity,on_hold,',
      'production_department,production_started_at,work_completed_at,',
      'target_completion_date,',
      'pos(po_number,projects(name,clients(name,company)))',
      `&sidemark=ilike.${term}`,
      '&status=neq.canceled',
      '&order=updated_at.desc',
      '&limit=30'
    ].join('')).catch(() => []),

    // 2. Item name match
    supabaseGet('order_items', [
      'select=id,description,sidemark,item_name,status,category,sell_price,quantity,on_hold,',
      'production_department,production_started_at,work_completed_at,',
      'target_completion_date,',
      'pos(po_number,projects(name,clients(name,company)))',
      `&item_name=ilike.${term}`,
      '&status=neq.canceled',
      '&order=updated_at.desc',
      '&limit=30'
    ].join('')).catch(() => []),

    // 3. Project name via PO path (finds active/completed items)
    supabaseGet('order_items', [
      'select=id,description,sidemark,item_name,status,category,sell_price,quantity,on_hold,',
      'production_department,production_started_at,work_completed_at,',
      'target_completion_date,',
      'pos!inner(po_number,projects!inner(name,clients(name,company)))',
      `&pos.projects.name=ilike.${term}`,
      '&status=neq.canceled',
      '&order=status.asc,updated_at.desc',
      '&limit=40'
    ].join('')).catch(() => []),

    // 4. Project name via quote path (finds quote-stage items without POs)
    supabaseGet('order_items', [
      'select=id,description,sidemark,item_name,status,category,sell_price,quantity,on_hold,',
      'production_department,production_started_at,work_completed_at,',
      'target_completion_date,',
      'quotes!order_items_quote_id_fkey!inner(projects!inner(name,clients(name,company)))',
      `&quotes!order_items_quote_id_fkey.projects.name=ilike.${term}`,
      '&status=neq.canceled',
      '&order=updated_at.desc',
      '&limit=20'
    ].join('')).catch(() => [])
  ]);

  // Map quote path data into the same shape
  for (const row of byProjectQuote) {
    const q = row['quotes'];
    if (q?.projects) {
      row._project = q.projects.name;
      row._client = q.projects.clients?.name || q.projects.clients?.company;
    }
  }

  // Merge all results, deduplicate by id — prioritize PO-path results first
  const seen = new Set();
  const merged = [];
  for (const row of [...byProjectPO, ...bySidemark, ...byItemName, ...byProjectQuote]) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      merged.push(row);
    }
  }

  // For items without PO data, backfill project/client via quote path
  for (const row of merged) {
    if (!row.pos && !row._project) {
      try {
        const quoteRows = await supabaseGet('order_items', [
          `select=quotes!order_items_quote_id_fkey(projects(name,clients(name,company)))`,
          `&id=eq.${row.id}`
        ].join(''));
        if (quoteRows[0]?.quotes?.projects) {
          row._project = quoteRows[0].quotes.projects.name;
          row._client = quoteRows[0].quotes.projects.clients?.name || quoteRows[0].quotes.projects.clients?.company;
        }
      } catch (_) { /* best effort */ }
    }
  }

  const readinessMap = await getReadinessMap(merged.map(r => r.id));
  const formatter = getFormatter(mode);
  const formattedEntries = merged.map(row => {
    const item = formatter(row);
    const readiness = readinessMap[row.id];

    if (mode === 'full') {
      item.fully_ready = readiness?.fully_ready ?? null;
      item.blockers = deriveBlockers(readiness, row.category);
    } else {
      item.description = row.description || null;
      item.line_total = lineTotalForRow(row);
      item.work_completed = formatDateForLean(row.work_completed_at);
      item.blockers = deriveBlockers(readiness, row.category);
    }

    return { row, item };
  });

  // Separate operational items from quote-stage items
  const operational = formattedEntries
    .filter(entry => entry.row.status !== 'quote')
    .map(entry => entry.item);
  const quoteStage = formattedEntries
    .filter(entry => entry.row.status === 'quote')
    .map(entry => entry.item);
  const truncated = hasReachedLimit(bySidemark, 30)
    || hasReachedLimit(byItemName, 30)
    || hasReachedLimit(byProjectPO, 40)
    || hasReachedLimit(byProjectQuote, 20);

  // If there are operational items, return those (with quote-stage noted separately)
  if (operational.length > 0) {
    if (quoteStage.length > 0) {
      return makeQueryResult({
        items: operational,
        quote_stage_count: quoteStage.length,
        quote_stage_note: `${quoteStage.length} additional item(s) still at quote stage (not yet ordered)`
      }, {
        count: operational.length,
        total: operational.length,
        truncated
      });
    }
    return makeQueryResult(operational, {
      count: operational.length,
      total: operational.length,
      truncated
    });
  }

  // If only quote-stage items exist, return them with a clear label
  if (quoteStage.length > 0) {
    return makeQueryResult({
      items: quoteStage,
      all_quote_stage: true,
      note: 'All matching items are still at quote stage — none have been ordered yet'
    }, {
      count: quoteStage.length,
      total: quoteStage.length,
      truncated
    });
  }

  return makeQueryResult([], { count: 0, total: 0, truncated });
}

async function quoteLookup(search, fields) {
  if (!search) throw new Error('search param required');

  const rawSearch = String(search).trim();
  const term = encodeURIComponent(`*${rawSearch}*`);
  const exactQuoteNumber = encodeURIComponent(rawSearch);
  const mode = normalizeFields(fields);
  const quoteSelect =
    'select=id,quote_number,sidemark,reference,status,grand_total,deposit_amount,xero_quote_id,xero_quote_number,created_at,updated_at,clients(name,company),projects(name)';

  const [byQuoteNumber, bySidemark, byReference, byClient] = await Promise.all([
    supabaseGet('quotes', [
      quoteSelect,
      `&quote_number=ilike.${exactQuoteNumber}`,
      '&order=updated_at.desc',
      '&limit=100'
    ].join('')).catch(() => []),

    supabaseGet('quotes', [
      quoteSelect,
      `&sidemark=ilike.${term}`,
      '&order=updated_at.desc',
      '&limit=100'
    ].join('')).catch(() => []),

    supabaseGet('quotes', [
      quoteSelect,
      `&reference=ilike.${term}`,
      '&order=updated_at.desc',
      '&limit=100'
    ].join('')).catch(() => []),

    supabaseGet('quotes', [
      'select=id,quote_number,sidemark,reference,status,grand_total,deposit_amount,created_at,updated_at,',
      'clients!inner(name,company),projects(name)',
      `&clients.name=ilike.${term}`,
      '&order=updated_at.desc',
      '&limit=100'
    ].join('')).catch(() => [])
  ]);

  const seen = new Set();
  const merged = [];
  for (const row of [...byQuoteNumber, ...bySidemark, ...byReference, ...byClient]) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      merged.push(row);
    }
  }

  merged.sort((a, b) => {
    const aTime = Date.parse(a.updated_at || a.created_at || 0);
    const bTime = Date.parse(b.updated_at || b.created_at || 0);
    return bTime - aTime;
  });
  const truncated = hasReachedLimit(byQuoteNumber, 100)
    || hasReachedLimit(bySidemark, 100)
    || hasReachedLimit(byReference, 100)
    || hasReachedLimit(byClient, 100);

  if (merged.length === 0) {
    return makeQueryResult({
      type: 'quote_lookup',
      search: rawSearch,
      results: [],
      message: `No quotes found matching '${rawSearch}'`
    }, {
      count: 0,
      total: 0,
      truncated
    });
  }

  const lineItemsByQuoteId = {};
  await Promise.all(merged.map(async quote => {
    const rows = await supabaseGet('order_items', [
      'select=id,item_name,description,item_type,quantity,sell_price,',
      'has_skirt,skirt_style,contrast_welt,welting_type,',
      'estimated_fabric_yardage,form_data,quote_item_status',
      `&quote_id=eq.${quote.id}`,
      '&order=created_at.asc'
    ].join(''));

    lineItemsByQuoteId[quote.id] = rows.map(item => formatQuoteLineItem(item, mode));
  }));

  const results = merged.map(quote => formatQuoteRecord(
    quote,
    lineItemsByQuoteId[quote.id] || [],
    mode
  ));

  return makeQueryResult({
    type: 'quote_lookup',
    search: rawSearch,
    results
  }, {
    count: results.length,
    total: results.length,
    truncated
  });
}

async function invoicedItems(search, fields) {
  if (!search) throw new Error('search param required');

  const term = encodeURIComponent(`*${String(search).trim()}*`);
  const mode = normalizeFields(fields);
  const baseSelect = [
    'select=id,description,sidemark,item_name,category,status,sell_price,quantity,',
    'xero_invoice_id,xero_credit_note_id,invoiced_at,paid_at,',
    'pos(po_number,projects(name,clients(name,company,xero_contact_id)))'
  ].join('');
  const projectSelect = [
    'select=id,description,sidemark,item_name,category,status,sell_price,quantity,',
    'xero_invoice_id,xero_credit_note_id,invoiced_at,paid_at,',
    'pos!inner(po_number,projects!inner(name,clients(name,company,xero_contact_id)))'
  ].join('');

  const [bySidemark, byItemName, byProject] = await Promise.all([
    supabaseGet('order_items', [
      baseSelect,
      `&sidemark=ilike.${term}`,
      '&xero_invoice_id=not.is.null',
      '&status=neq.canceled',
      '&order=invoiced_at.desc.nullslast',
      '&limit=100'
    ].join('')).catch(() => []),

    supabaseGet('order_items', [
      baseSelect,
      `&item_name=ilike.${term}`,
      '&xero_invoice_id=not.is.null',
      '&status=neq.canceled',
      '&order=invoiced_at.desc.nullslast',
      '&limit=100'
    ].join('')).catch(() => []),

    supabaseGet('order_items', [
      projectSelect,
      `&pos.projects.name=ilike.${term}`,
      '&xero_invoice_id=not.is.null',
      '&status=neq.canceled',
      '&order=invoiced_at.desc.nullslast',
      '&limit=100'
    ].join('')).catch(() => [])
  ]);

  const seen = new Set();
  const merged = [];
  for (const row of [...bySidemark, ...byItemName, ...byProject]) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      merged.push(row);
    }
  }

  const total = merged.length;
  const truncated = total > 50
    || hasReachedLimit(bySidemark, 100)
    || hasReachedLimit(byItemName, 100)
    || hasReachedLimit(byProject, 100);
  const limited = merged.slice(0, 50);
  const ids = limited.map(row => row.id);

  const [depositMap, paymentMap, creditMap, descMap, readinessMap] = await Promise.all([
    sumAmountMap('deposit_allocations', ids),
    sumAmountMap('balance_payment_allocations', ids),
    sumAmountMap('invoice_credits', ids),
    getDescriptionMap(ids),
    getReadinessMap(ids)
  ]);

  const formatter = getFormatter(mode);
  const results = limited.map(item => {
    const client = item.pos?.projects?.clients;
    const readiness = readinessMap[item.id];
    const lineTotal = lineTotalForRow(item);
    const deposits = roundCurrency(depositMap[item.id] || 0);
    const payments = roundCurrency(paymentMap[item.id] || 0);
    const credits = roundCurrency(creditMap[item.id] || 0);
    const balanceRemaining = roundCurrency(lineTotal - deposits - payments - credits);

    if (mode === 'full') {
      const quantity = Number(item.quantity ?? 1);
      const sellPrice = Number(item.sell_price ?? 0);
      const fullLineTotal = roundCurrency(sellPrice * quantity);

      return {
        id: item.id,
        description: descMap[item.id] ?? item.description ?? null,
        sidemark: item.sidemark || item.item_name || null,
        item_name: item.item_name || null,
        category: item.category || null,
        status: item.status || null,
        project_name: item.pos?.projects?.name || null,
        client_name: client?.name || client?.company || null,
        xero_contact_id: client?.xero_contact_id || null,
        po_number: item.pos?.po_number || null,
        sell_price: item.sell_price,
        quantity: item.quantity,
        line_total: fullLineTotal,
        deposits,
        payments,
        credits,
        balance_remaining: balanceRemaining,
        xero_invoice_id: item.xero_invoice_id || null,
        xero_credit_note_id: item.xero_credit_note_id || null,
        invoiced_at: item.invoiced_at || null,
        paid_at: item.paid_at || null,
        fully_ready: readiness?.fully_ready ?? null,
        blockers: deriveBlockers(readiness, item.category)
      };
    }

    const base = formatter(item);
    base.line_total = lineTotal;
    base.deposits = deposits;
    base.payments = payments;
    base.credits = credits;
    base.balance_remaining = balanceRemaining;
    base.xero_invoice_id = item.xero_invoice_id || null;
    base.xero_contact_id = client?.xero_contact_id || null;
    return base;
  });

  return makeQueryResult(results, {
    count: results.length,
    total,
    truncated
  });
}

async function readyForProduction(fields) {
  const mode = normalizeFields(fields);

  // Step 1: Get fully ready items from readiness view
  const ready = await supabaseGet('order_item_readiness', [
    'select=id,sidemark,item_name,status,category,project_name,target_completion_date',
    '&fully_ready=eq.true',
    '&on_hold=eq.false',
    '&status=eq.active',
    '&order=target_completion_date.asc.nullslast',
    '&limit=100'
  ].join(''));

  if (ready.length === 0) {
    return makeQueryResult([], { count: 0, total: 0, truncated: false });
  }

  // Step 2: Check which ones are NOT yet in production
  const ids = ready.map(r => r.id);
  const productionCheck = await supabaseGet('order_items', [
    `select=id,production_started_at,production_department`,
    `&id=in.(${ids.join(',')})`,
  ].join(''));

  const startedIds = new Set(
    productionCheck.filter(r => r.production_started_at).map(r => r.id)
  );

  // Step 3: Get client names and descriptions (not on readiness view)
  const [clientLookup, descMap] = await Promise.all([
    supabaseGet('order_items', [
      `select=id,pos(projects(clients(name,company)))`,
      `&id=in.(${ids.join(',')})`,
    ].join('')),
    mode === 'full' ? getDescriptionMap(ids) : Promise.resolve({})
  ]);
  const clientMap = {};
  for (const row of clientLookup) {
    const c = row.pos?.projects?.clients;
    clientMap[row.id] = c?.name || c?.company || null;
  }

  const formatter = getFormatter(mode);
  const results = ready
    .filter(r => !startedIds.has(r.id))
    .map(r => {
      const row = {
        ...r,
        _project: r.project_name,
        _client: clientMap[r.id] || r.project_name
      };

      if (mode === 'full') {
        return {
          id: r.id,
          description: descMap[r.id] || null,
          sidemark: r.sidemark || r.item_name,
          category: r.category,
          project: r.project_name,
          client: clientMap[r.id] || r.project_name,
          target_completion: r.target_completion_date
        };
      }

      return formatter(row);
    });

  return makeQueryResult(results, {
    count: results.length,
    total: results.length,
    truncated: hasReachedLimit(ready, 100)
  });
}

async function waitingOnFabric(fields) {
  const mode = normalizeFields(fields);
  const rows = await supabaseGet('order_item_readiness', [
    'select=id,sidemark,item_name,status,category,project_name,target_completion_date,',
    'has_fabric_entries,fabric_inspected',
    '&all_fabric_received=eq.false',
    '&status=eq.active',
    '&on_hold=eq.false',
    '&order=target_completion_date.asc.nullslast',
    '&limit=100'
  ].join(''));

  const ids = rows.map(r => r.id);
  const [clientMap, descMap] = await Promise.all([
    getClientMap(ids),
    mode === 'full' ? getDescriptionMap(ids) : Promise.resolve({})
  ]);

  const formatter = getFormatter(mode);
  const results = rows.map(r => {
    const row = {
      ...r,
      _project: r.project_name,
      _client: clientMap[r.id] || r.project_name
    };

    if (mode === 'full') {
      return {
        id: r.id,
        description: descMap[r.id] || null,
        sidemark: r.sidemark || r.item_name,
        category: r.category,
        project: r.project_name,
        client: clientMap[r.id] || r.project_name,
        target_completion: r.target_completion_date,
        has_any_fabric: r.has_fabric_entries,
        fabric_inspected: r.fabric_inspected
      };
    }

    return formatter(row);
  });

  return makeQueryResult(results, {
    count: results.length,
    total: results.length,
    truncated: hasReachedLimit(rows, 100)
  });
}

async function inProduction(department, fields) {
  const mode = normalizeFields(fields);
  let filter = [
    'select=id,description,sidemark,item_name,status,category,sell_price,quantity,on_hold,production_department,production_started_at,',
    'target_completion_date,',
    'pos(po_number,projects(name,clients(name,company)))',
    '&status=eq.active',
    '&production_started_at=not.is.null',
    '&on_hold=is.false'
  ];
  if (department) {
    filter.push(`&production_department=eq.${encodeURIComponent(department)}`);
  }
  filter.push('&order=production_department.asc,production_started_at.asc');
  filter.push('&limit=100');

  const rows = await supabaseGet('order_items', filter.join(''));
  const results = formatItems(rows, mode);
  return makeQueryResult(results, {
    count: results.length,
    total: results.length,
    truncated: hasReachedLimit(rows, 100)
  });
}

async function drawingsNeedingReview(fields) {
  const mode = normalizeFields(fields);
  const rows = await supabaseGet('drawings', [
    'select=id,drawing_type,status,version_number,created_at,',
    'order_items(id,description,sidemark,item_name,category,',
    'pos(projects(name,clients(name,company))))',
    '&status=eq.submitted',
    '&status=neq.superseded',
    '&order=created_at.asc',
    '&limit=50'
  ].join(''));

  const results = rows.map(r => {
    const lean = {
      drawing_type: r.drawing_type,
      version: r.version_number,
      submitted: r.created_at,
      sidemark: r.order_items?.sidemark || r.order_items?.item_name || null,
      category: r.order_items?.category || null,
      project: r.order_items?.pos?.projects?.name || null,
      client: r.order_items?.pos?.projects?.clients?.name || r.order_items?.pos?.projects?.clients?.company || null
    };

    if (mode === 'write') {
      return {
        item_id: r.order_items?.id || null,
        ...lean
      };
    }

    if (mode !== 'full') {
      return lean;
    }

    return {
      item_id: r.order_items?.id || null,
      item_description: r.order_items?.description || null,
      ...lean
    };
  });

  return makeQueryResult(results, {
    count: results.length,
    total: results.length,
    truncated: hasReachedLimit(rows, 50)
  });
}

async function readyForPickup(fields) {
  const mode = normalizeFields(fields);
  const rows = await supabaseGet('order_items', [
    'select=id,description,sidemark,item_name,status,category,sell_price,quantity,on_hold,production_department,work_completed_at,',
    'target_completion_date,',
    'pos(po_number,projects(name,clients(name,company)))',
    '&status=eq.ready%20for%20pick%20up',
    '&order=work_completed_at.asc',
    '&limit=100'
  ].join(''));
  const formatter = getFormatter(mode);
  const results = rows.map(row => {
    if (mode === 'full') return formatter(row);

    const base = formatter(row);
    base.line_total = lineTotalForRow(row);
    base.work_completed = formatDateForLean(row.work_completed_at);
    return base;
  });

  return makeQueryResult(results, {
    count: results.length,
    total: results.length,
    truncated: hasReachedLimit(rows, 100)
  });
}

async function overdueItems(fields) {
  const mode = normalizeFields(fields);
  const today = new Date().toISOString().split('T')[0];
  const rows = await supabaseGet('order_item_readiness', [
    'select=id,sidemark,item_name,status,category,project_name,target_completion_date,',
    'on_hold,fully_ready,all_fabric_received,drawing_approved,frame_ready',
    `&target_completion_date=lt.${today}`,
    '&status=eq.active',
    '&on_hold=eq.false',
    '&order=target_completion_date.asc',
    '&limit=100'
  ].join(''));

  const ids = rows.map(r => r.id);
  const [clientMap, descMap] = await Promise.all([
    getClientMap(ids),
    mode === 'full' ? getDescriptionMap(ids) : Promise.resolve({})
  ]);

  const formatter = getFormatter(mode);
  const results = rows.map(r => {
    const daysOverdue = Math.floor((Date.now() - new Date(r.target_completion_date).getTime()) / 86400000);
    const blockers = deriveBlockers(r, r.category);
    const row = {
      ...r,
      _project: r.project_name,
      _client: clientMap[r.id] || r.project_name
    };

    if (mode === 'full') {
      return {
        id: r.id,
        description: descMap[r.id] || null,
        sidemark: r.sidemark || r.item_name,
        category: r.category,
        project: r.project_name,
        client: clientMap[r.id] || r.project_name,
        target_completion: r.target_completion_date,
        days_overdue: daysOverdue,
        blockers
      };
    }

    const base = formatter(row);
    base.days_overdue = daysOverdue;
    base.blockers = blockers;
    return base;
  });

  return makeQueryResult(results, {
    count: results.length,
    total: results.length,
    truncated: hasReachedLimit(rows, 100)
  });
}

async function projectOverview(search, fields) {
  if (!search) throw new Error('search param required');
  const term = encodeURIComponent(`*${search}*`);
  const mode = normalizeFields(fields);

  const summaries = await supabaseGet('project_summary', [
    'select=project_id,project_name,project_status,client_name,client_company,total_items,completed_items,active_items,on_hold_items,ready_items,blocked_client_items,blocked_prestigio_items',
    `&project_name=ilike.${term}`,
    '&limit=5'
  ].join(''));

  if (summaries.length === 0) {
    return makeQueryResult([], { count: 0, total: 0, truncated: false });
  }

  const projectId = summaries[0].project_id;
  const summary = summaries[0];
  const summaryClient = summary.client_name || summary.client_company || null;

  // Get items via PO path
  const items = await supabaseGet('order_items', [
    'select=id,description,sidemark,item_name,status,category,production_department,',
    'production_started_at,on_hold,sell_price,quantity,target_completion_date,',
    'pos!inner(po_number,projects!inner(name))',
    `&pos.projects.id=eq.${projectId}`,
    '&status=neq.canceled',
    '&order=status.asc,sidemark.asc',
    '&limit=100'
  ].join(''));

  // Also get quote-path items (no PO yet)
  let quoteItems = [];
  try {
    quoteItems = await supabaseGet('order_items', [
      'select=id,description,sidemark,item_name,status,category,production_department,',
      'production_started_at,on_hold,sell_price,quantity,target_completion_date,',
      'quotes!order_items_quote_id_fkey!inner(projects!inner(name))',
      `&quotes!order_items_quote_id_fkey.projects.id=eq.${projectId}`,
      '&po_id=is.null',
      '&status=neq.canceled',
      '&order=status.asc,sidemark.asc',
      '&limit=50'
    ].join(''));
  } catch (_) { /* ok */ }

  const allItems = [...items, ...quoteItems];
  const readinessMap = await getReadinessMap(allItems.map(r => r.id));
  const formatter = getFormatter(mode);
  const formattedItems = allItems.map(r => {
    const row = {
      ...r,
      _project: summary.project_name || resolveProjectName(r),
      _client: summaryClient
    };
    const readiness = readinessMap[r.id];
    const blockers = deriveBlockers(readiness, r.category);

    if (mode === 'full') {
      const rd = readinessMap[r.id];
      return {
        id: r.id,
        description: r.description || null,
        sidemark: r.sidemark || r.item_name,
        status: r.status,
        category: r.category,
        department: r.production_department,
        in_production: !!r.production_started_at,
        on_hold: r.on_hold,
        fully_ready: rd?.fully_ready ?? null,
        blockers: deriveBlockers(rd, r.category),
        line_total: (r.sell_price || 0) * (r.quantity || 1),
        target_completion: r.target_completion_date
      };
    }

    const base = formatter(row);
    base.fully_ready = readiness?.fully_ready ?? null;
    base.blockers = blockers;
    base.line_total = lineTotalForRow(r);
    return base;
  });

  return makeQueryResult({
    summary,
    items: formattedItems
  }, {
    count: formattedItems.length,
    total: formattedItems.length,
    truncated: hasReachedLimit(summaries, 5)
      || hasReachedLimit(items, 100)
      || hasReachedLimit(quoteItems, 50)
  });
}

async function pipelineSummary() {
  const rows = await supabaseGet('order_items', [
    'select=status',
    '&status=neq.canceled',
    '&status=neq.quote'
  ].join(''));

  const counts = {};
  for (const r of rows) {
    counts[r.status] = (counts[r.status] || 0) + 1;
  }
  return counts;
}

async function collectionsOwed(fields) {
  const mode = normalizeFields(fields);
  const rows = await supabaseGet('order_items', [
    'select=id,description,sidemark,item_name,status,category,sell_price,quantity,on_hold,production_department,work_completed_at,target_completion_date,',
    'pos(po_number,projects(name,clients(name,company)))',
    '&status=eq.collected',
    '&paid_at=is.null',
    '&sell_price=gt.0',
    '&order=work_completed_at.asc',
    '&limit=100'
  ].join(''));
  const formatter = getFormatter(mode);
  const results = rows.map(row => {
    if (mode === 'full') return formatter(row);

    const base = formatter(row);
    base.line_total = lineTotalForRow(row);
    base.work_completed = formatDateForLean(row.work_completed_at);
    return base;
  });

  return makeQueryResult(results, {
    count: results.length,
    total: results.length,
    truncated: hasReachedLimit(rows, 100)
  });
}

async function clientItems(search, fields) {
  if (!search) throw new Error('search param required');
  const term = encodeURIComponent(`*${search}*`);
  const mode = normalizeFields(fields);

  const rows = await supabaseGet('order_items', [
    'select=id,description,sidemark,item_name,status,category,sell_price,quantity,on_hold,',
    'production_department,production_started_at,target_completion_date,',
    'pos!inner(po_number,projects!inner(name,clients!inner(name,company)))',
    `&pos.projects.clients.name=ilike.${term}`,
    '&status=neq.canceled',
    '&order=status.asc,sidemark.asc',
    '&limit=100'
  ].join(''));

  const formatter = getFormatter(mode);
  const formatClientRows = (selectedRows) => selectedRows.map(row => {
    if (mode === 'full') return formatter(row);

    const base = formatter(row);
    base.line_total = lineTotalForRow(row);
    return base;
  });

  if (rows.length === 0) {
    const rows2 = await supabaseGet('order_items', [
      'select=id,description,sidemark,item_name,status,category,sell_price,quantity,on_hold,',
      'production_department,production_started_at,target_completion_date,',
      'pos!inner(po_number,projects!inner(name,clients!inner(name,company)))',
      `&pos.projects.clients.company=ilike.${term}`,
      '&status=neq.canceled',
      '&order=status.asc,sidemark.asc',
      '&limit=100'
    ].join(''));
    const results = formatClientRows(rows2);
    return makeQueryResult(results, {
      count: results.length,
      total: results.length,
      truncated: hasReachedLimit(rows2, 100)
    });
  }

  const results = formatClientRows(rows);
  return makeQueryResult(results, {
    count: results.length,
    total: results.length,
    truncated: hasReachedLimit(rows, 100)
  });
}

async function projectContacts(search, fields) {
  if (!search) throw new Error('search param required');
  const term = encodeURIComponent(`*${search}*`);
  const mode = normalizeFields(fields);

  // Find matching projects (same pattern as projectOverview)
  let summaries = await supabaseGet('project_summary', [
    `select=project_id,project_name,client_name`,
    `&project_name=ilike.${term}`,
    '&limit=10'
  ].join(''));

  if (summaries.length === 0) {
    summaries = await supabaseGet('project_summary', [
      `select=project_id,project_name,client_name`,
      `&client_name=ilike.${term}`,
      '&limit=10'
    ].join(''));
  }

  if (summaries.length === 0) {
    return makeQueryResult([], { count: 0, total: 0, truncated: false });
  }

  const results = [];

  for (const proj of summaries) {
    const designerMap = new Map();

    // Path 1 — Normalized: project_designers → designers
    try {
      const normalized = await supabaseGet('project_designers', [
        `select=designer_id,designers(name,email)`,
        `&project_id=eq.${proj.project_id}`
      ].join(''));
      for (const row of normalized) {
        if (row.designers?.email) {
          designerMap.set(row.designers.email, {
            name: row.designers.name,
            email: row.designers.email,
            source: 'project_designers'
          });
        }
      }
    } catch (_) { /* best effort */ }

    // Path 2 — Legacy: projects.collaborating_designers text[]
    try {
      const legacy = await supabaseGet('projects', [
        `select=collaborating_designers`,
        `&id=eq.${proj.project_id}`
      ].join(''));
      const emails = legacy[0]?.collaborating_designers || [];
      for (const email of emails) {
        if (email && !designerMap.has(email)) {
          // Look up designer name from designers table
          try {
            const designer = await supabaseGet('designers', [
              `select=name,email`,
              `&email=eq.${encodeURIComponent(email)}`
            ].join(''));
            designerMap.set(email, {
              name: designer[0]?.name || null,
              email: email,
              source: 'legacy_array'
            });
          } catch (_) {
            designerMap.set(email, {
              name: null,
              email: email,
              source: 'legacy_array'
            });
          }
        }
      }
    } catch (_) { /* best effort */ }

    const designers = Array.from(designerMap.values()).map(designer => {
      if (mode === 'full') return designer;
      return {
        name: designer.name,
        email: designer.email
      };
    });

    if (mode === 'full') {
      results.push({
        project_id: proj.project_id,
        project_name: proj.project_name,
        client_name: proj.client_name,
        designers
      });
      continue;
    }

    const leanResult = {
      project_name: proj.project_name,
      client_name: proj.client_name,
      designers
    };

    if (mode === 'write') {
      leanResult.project_id = proj.project_id;
    }

    results.push(leanResult);
  }

  return makeQueryResult(results, {
    count: results.length,
    total: results.length,
    truncated: hasReachedLimit(summaries, 10)
  });
}

async function departmentLoad() {
  const rows = await supabaseGet('order_items', [
    'select=production_department',
    '&status=eq.active',
    '&production_started_at=not.is.null',
    '&on_hold=is.false'
  ].join(''));

  const counts = {};
  for (const r of rows) {
    const dept = r.production_department || 'unassigned';
    counts[dept] = (counts[dept] || 0) + 1;
  }
  return counts;
}

// --- Helpers ---

function makeQueryResult(data, meta = {}) {
  return {
    __queryResult: true,
    data,
    meta
  };
}

function unwrapQueryResult(result) {
  if (result && result.__queryResult === true) {
    return result;
  }
  return makeQueryResult(result);
}

function resolveProjectName(row) {
  return row._project
    || row.project
    || row.project_name
    || row.pos?.projects?.name
    || row.quotes?.projects?.name
    || row.projects?.name
    || null;
}

function resolveClientName(row) {
  const client = row.pos?.projects?.clients
    || row.quotes?.projects?.clients
    || row.clients;
  return row._client
    || row.client
    || row.client_name
    || client?.name
    || client?.company
    || null;
}

function resolvePoNumber(row) {
  return row.pos?.po_number || row.po_number || null;
}

function resolveDepartment(row) {
  return row.production_department || row.department || null;
}

function resolveTargetCompletion(row) {
  return row.target_completion_date || row.target_completion || null;
}

function lineTotalForRow(row) {
  return roundCurrency((row.sell_price || 0) * (row.quantity || 1));
}

function formatDateForLean(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-US');
}

function formatItem(row) {
  return {
    id: row.id,
    description: row.description || null,
    sidemark: row.sidemark || row.item_name,
    item_name: row.item_name || null,
    status: row.status,
    category: row.category,
    project: resolveProjectName(row),
    client: resolveClientName(row),
    po_number: resolvePoNumber(row),
    sell_price: row.sell_price,
    quantity: row.quantity,
    line_total: lineTotalForRow(row),
    department: resolveDepartment(row),
    in_production: row.in_production != null ? !!row.in_production : !!row.production_started_at,
    on_hold: row.on_hold || false,
    target_completion: resolveTargetCompletion(row),
    work_completed: row.work_completed_at || row.work_completed || null
  };
}

function formatItemLean(row) {
  return {
    sidemark: row.sidemark || row.item_name,
    status: row.status ?? null,
    category: row.category ?? null,
    project: resolveProjectName(row),
    client: resolveClientName(row),
    po_number: resolvePoNumber(row),
    on_hold: row.on_hold || false,
    department: resolveDepartment(row),
    target_completion: resolveTargetCompletion(row)
  };
}

function formatItemWrite(row) {
  return { id: row.id, ...formatItemLean(row) };
}

function getFormatter(fields) {
  if (fields === 'full') return formatItem;
  if (fields === 'write') return formatItemWrite;
  return formatItemLean;
}

function formatItems(rows, fields = 'full') {
  const formatter = getFormatter(fields);
  return rows.map(row => formatter(row));
}

function hasReachedLimit(rows, limit) {
  return Array.isArray(rows) && rows.length >= limit;
}

function buildSuccessResponse(type, params, result) {
  const normalized = normalizeQueryResponse(type, result);
  const payload = {
    success: true,
    query_type: type,
    request_echo: params?.search || params?.department || null,
    results: normalized.results,
    timestamp: new Date().toISOString()
  };

  if (typeof normalized.count === 'number') {
    payload.count = normalized.count;
    payload.total = typeof normalized.total === 'number' ? normalized.total : normalized.count;
    payload.truncated = Boolean(normalized.truncated);
  }

  return payload;
}

function formatQuoteLineItem(item, fields) {
  const mode = normalizeFields(fields);
  const leanItem = {
    item_name: item.item_name || item.sidemark || null,
    description: item.description || null,
    quantity: item.quantity,
    sell_price: item.sell_price,
    has_skirt: item.has_skirt,
    skirt_style: item.skirt_style,
    contrast_welt: item.contrast_welt,
    welting_type: item.welting_type,
    estimated_fabric_yardage: item.estimated_fabric_yardage
  };

  if (mode === 'write') {
    return { id: item.id, ...leanItem };
  }

  if (mode !== 'full') {
    return leanItem;
  }

  return {
    id: item.id,
    item_name: item.item_name || null,
    description: item.description || null,
    item_type: item.item_type || null,
    quantity: item.quantity,
    sell_price: item.sell_price,
    has_skirt: item.has_skirt,
    skirt_style: item.skirt_style,
    contrast_welt: item.contrast_welt,
    welting_type: item.welting_type,
    estimated_fabric_yardage: item.estimated_fabric_yardage,
    form_data: item.form_data,
    quote_item_status: item.quote_item_status || null
  };
}

function formatQuoteRecord(quote, lineItems, fields) {
  const mode = normalizeFields(fields);
  const leanRecord = {
    quote_number: quote.quote_number,
    sidemark: quote.sidemark || null,
    reference: quote.reference || null,
    status: quote.status || null,
    grand_total: quote.grand_total,
    deposit_amount: quote.deposit_amount,
    client_name: quote.clients?.name || quote.clients?.company || null,
    project_name: quote.projects?.name || null,
    line_items: lineItems
  };

  if (mode === 'write') {
    return {
      id: quote.id,
      xero_quote_id: quote.xero_quote_id || null,
      xero_quote_number: quote.xero_quote_number || null,
      ...leanRecord
    };
  }

  if (mode !== 'full') {
    return leanRecord;
  }

  return {
    id: quote.id,
    quote_number: quote.quote_number,
    sidemark: quote.sidemark,
    reference: quote.reference,
    status: quote.status,
    grand_total: quote.grand_total,
    deposit_amount: quote.deposit_amount,
    xero_quote_id: quote.xero_quote_id || null,
    xero_quote_number: quote.xero_quote_number || null,
    client_name: quote.clients?.name || quote.clients?.company || null,
    project_name: quote.projects?.name || null,
    created_at: quote.created_at,
    updated_at: quote.updated_at,
    line_items: lineItems
  };
}

async function getClientMap(ids) {
  if (ids.length === 0) return {};
  const rows = await supabaseGet('order_items', [
    `select=id,pos(projects(clients(name,company)))`,
    `&id=in.(${ids.join(',')})`,
  ].join(''));
  const map = {};
  for (const r of rows) {
    const c = r.pos?.projects?.clients;
    map[r.id] = c?.name || c?.company || null;
  }
  return map;
}

async function getDescriptionMap(ids) {
  if (ids.length === 0) return {};
  const rows = await supabaseGet('order_items', [
    `select=id,description`,
    `&id=in.(${ids.join(',')})`,
  ].join(''));
  const map = {};
  for (const r of rows) {
    map[r.id] = r.description || null;
  }
  return map;
}

async function sumAmountMap(tableName, ids) {
  if (ids.length === 0) return {};
  const rows = await supabaseGet(tableName, [
    'select=order_item_id,amount',
    `&order_item_id=in.(${ids.join(',')})`,
    '&limit=1000'
  ].join(''));
  const map = {};
  for (const row of rows) {
    const amount = Number(row.amount || 0);
    if (!Number.isFinite(amount)) continue;
    map[row.order_item_id] = (map[row.order_item_id] || 0) + amount;
  }
  return map;
}

async function getReadinessMap(ids) {
  if (ids.length === 0) return {};
  const rows = await supabaseGet('order_item_readiness', [
    'select=id,drawing_approved,all_fabric_received,fabric_inspected,',
    'knit_backing_done,direction_confirmed,seaming_cleared,',
    'frame_ready,frame_status,client_item_received,client_item_needed,',
    'finishing_needed,finishing_received,fully_ready,on_hold',
    `&id=in.(${ids.join(',')})`,
  ].join(''));
  const map = {};
  for (const r of rows) {
    map[r.id] = r;
  }
  return map;
}

function normalizeCategory(category) {
  const raw = String(category || '').trim().toLowerCase();
  if (!raw) return '';
  return CATEGORY_ALIASES[raw] || raw;
}

function getCategoryCapabilities(category) {
  const normalized = normalizeCategory(category);
  const categoryCaps = CATEGORY_CAPABILITIES[normalized] || {};
  return {
    ...DEFAULT_CATEGORY_CAPABILITIES,
    ...categoryCaps
  };
}

function deriveBlockers(r, category) {
  if (!r) return [];
  const capabilities = getCategoryCapabilities(category);
  const blockers = [];

  if (capabilities.drawingAndFrame && r.drawing_approved === false) {
    blockers.push('Drawing not approved');
  }

  if (capabilities.fabricFlow && r.all_fabric_received === false) {
    blockers.push('Fabric not received');
  }

  if (capabilities.fabricFlow && r.fabric_inspected === false && r.all_fabric_received === true) {
    blockers.push('Fabric not inspected');
  }

  if (capabilities.fabricFlow && r.knit_backing_done === false) {
    blockers.push('Knit backing not done');
  }

  if (capabilities.fabricFlow && r.direction_confirmed === false) {
    blockers.push('Fabric direction not confirmed');
  }

  if (capabilities.seamingFlow && r.seaming_cleared === false) {
    blockers.push('Seaming not cleared');
  }

  if (capabilities.drawingAndFrame && r.frame_ready === false) {
    blockers.push('Frame not ready' + (r.frame_status ? ` (${r.frame_status})` : ''));
  }

  if (r.client_item_needed === true && r.client_item_received === false) blockers.push('Client item not received');

  if (capabilities.finishingFlow && r.finishing_needed === true && r.finishing_received === false) {
    blockers.push('Finishing not received');
  }

  if (r.on_hold === true) blockers.push('On hold');
  return blockers;
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

// --- Query router ---

async function handleQuery(type, params = {}, fields = 'lean') {
  const mode = normalizeFields(params?.fields || fields);

  switch (type) {
    case 'item_lookup': return itemLookup(params.search, mode);
    case 'quote_lookup': return quoteLookup(params.search, mode);
    case 'invoiced_items': return invoicedItems(params.search, mode);
    case 'ready_for_production': return readyForProduction(mode);
    case 'waiting_on_fabric': return waitingOnFabric(mode);
    case 'in_production': return inProduction(params.department, mode);
    case 'drawings_needing_review': return drawingsNeedingReview(mode);
    case 'ready_for_pickup': return readyForPickup(mode);
    case 'overdue_items': return overdueItems(mode);
    case 'project_overview': return projectOverview(params.search, mode);
    case 'pipeline_summary': return pipelineSummary();
    case 'collections_owed': return collectionsOwed(mode);
    case 'client_items': return clientItems(params.search, mode);
    case 'department_load': return departmentLoad();
    case 'project_contacts': return projectContacts(params.search, mode);
    default: throw new Error(`Unknown query type: ${type}`);
  }
}

function normalizeQueryResponse(type, result) {
  const queryResult = unwrapQueryResult(result);
  const data = queryResult.data;
  const meta = queryResult.meta || {};
  const withMeta = (payload) => ({
    ...payload,
    total: typeof meta.total === 'number'
      ? meta.total
      : typeof payload.count === 'number'
        ? payload.count
        : undefined,
    truncated: Boolean(meta.truncated)
  });

  if (['pipeline_summary', 'department_load'].includes(type)) {
    return { results: data };
  }

  if (type === 'quote_lookup') {
    const quotes = Array.isArray(data)
      ? data
      : Array.isArray(data?.quotes)
        ? data.quotes
        : Array.isArray(data?.results)
          ? data.results
          : data
            ? [data]
            : [];
    return withMeta({
      results: data,
      count: typeof meta.count === 'number' ? meta.count : quotes.length
    });
  }

  if (type === 'project_overview') {
    const items = Array.isArray(data?.items) ? data.items : [];
    return withMeta({
      results: data,
      summary: data?.summary,
      count: typeof meta.count === 'number' ? meta.count : items.length
    });
  }

  if (Array.isArray(data)) {
    return withMeta({
      results: data,
      count: typeof meta.count === 'number' ? meta.count : data.length
    });
  }

  if (data && typeof data === 'object' && Array.isArray(data.items)) {
    return withMeta({
      results: data,
      count: typeof meta.count === 'number' ? meta.count : data.items.length
    });
  }

  if (typeof meta.count === 'number') {
    return withMeta({
      results: data,
      count: meta.count
    });
  }

  return { results: data };
}

// --- Write response atomically ---

function writeResponse(data) {
  const tmp = RESPONSE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, RESPONSE_FILE);
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
    const req = JSON.parse(raw);

    if (req.action !== 'query' || !req.type) {
      writeResponse({
        success: false,
        error: 'Invalid request: action must be "query" and type is required',
        timestamp: new Date().toISOString()
      });
      return;
    }

    const params = { ...(req.params || {}) };
    const fields = normalizeFields(params.fields || req.fields || 'lean');
    params.fields = fields;

    console.log(`[query] ${req.type} ${params.search || params.department || ''} (${fields})`);

    handleQuery(req.type, params, fields)
      .then(result => {
        const payload = buildSuccessResponse(req.type, params, result);
        const isArray = Array.isArray(payload.results);
        writeResponse(payload);
        const resultLabel = typeof payload.count === 'number'
          ? payload.count
          : isArray
            ? payload.results.length
            : 'object';
        console.log(`[done] ${req.type}: ${resultLabel} results`);
      })
      .catch(err => {
        console.error(`[error] ${req.type}: ${err.message}`);
        writeResponse({
          success: false,
          query_type: req.type,
          error: parseError(err),
          timestamp: new Date().toISOString()
        });
      });
  } catch (err) {
    console.error(`[watcher error] ${err.message}`);
  }
}

setInterval(checkForRequest, POLL_INTERVAL_MS);

// --- HTTP server for health + direct queries ---

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    try {
      await supabaseGet('order_items', 'select=id&limit=1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', supabase_connected: true }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'degraded', supabase_connected: false, error: parseError(err) }));
    }
    return;
  }

  if (url.pathname === '/query') {
    const type = url.searchParams.get('type');
    const search = url.searchParams.get('search');
    const department = url.searchParams.get('department');
    const fields = normalizeFields(url.searchParams.get('fields') || 'lean');
    if (!type) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'type param required' }));
      return;
    }
    try {
      const params = { search, department, fields };
      const result = await handleQuery(type, params, fields);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildSuccessResponse(type, params, result), null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: parseError(err) }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Prestigio query service running on port ${PORT}`);
  console.log(`Watching ${REQUEST_FILE} for queries`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
