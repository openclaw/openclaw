const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const review = require('./index');

function makeTinyPdf(filePath, text) {
  const escaped = String(text || 'Hello PDF').replace(/[()\\]/g, '\\$&');
  const stream = `BT /F1 18 Tf 50 90 Td (${escaped}) Tj ET\n`;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}endstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj'
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object) => {
    offsets.push(Buffer.byteLength(body));
    body += `${object}\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  body += `trailer << /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  fs.writeFileSync(filePath, body);
}

test('reviewAttachments extracts text from PDFs inside allowed mail attachment roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-review-'));
  const attachmentDir = path.join(root, 'mail-chris', 'attachments', 'message-1');
  fs.mkdirSync(attachmentDir, { recursive: true });
  const pdfPath = path.join(attachmentDir, 'Schedule.pdf');
  makeTinyPdf(pdfPath, 'Hill Road pillows');

  const result = review.reviewAttachments({
    paths: [pdfPath],
    workspaceDir: root,
    renderPages: 0
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.attachment_count, 1);
  assert.equal(result.summary.pdf_count, 1);
  assert.equal(result.attachments[0].kind, 'pdf');
  assert.equal(result.attachments[0].pdf.pages, 1);
  assert.match(result.attachments[0].extracted_text, /Hill Road pillows/);
  assert.equal(result.attachments[0].sha256.length, 64);
});

test('reviewAttachments refuses paths outside mail attachment roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-review-'));
  const outside = path.join(root, 'outside.pdf');
  makeTinyPdf(outside, 'Outside file');

  assert.throws(
    () => review.reviewAttachments({ paths: [outside], workspaceDir: root }),
    /outside allowed mail attachment roots/
  );
});

test('reviewAttachments can render requested PDF pages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-review-'));
  const attachmentDir = path.join(root, 'mail-chris', 'attachments', 'message-2');
  fs.mkdirSync(attachmentDir, { recursive: true });
  const pdfPath = path.join(attachmentDir, 'Schedule.pdf');
  makeTinyPdf(pdfPath, 'Render me');

  const result = review.reviewAttachments({
    paths: [pdfPath],
    workspaceDir: root,
    renderPages: 1,
    renderDpi: 72
  });

  assert.equal(result.attachments[0].rendered_pages.length, 1);
  assert.equal(fs.existsSync(result.attachments[0].rendered_pages[0].path), true);
});

test('reviewAttachments captures image metadata for allowed images', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-review-'));
  const attachmentDir = path.join(root, 'mail-chris', 'attachments', 'message-3');
  fs.mkdirSync(attachmentDir, { recursive: true });
  const pngPath = path.join(attachmentDir, 'photo.png');
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  fs.writeFileSync(pngPath, Buffer.from(b64, 'base64'));

  const result = review.reviewAttachments({
    paths: [pngPath],
    workspaceDir: root
  });

  assert.equal(result.attachments[0].kind, 'image');
  assert.equal(result.attachments[0].image.pixelWidth, 1);
  assert.equal(result.attachments[0].image.pixelHeight, 1);
});
