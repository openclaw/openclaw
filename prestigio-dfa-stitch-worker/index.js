const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_FILE = process.env.ENV_FILE || path.join(ROOT_DIR, '.env');
const ENV = readEnvFile(ENV_FILE);
const POLL_MS = Number(process.env.POLL_MS || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL || ENV.SUPABASE_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ENV.SUPABASE_SERVICE_KEY ||
  ENV.SUPABASE_SERVICE_ROLE_KEY;
const GATEWAY_CONTAINER = process.env.OPENCLAW_GATEWAY_CONTAINER || 'openclaw-openclaw-gateway-1';
const DOCKER_BIN = process.env.DOCKER_BIN || '/usr/local/bin/docker';
const PDFTOPPM_BIN = process.env.PDFTOPPM_BIN || '/opt/homebrew/bin/pdftoppm';
const OPENCLAW_CONFIG_DIR = process.env.OPENCLAW_CONFIG_DIR || ENV.OPENCLAW_CONFIG_DIR || '/Users/chrisreyes/.openclaw';
const DFA_MEDIA_DIR = process.env.DFA_MEDIA_DIR || path.join(OPENCLAW_CONFIG_DIR, 'media', 'dfa-reviews');
const STITCH_AGENT_ID = process.env.STITCH_AGENT_ID || 'main';
const STITCH_THINKING = process.env.STITCH_THINKING || 'medium';
const STITCH_TIMEOUT_SECONDS = String(Number(process.env.STITCH_TIMEOUT_SECONDS || 180));
const MODEL_NAME = process.env.STITCH_DFA_MODEL_NAME || 'stitch-openclaw';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[dfa-stitch-worker] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json'
};

let busy = false;

