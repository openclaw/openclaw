const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_MAX_TEXT_CHARS = 120_000;
const DEFAULT_RENDER_PAGES = 0;
const DEFAULT_RENDER_DPI = 120;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);

function defaultWorkspaceDir() {
  return process.env.OPENCLAW_WORKSPACE_DIR || path.join(os.homedir(), '.openclaw', 'workspace');
}

function defaultAllowedRoots(workspaceDir = defaultWorkspaceDir()) {
  return [
    path.join(workspaceDir, 'mail-chris', 'attachments'),
    path.join(workspaceDir, 'mail', 'attachments'),
    path.join(workspaceDir, 'mail-gmail', 'attachments')
  ];
}

function normalizePath(value) {
  return path.resolve(String(value || '').trim());
}

function realPathIfExists(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch (_) {
    return normalizePath(filePath);
  }
}

function isUnderRoot(filePath, root) {
  const resolvedFile = realPathIfExists(filePath);
  const resolvedRoot = realPathIfExists(root);
  const relative = path.relative(resolvedRoot, resolvedFile);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertAllowedPath(filePath, allowedRoots) {
  const resolved = normalizePath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Attachment path does not exist: ${filePath}`);
  }
  if (!allowedRoots.some((root) => isUnderRoot(resolved, root))) {
    throw new Error(`Attachment path is outside allowed mail attachment roots: ${filePath}`);
  }
  const extension = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported attachment extension: ${extension || '(none)'}`);
  }
  return resolved;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function parsePdfInfo(output) {
  const info = {};
  String(output || '').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) return;
    const key = match[1].trim().toLowerCase().replace(/\s+/g, '_');
    info[key] = match[2].trim();
  });
  if (info.pages) info.pages = Number(info.pages);
  return info;
}

function runTextCommand(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
}

function extractPdfText(filePath, maxTextChars) {
  const text = runTextCommand('pdftotext', ['-layout', filePath, '-']);
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  const truncated = normalized.length > maxTextChars;
  return {
    text: truncated ? normalized.slice(0, maxTextChars) : normalized,
    text_chars: normalized.length,
    truncated
  };
}

function renderPdfPages(filePath, outputDir, pageCount, requestedPages, dpi) {
  const pagesToRender = Math.max(0, Math.min(Number(requestedPages || 0), Number(pageCount || 0) || requestedPages || 0));
  if (!pagesToRender) return [];

  const renderDir = path.join(outputDir, 'rendered-pages');
  fs.mkdirSync(renderDir, { recursive: true });

  const outputs = [];
  for (let page = 1; page <= pagesToRender; page += 1) {
    const prefix = path.join(renderDir, `page-${String(page).padStart(3, '0')}`);
    execFileSync('pdftoppm', ['-png', '-r', String(dpi || DEFAULT_RENDER_DPI), '-f', String(page), '-l', String(page), filePath, prefix], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const renderedPath = `${prefix}-${page}.png`;
    if (fs.existsSync(renderedPath)) {
      outputs.push({
        page,
        path: renderedPath,
        size: fs.statSync(renderedPath).size,
        sha256: sha256File(renderedPath)
      });
    }
  }
  return outputs;
}

function parseSipsOutput(output) {
  const metadata = {};
  String(output || '').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!match) return;
    const key = match[1].trim();
    const value = match[2].trim();
    if (key === 'pixelWidth' || key === 'pixelHeight') {
      metadata[key] = Number(value);
    } else if (key !== '') {
      metadata[key] = value;
    }
  });
  return metadata;
}

function inspectImage(filePath) {
  let metadata = {};
  try {
    metadata = parseSipsOutput(runTextCommand('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', filePath]));
  } catch (error) {
    metadata.error = error.message;
  }
  return metadata;
}

function reviewOneAttachment(filePath, options) {
  const stat = fs.statSync(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const base = {
    name: path.basename(filePath),
    path: filePath,
    extension,
    size: stat.size,
    sha256: sha256File(filePath)
  };

  if (extension === '.pdf') {
    const pdfInfo = parsePdfInfo(runTextCommand('pdfinfo', [filePath]));
    const extracted = extractPdfText(filePath, options.maxTextChars);
    const renderedPages = renderPdfPages(
      filePath,
      path.dirname(filePath),
      pdfInfo.pages,
      options.renderPages,
      options.renderDpi
    );
    return {
      ...base,
      kind: 'pdf',
      pdf: pdfInfo,
      extracted_text: extracted.text,
      extracted_text_chars: extracted.text_chars,
      extracted_text_truncated: extracted.truncated,
      rendered_pages: renderedPages
    };
  }

  return {
    ...base,
    kind: 'image',
    image: inspectImage(filePath),
    extracted_text: '',
    rendered_pages: []
  };
}

function buildSummary(reviews) {
  const pdfs = reviews.filter((review) => review.kind === 'pdf').length;
  const images = reviews.filter((review) => review.kind === 'image').length;
  const pages = reviews.reduce((sum, review) => sum + (Number(review.pdf && review.pdf.pages) || 0), 0);
  const textChars = reviews.reduce((sum, review) => sum + (Number(review.extracted_text_chars) || 0), 0);
  return {
    attachment_count: reviews.length,
    pdf_count: pdfs,
    image_count: images,
    pdf_page_count: pages,
    extracted_text_chars: textChars
  };
}

function reviewAttachments(request, options = {}) {
  const paths = Array.isArray(request && request.paths) ? request.paths : [];
  if (paths.length === 0) {
    throw new Error('review_attachments requires a non-empty paths array');
  }

  const workspaceDir = options.workspaceDir || request.workspaceDir || defaultWorkspaceDir();
  const allowedRoots = (options.allowedRoots || request.allowedRoots || defaultAllowedRoots(workspaceDir)).map(normalizePath);
  const reviewOptions = {
    maxTextChars: Number(request.maxTextChars || options.maxTextChars || DEFAULT_MAX_TEXT_CHARS),
    renderPages: Number(request.renderPages ?? options.renderPages ?? DEFAULT_RENDER_PAGES),
    renderDpi: Number(request.renderDpi || options.renderDpi || DEFAULT_RENDER_DPI)
  };

  const reviews = paths.map((inputPath) => {
    const safePath = assertAllowedPath(inputPath, allowedRoots);
    return reviewOneAttachment(safePath, reviewOptions);
  });

  return {
    ok: true,
    action: 'review_attachments',
    reviewedAt: new Date().toISOString(),
    allowedRoots,
    summary: buildSummary(reviews),
    attachments: reviews
  };
}

module.exports = {
  DEFAULT_MAX_TEXT_CHARS,
  DEFAULT_RENDER_PAGES,
  DEFAULT_RENDER_DPI,
  ALLOWED_EXTENSIONS,
  defaultWorkspaceDir,
  defaultAllowedRoots,
  assertAllowedPath,
  parsePdfInfo,
  parseSipsOutput,
  reviewAttachments,
  __test: {
    isUnderRoot,
    buildSummary
  }
};
