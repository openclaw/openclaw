---
name: Excel / XLSX
slug: excel-xlsx
version: 1.0.2
homepage: https://clawic.com/skills/excel-xlsx
description: "Create, inspect, and edit Microsoft Excel workbooks and XLSX files with reliable formulas, dates, types, formatting, recalculation, and template preservation. Use when (1) the task is about Excel, `.xlsx`, `.xlsm`, `.xls`, `.csv`, or `.tsv`; (2) formulas, formatting, workbook structure, or compatibility matter; (3) the file must stay reliable after edits."
changelog: Tightened formula anchoring, recalculation, and model traceability after a stricter external spreadsheet audit.
metadata:
  { "clawdbot": { "emoji": "📗", "requires": { "bins": [] }, "os": ["linux", "darwin", "win32"] } }
---

## When to Use

Use when the main artifact is a Microsoft Excel workbook or spreadsheet file, especially when formulas, dates, formatting, merged cells, workbook structure, or cross-platform behavior matter.

## Core Rules

### 1. Choose the workflow by job, not by habit

- Use `pandas` for analysis, reshaping, and CSV-like tasks.
- Use `openpyxl` when formulas, styles, sheets, comments, merged cells, or workbook preservation matter.
- Treat CSV as plain data exchange, not as an Excel feature-complete format.
- Reading values, preserving a live workbook, and building a model from scratch are different spreadsheet jobs.

### 2. Dates are serial numbers with legacy quirks

- Excel stores dates as serial numbers, not real date objects.
- The 1900 date system includes the false leap-day bug, and some workbooks use the 1904 system.
- Time is fractional day data, so formatting and conversion both matter.
- Date correctness is not enough if the number format still displays the wrong thing to the user.

### 3. Keep calculations in Excel when the workbook should stay live

- Write formulas into cells instead of hardcoding derived results from Python.
- Use references to assumption cells instead of magic numbers inside formulas.
- Cached formula values can be stale, so do not trust them blindly after edits.
- Check copied formulas for wrong ranges, wrong sheets, and silent off-by-one drift before delivery.
- Absolute and relative references are part of the logic, so copied formulas can be wrong even when they still "work".
- Test new formulas on a few representative cells before filling them across a whole block.
- Verify denominators, named ranges, and precedent cells before shipping formulas that depend on them.
- A workbook should ship with zero formula errors, not with known `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, or circular-reference fallout left for the user to fix.
- For model-style work, document non-obvious hardcodes, assumptions, or source inputs in comments or nearby notes.

### 4. Protect data types before Excel mangles them

- Long identifiers, phone numbers, ZIP codes, and leading-zero values should usually be stored as text.
- Excel silently truncates numeric precision past 15 digits.
- Mixed text-number columns need explicit handling on read and on write.
- Scientific notation, auto-parsed dates, and stripped leading zeros are common corruption, not cosmetic issues.

### 5. Preserve workbook structure before changing content

- Existing templates override generic styling advice.
- Only the top-left cell of a merged range stores the value.
- Hidden rows, hidden columns, named ranges, and external references can still affect formulas and outputs.
- Shared strings, defined names, and sheet-level conventions can matter even when the visible cells look simple.
- Match styles for newly filled cells instead of quietly introducing a new visual system.
- If the workbook is a template, preserve sheet order, widths, freezes, filters, print settings, validations, and visual conventions unless the task explicitly changes them.
- Conditional formatting, filters, print areas, and data validation often carry business meaning even when users only mention the numbers.
- If there is no existing style guide and the file is a model, keep editable inputs visually distinguishable from formulas, but never override an established template to force a generic house style.

### 6. Recalculate and review before delivery

- Formula strings alone are not enough if the recipient needs current values.
- `openpyxl` preserves formulas but does not calculate them.
- Verify no `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, or circular-reference fallout remains.
- If layout matters, render or visually review the workbook before calling it finished.
- Be careful with read modes: opening a workbook for values only and then saving can flatten formulas into static values.
- If assumptions or hardcoded overrides must stay, make them obvious enough that the next editor can audit the workbook.

### 7. Scale the workflow to the file size

- Large workbooks can fail for boring reasons: memory spikes, padded empty rows, and slow full-sheet reads.
- Use streaming or chunked reads when the file is big enough that loading everything at once becomes fragile.
- Large-file workflows also need narrower reads, explicit dtypes, and sheet targeting to avoid accidental damage.

## Common Traps

- Type inference on read can leave numbers as text or convert IDs into damaged numeric values.
- Column indexing varies across tools, so off-by-one mistakes are common in generated formulas.
- Newlines in cells need wrapping to display correctly.
- External references break easily when source files move.
- Password protection in old Excel workflows is not serious security.
- `.xlsm` can contain macros, and `.xls` remains a tighter legacy format.
- Large files may need streaming reads or more careful memory handling.
- Google Sheets and LibreOffice can reinterpret dates, formulas, or styling differently from Excel.
- Dynamic array or newer Excel functions like `FILTER`, `XLOOKUP`, `SORT`, or `SEQUENCE` may fail or degrade in older viewers.
- A workbook can look fine while still carrying stale cached values from a prior recalculation.
- Saving the wrong workbook view can replace formulas with cached values and quietly destroy a live model.
- Copying formulas without checking relative references can push one bad range across an entire block.
- Hidden sheets, named ranges, validations, and merged areas often keep business logic that is invisible in a quick skim.
- A workbook can appear numerically correct while still failing because filters, conditional formats, print settings, or data validation were stripped.
- A workbook can be numerically correct and still fail visually because wrapped text, clipped labels, or narrow columns were never reviewed.

## Related Skills

Install with `clawhub install <slug>` if user confirms:

- `csv` — Plain-text tabular import and export workflows.
- `data` — General data handling patterns before spreadsheet output.
- `data-analysis` — Higher-level analysis that can feed workbook deliverables.

## Feedback

- If useful: `clawhub star excel-xlsx`
- Stay updated: `clawhub sync`