function readEnvFile(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr || ''}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function supabaseRequest(table, method, body, query = '') {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers: {
      ...HEADERS,
      Prefer: 'return=representation'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${table} ${method} ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function fetchNextJob() {
  const rows = await supabaseRequest(
    'drawing_ai_review_stitch_jobs',
    'GET',
    undefined,
    '?select=*&status=eq.queued&order=created_at.asc&limit=1'
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function updateJob(jobId, patch) {
  const rows = await supabaseRequest(
    'drawing_ai_review_stitch_jobs',
    'PATCH',
    { ...patch, updated_at: new Date().toISOString() },
    `?id=eq.${encodeURIComponent(jobId)}&select=*`
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

async function buildPrompt(job) {
  if (job.job_type === 'initial_review') return buildInitialReviewPrompt(job);

  return `
You are Stitch continuing a private Prestigio DFA review conversation with Chris Reyes.

Use the saved DFA review context below. Answer Chris directly in plain English.

Rules:
- Be concise and practical.
- V1 is warnings only. Do not call anything a hard blocker.
- Do not invent certainty. If the drawing/PDF or app data needs human confirmation, say so plainly.
- Keep Jay-facing wording separate from Chris-facing reasoning when useful.
- If Chris asks what to do next, give the smallest useful next action.
- Return only the answer text that should be saved into the Prestigio DFA thread.

Job:
${JSON.stringify({
  job_id: job.id,
  question: job.question,
  context: job.context
}, null, 2)}
`.trim();
}

async function renderPdfPagesForJob(job) {
  const pdfUrl = job.context?.drawing?.primary_file_url;
  if (!pdfUrl) return [];

  const jobDir = path.join(DFA_MEDIA_DIR, job.id);
  await fs.promises.mkdir(jobDir, { recursive: true, mode: 0o700 });
  const pdfPath = path.join(jobDir, 'drawing.pdf');

  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error(`Could not download DFA PDF (${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(pdfPath, buffer);

  const outputPrefix = path.join(jobDir, 'page');
  await execFileAsync(PDFTOPPM_BIN, ['-png', '-r', '160', '-f', '1', '-l', '4', pdfPath, outputPrefix], {
    maxBuffer: 10 * 1024 * 1024
  });

  return (await fs.promises.readdir(jobDir))
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort()
    .map((name) => path.join(jobDir, name));
}

async function buildInitialReviewPrompt(job) {
  const context = job.context || {};
  let mediaLines = '';
  try {
    const pageImages = await renderPdfPagesForJob(job);
    if (pageImages.length > 0) {
      mediaLines = [
        `[media attached: ${pageImages.length} files]`,
        ...pageImages.map((pagePath, index) => `[media attached ${index + 1}/${pageImages.length}: ${pagePath} (image/png)]`)
      ].join('\n');
    }
  } catch (error) {
    mediaLines = `PDF render note: ${error instanceof Error ? error.message : String(error)}`;
  }

  return `
You are Stitch running the initial private Prestigio DFA review for Chris Reyes.

Review the attached rendered DFA page images first. The source PDF URL is:
${context?.drawing?.primary_file_url || 'No PDF URL provided'}

${mediaLines}

Use the order item, drawing, prior drawings, and DFA rulebook prompt below. Return ONLY valid JSON. Do not include Markdown.

Important:
- V1 is warnings only. Do not hard-block sending or approval.
- The DFA is the single source of truth.
- Be practical and evidence-based. If you cannot read something, put it in human_review_questions with low confidence.
- Keep production-critical warnings separate from client preference loops.

Rulebook prompt and context:
${context.prompt || JSON.stringify(context, null, 2)}
`.trim();
}

function parseJsonFromText(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```json\\s*([\\s\\S]*?)```/i);
  const raw = fenced?.[1] || trimmed;
  return JSON.parse(raw);
}

function normalizeFindings(reviewJson) {
  const findings = [];
  const groups = [
    ['production-critical', reviewJson?.production_critical_findings],
    ['preference', reviewJson?.client_preference_findings],
    ['warning', reviewJson?.warnings],
    ['data-conflict', reviewJson?.data_conflicts],
    ['low-confidence', reviewJson?.human_review_questions]
  ];

  for (const [defaultSeverity, rows] of groups) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const issue = String(row.issue || row.question || row.finding || '').trim();
      const suggestedFix = String(row.suggested_fix || row.recommendation || '').trim();
      const evidence = String(row.evidence || '').trim();
      const field = String(row.field || '').trim();
      const layer = String(row.layer || '').trim();
      const confidence = String(row.confidence || reviewJson?.confidence || 'medium').trim();
      const text = issue || suggestedFix || evidence;
      if (!text) continue;
      findings.push({
        severity: String(row.severity || defaultSeverity),
        category: layer || defaultSeverity,
        field: field || null,
        finding_text: text,
        suggested_fix: suggestedFix || null,
        evidence: evidence || null,
        confidence: confidence || 'medium'
      });
    }
  }

  const redlines = reviewJson?.redline_resolution?.unresolved_redlines;
  if (Array.isArray(redlines)) {
    for (const row of redlines) {
      const issue = String(row.issue || row.summary || '').trim();
      if (!issue) continue;
      findings.push({
        severity: 'warning',
        category: 'redline resolution',
        field: 'redlines',
        finding_text: issue,
        suggested_fix: String(row.suggested_fix || '').trim() || null,
        evidence: String(row.evidence || '').trim() || null,
        confidence: String(row.confidence || reviewJson?.confidence || 'medium')
      });
    }
  }

  return findings.slice(0, 20);
}

function runOpenClawAgent(prompt, sessionId) {
  const args = [
    'exec',
    GATEWAY_CONTAINER,
    'node',
    '/app/dist/index.js',
    'agent',
    '--agent',
    STITCH_AGENT_ID,
    '--session-id',
    sessionId,
    '--message',
    prompt,
    '--thinking',
    STITCH_THINKING,
    '--json',
    '--timeout',
    STITCH_TIMEOUT_SECONDS
  ];

  return new Promise((resolve, reject) => {
    execFile(DOCKER_BIN, args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr || ''}`;
        reject(error);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const text = parsed?.result?.payloads?.map((payload) => payload.text).filter(Boolean).join('\n\n').trim();
        if (!text) throw new Error(`OpenClaw returned no text: ${stdout.slice(0, 500)}`);
        resolve({ text, raw: parsed });
      } catch (parseError) {
        reject(new Error(`Could not parse OpenClaw result: ${parseError.message}\n${stdout.slice(0, 1000)}`));
      }
    });
  });
}

async function saveAssistantMessage(job, answer, raw) {
  const rows = await supabaseRequest(
    'drawing_ai_review_messages',
    'POST',
    {
      review_id: job.review_id,
      order_item_id: job.order_item_id,
      drawing_id: job.drawing_id,
      role: 'assistant',
      message_text: answer,
      model: MODEL_NAME,
      raw_response: {
        backend: 'stitch',
        openclaw_run_id: raw?.runId || null,
        openclaw_status: raw?.status || null
      },
      created_by: job.created_by || null,
      created_by_email: job.created_by_email || null
    },
    '?select=id,role,message_text,model,created_at'
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

async function saveInitialReview(job, answer, raw) {
  const reviewJson = parseJsonFromText(answer);
  const findings = normalizeFindings(reviewJson);

  if (findings.length > 0) {
    await supabaseRequest(
      'drawing_ai_review_findings',
      'POST',
      findings.map((finding) => ({
        review_id: job.review_id,
        order_item_id: job.order_item_id,
        drawing_id: job.drawing_id,
        severity: finding.severity,
        category: finding.category,
        field: finding.field,
        finding_text: finding.finding_text,
        suggested_fix: finding.suggested_fix,
        evidence: finding.evidence,
        confidence: finding.confidence
      }))
    );
  }

  const summary = String(
    reviewJson?.summary ||
      reviewJson?.highest_risk_issue ||
      (findings.length
        ? `DFA review found ${findings.length} warning${findings.length === 1 ? '' : 's'}.`
        : 'DFA review completed with no findings.')
  );

  const rows = await supabaseRequest(
    'drawing_ai_reviews',
    'PATCH',
    {
      status: 'completed',
      readiness: String(reviewJson?.readiness || 'ready_with_warnings'),
      summary,
      raw_response: {
        parsed: reviewJson,
        backend: 'stitch',
        openclaw_run_id: raw?.runId || null,
        openclaw_status: raw?.status || null
      },
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    `?id=eq.${encodeURIComponent(job.review_id)}&select=id,status,summary,readiness,completed_at`
  );
  return { review: Array.isArray(rows) ? rows[0] : rows, findingsCount: findings.length };
}

async function processJob(job) {
  const locked = await updateJob(job.id, {
    status: 'processing',
    locked_at: new Date().toISOString(),
    attempts: Number(job.attempts || 0) + 1,
    error_message: null
  });
  if (!locked || locked.status !== 'processing') return;

  console.log(`[dfa-stitch-worker] processing ${job.id}`);
  const sessionId = `prestigio-dfa-${job.review_id}`;
  try {
    const result = await runOpenClawAgent(await buildPrompt(job), sessionId);
    const message = job.job_type === 'initial_review'
      ? await saveInitialReview(job, result.text, result.raw)
      : await saveAssistantMessage(job, result.text, result.raw);
    await updateJob(job.id, {
      status: 'completed',
      answer_message_id: job.job_type === 'initial_review' ? null : message?.id || null,
      completed_at: new Date().toISOString()
    });
    console.log(`[dfa-stitch-worker] completed ${job.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (job.job_type === 'initial_review') {
      await supabaseRequest(
        'drawing_ai_reviews',
        'PATCH',
        {
          status: 'failed',
          summary: 'DFA review could not be completed.',
          error_message: message.slice(0, 2000),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        `?id=eq.${encodeURIComponent(job.review_id)}&select=id`
      ).catch(() => null);
    }
    await updateJob(job.id, {
      status: 'failed',
      error_message: message.slice(0, 2000)
    });
    console.error(`[dfa-stitch-worker] failed ${job.id}: ${message}`);
  }
}

async function pollOnce() {
  if (busy) return;
  busy = true;
  try {
    const job = await fetchNextJob();
    if (job) await processJob(job);
  } catch (error) {
    console.error('[dfa-stitch-worker] poll error:', error instanceof Error ? error.message : error);
  } finally {
    busy = false;
  }
}

async function main() {
  console.log('[dfa-stitch-worker] started');
  while (true) {
    await pollOnce();
    await sleep(POLL_MS);
  }
}

main().catch((error) => {
  console.error('[dfa-stitch-worker] fatal:', error);
  process.exit(1);
});
