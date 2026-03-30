---
name: dropbox-intake
description: Process documents from a macOS Drop Box folder. Use when user says "check Drop Box" or asks to process/intake incoming documents. Reads PDFs visually (renders to PNG via pymupdf, then uses image tool), extracts all data, saves originals to workspace, logs key info, and gives shred/keep recommendation.
---

# Drop Box Document Intake

## Inbox

`~/Public/Drop Box/`

## Workflow

For each file in the inbox (skip `.localized`):

1. **Render PDF** → `python3 scripts/render_pdf.py <path> [/tmp/prefix] [dpi]`
2. **Read each page** via image tool — extract ALL text, numbers, fields, dates, amounts
3. **Identify document type** (W-2, 1099, 1098, receipt, notice, statement, etc.)
4. **Save original** to workspace under structured path (e.g., `docs/tax/YYYY/`, `docs/investments/`)
5. **Log extracted data** — update relevant database tables or memory files
6. **Reconcile** against existing records; flag discrepancies
7. **Shred recommendation:**
   - **KEEP**: Originals IRS may request (signed documents, unique legal notices with deadlines)
   - **SHRED OK**: Informational copies of 1099s/W-2s (data captured), bank statements (reconciled), routine correspondence, expired notices
8. **Remove file** from Drop Box after processing
9. **Ask questions** about anything unclear before finalizing — never guess on amounts or tax classification

## Notes

- If text extraction yields <100 chars, PDF is image-based — always use render + image tool
- Process ALL pages — tax documents often span multiple pages
- For multi-page docs, try batching 2-3 pages per image call to save round-trips
- If image tool errors on a page, reduce DPI or try a different model
