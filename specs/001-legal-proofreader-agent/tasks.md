# Tasks: Senior Legal Proofreader Agent (AR-EN)

**Input**: Design documents from `/specs/001-legal-proofreader-agent/`
**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/tool-schema.md ✓, quickstart.md ✓

**Tests**: Unit tests included per project-wide Vitest 70% coverage requirement (CLAUDE.md).

**Organization**: Tasks grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no shared dependencies)
- **[Story]**: Which user story this task belongs to (US1 = Stage 1, US2 = Stage 2)

---

## Phase 1: Setup (Extension Scaffold)

**Purpose**: Create the `extensions/legal-proofreader/` package structure and shared types.

- [x] T001 Create extension directory structure: `extensions/legal-proofreader/` with subdirectories `src/tools/`, `src/services/`; check root `vitest.config.ts` glob covers `extensions/**/src/**/*.test.ts` and add the pattern if missing
- [x] T002 Write `extensions/legal-proofreader/package.json` — name `@openclaw/legal-proofreader`, `"openclaw": { "extensions": ["./index.ts"] }`, production deps `exceljs: "^4.4.0"` and `mammoth: "^1.8.0"`, `openclaw` in `peerDependencies` (no `workspace:*` in `dependencies` per CLAUDE.md)
- [x] T003 [P] Write `extensions/legal-proofreader/index.ts` plugin entry point shell — `export default function register(api: OpenClawPluginApi) {}` body left empty until T011 and T020 fill it in
- [x] T004 [P] Write `extensions/legal-proofreader/src/types.ts` — export `IssueCategory` union string enum (MISTRANSLATION | OMISSION | ADDITION | TERMINOLOGY | GRAMMAR | CROSS_REF | FORMATTING); `IssueRecord` interface (issueId, article, clause, category, arabicExcerpt, englishExcerpt, correction, severity, notes, apply); `AlignedArticle` interface (articleId, arabicText, englishText, pageRef); `GlossaryEntry` interface (arabicTerm, englishTerm); `ProofreadingResult` interface (sessionId, issueCount, issuesByCategory, issuesBySeverity, xlsxPath); `CorrectedDocumentResult` interface (correctedDocxPath, correctionsApplied, correctionsFailed, correctionSkipped, failures)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core extraction and alignment services used by both user stories.

**⚠️ CRITICAL**: US1 and US2 both depend on T004. T007 depends on T005 and T006.

- [x] T005 [P] Implement `extensions/legal-proofreader/src/services/pdf-extractor.ts` — export `extractArabicPdfText(pdfBuffer: Uint8Array): Promise<{pages: string[], articleTexts: Record<string, string>}>`. Use `pdfjs-dist/legacy/build/pdf.mjs` with `disableWorker: true`, `cMapUrl` pointing to `node_modules/pdfjs-dist/cmaps/` resolved via `import.meta.url`, `cMapPacked: true`, `disableFontFace: true`. For each page, call `getTextContent()` with `disableNormalization: false`, filter to `TextItem` (`'str' in item`), sort by `transform[5]` descending then `transform[4]` descending (Y then X for RTL). Detect article boundaries via regex `/^(المادة\s+(الأولى|الثانية|الثالثة|\d+))/u` on joined line text. Return page-level plain text and article-keyed text map.
- [x] T006 [P] Implement `extensions/legal-proofreader/src/services/docx-reader.ts` — export `extractDocxArticles(docxBuffer: Buffer): Promise<{articleId: string, text: string}[]>`. Use `mammoth.extractRawText({ buffer })` to get full text, then parse article headings via regex `/^Article\s+(\d+[a-zA-Z]?)\b/im`. Split text at each heading boundary. Also export `extractDocxBuffer(filePath: string): Promise<Buffer>` using `fs/promises readFile`. Return ordered array of `{articleId, text}` pairs.
- [x] T007 Implement `extensions/legal-proofreader/src/services/article-aligner.ts` — export `alignArticles(arabicTexts: Record<string, string>, englishArticles: {articleId: string, text: string}[]): {aligned: AlignedArticle[], glossary: GlossaryEntry[]}`. Match Arabic article keys to English article IDs by number (normalize Arabic ordinal words to digits via lookup table: الأولى→1, الثانية→2, ... up to عشرون→20; fall back to sequence alignment if numbering diverges). Produce unmatched partial pairs with one side empty string. Extract glossary by scanning the first 3 articles for definition patterns `"<ArabicTerm>" means "<EnglishTerm>"` or `يُقصد بـ "<term>"`. Return aligned pairs array and glossary array. (Depends on T004)

**Checkpoint**: Foundation ready — article text extraction and alignment working. US1 and US2 can now begin.

---

## Phase 3: User Story 1 — Deep Proofreading and Issues Report (Priority: P1) 🎯 MVP

**Goal**: Given an Arabic PDF and English DOCX, produce an XLSX issues report with every bilingual error categorized, located, and severity-rated.

**Independent Test**: Place a translated law DOCX and its Arabic PDF source in the agent workspace, tell the agent to run Stage 1, and verify the XLSX output file contains issue rows with Issue ID, Article, Category (one of 7 types), Severity, Arabic Excerpt, English Excerpt, Suggested Correction, and Apply? = "Yes".

### Implementation for User Story 1

- [x] T008 [P] [US1] Implement `extensions/legal-proofreader/src/services/xlsx-writer.ts` — export `writeIssuesReport(issues: IssueRecord[], outputPath: string): Promise<void>`. Create ExcelJS Workbook, add worksheet "Issues" (no sheet-level RTL — mixed direction sheet). Add frozen header row with columns: A=Issue ID, B=Article, C=Clause, D=Category, E=Severity, F=Arabic Source Text, G=Current English Text, H=Suggested Correction, I=Notes, J=Apply?. Column F: `alignment: { readingOrder: 'rtl', horizontal: 'right', wrapText: true }`, width 40. All other text columns: `alignment: { wrapText: true }`. Apply fill colors to column E: HIGH = `{ type:'pattern', pattern:'solid', fgColor:{argb:'FFFF4444'} }`, MEDIUM = `{ type:'pattern', pattern:'solid', fgColor:{argb:'FFFFA500'} }`, LOW = `{ type:'pattern', pattern:'solid', fgColor:{argb:'FFFFFFCC'} }`. Set Apply? = "Yes" for all rows. Normalize all Arabic strings with `.normalize('NFC')` before writing. Save with `workbook.xlsx.writeFile(outputPath)`.
- [x] T009 [P] [US1] Implement `extensions/legal-proofreader/src/services/ai-reviewer.ts` — export `reviewArticles(aligned: AlignedArticle[], glossary: GlossaryEntry[], opts: {config: OpenClawConfig, lawDomain?: string}): Promise<IssueRecord[]>`. Build system prompt: legal proofreader persona, English instructions, 7 category definitions (MISTRANSLATION/OMISSION/ADDITION/TERMINOLOGY/GRAMMAR/CROSS_REF/FORMATTING), HIGH/MEDIUM/LOW severity definitions, glossary block. Chunk aligned articles into batches of 5–8 using token estimate (arabic.length/3 + english.length/4 ≤ 6000 chars-equivalent). Build user turn per batch with `=== ARABIC SOURCE ===` / `=== ENGLISH TRANSLATION ===` blocks. Run batches in parallel (concurrency cap 5) via Promise semaphore. Extract `<issues>[...]</issues>` from response; fallback to first `[{...}]` array in text. Validate each record via `isValidIssueRecord()`. On 429: parse `retry-after` header, wait, retry (max 3 attempts, backoff 500ms/2s/8s). On parse failure: retry once with JSON-repair instruction. Assign sequential `ISS-NNN` IDs to all aggregated issues. Deduplicate by `(article|category|arabicExcerpt.slice(0,50))`. Sort by numeric article order then severity (HIGH→MEDIUM→LOW). Return final `IssueRecord[]`.
- [x] T010 [US1] Implement `extensions/legal-proofreader/src/tools/stage1-tool.ts` — export `createStage1Tool(api: OpenClawPluginApi): AnyAgentTool`. Tool name: `proofread_stage1`, label: "Legal Proofreader — Stage 1". TypeBox schema per `contracts/tool-schema.md`: `source_pdf` (required string), `translation_docx` (required string), `output_path` (optional string), `law_domain` (optional string). Execute: (1) validate both files exist and have correct MIME (`application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`) — return `jsonResult({error})` if invalid; (2) load both files as buffers; (3) check PDF page count — if >100 pages return warning text asking user to confirm (SC-007); also check aligned article count after alignment — if >200 articles return warning text asking user to confirm (SC-007); (4) call `extractArabicPdfText`, `extractDocxArticles`, `alignArticles`, `reviewArticles`, `writeIssuesReport` in sequence; (5) return `jsonResult` with summary text "Stage 1 complete. Found N issues..." and details object `{sessionId, xlsxPath, issueCount, issuesByCategory, issuesBySeverity, articleCount, durationMs}`. Catch and wrap all errors with `phase` field indicating failure point. (Depends on T005, T006, T007, T008, T009)
- [x] T011 [US1] Update `extensions/legal-proofreader/index.ts` — import `createStage1Tool` from `./src/tools/stage1-tool.js` and call `api.registerTool(createStage1Tool(api), { optional: true })` inside the `register` function. (Depends on T010)
- [x] T012 [P] [US1] Write unit tests in `extensions/legal-proofreader/src/services/pdf-extractor.test.ts` — test: (a) Arabic TextItem RTL sort (items sorted by Y desc then X desc), (b) article heading regex matches `المادة الأولى` and `المادة 12`, (c) `getDocument` called with `disableWorker: true` and `cMapPacked: true` (spy/mock pdfjs); use minimal mock PDF buffer
- [x] T013 [P] [US1] Write unit tests in `extensions/legal-proofreader/src/services/docx-reader.test.ts` — test: (a) `Article 1` heading detected and text attributed to article "1", (b) `Article 12bis` → articleId "12bis", (c) DOCX with no recognizable headings returns single empty-keyed entry, (d) verify mammoth called with correct buffer arg; mock `mammoth.extractRawText`
- [x] T014 [P] [US1] Write unit tests in `extensions/legal-proofreader/src/services/article-aligner.test.ts` — test: (a) Arabic `المادة الثالثة` aligns to English `Article 3`, (b) unmatched Arabic article produces partial pair with empty englishText, (c) unmatched English article produces partial pair with empty arabicText, (d) glossary extraction finds `"Company" means "..."` pattern
- [x] T015 [P] [US1] Write unit tests in `extensions/legal-proofreader/src/services/xlsx-writer.test.ts` — test: (a) output file created at specified path, (b) column F cell has `readingOrder: 'rtl'` in cell style, (c) Apply? column defaults to "Yes" for all rows, (d) Arabic text NFC-normalized before writing (input NFD → output NFC), (e) HIGH severity row has red fill; use ExcelJS to read back the generated file for assertions
- [x] T016 [P] [US1] Write unit tests in `extensions/legal-proofreader/src/services/ai-reviewer.test.ts` — mock AI API calls; test: (a) articles chunked into batches ≤ 8 articles, (b) `<issues>[...]</issues>` extraction from response string, (c) invalid issue records (missing required fields) filtered out, (d) duplicate issues deduplicated by key, (e) issues sorted by article number ascending, (f) ISS-NNN IDs assigned sequentially

**Checkpoint**: Stage 1 fully functional. Agent can produce XLSX issues report from Arabic PDF + English DOCX.

---

## Phase 4: User Story 2 — Apply Corrections with Track Changes (Priority: P2)

**Goal**: Read the Stage 1 XLSX report, apply all `Apply? = Yes` corrections to the original DOCX as native track changes that are individually reviewable in Word or LibreOffice.

**Independent Test**: Provide an existing XLSX issues file and the original DOCX, trigger Stage 2, open the output DOCX in a word processor — each correction from the XLSX appears as a separate, individually acceptable or rejectable track change; original formatting and any pre-existing track changes are intact.

### Implementation for User Story 2

- [x] T017 [P] [US2] Implement `extensions/legal-proofreader/src/services/xlsx-reader.ts` — export `readIssuesReport(xlsxPath: string): Promise<IssueRecord[]>`. Use ExcelJS to open workbook, find "Issues" worksheet. Read rows starting at row 2 (skip header). Map columns A–J to IssueRecord fields. Filter to rows where column J value (trimmed, case-insensitive) equals `"yes"`. Skip rows with empty Issue ID or empty english_excerpt. Return filtered array. Throw descriptive error if file not found or sheet missing.
- [x] T018 [US2] Implement `extensions/legal-proofreader/src/services/docx-patcher.ts` — export `patchDocxWithTrackChanges(docxBuffer: Buffer, corrections: IssueRecord[], opts: {author: string, date: string}): Promise<{output: Buffer, applied: number, failed: Array<{issueId: string, reason: string}>}>`. Implementation: (1) Load ZIP with jszip. (2) Read `word/document.xml` as string via `zip.file(...).async('string')`. (3) Parse XML string to DOM using linkedom's `parseHTML` with content-type `application/xml`. (4) Scan all `w:id` attribute values with regex `w:id="(\d+)"g`, compute `maxId`, initialize `nextId = maxId + 1`. (5) Build logical text index: walk all `<w:p>` elements in document order (including inside `<w:tc>` table cells); for each paragraph walk runs: skip entire `<w:del>` subtrees, include `<w:ins>` subtrees; collect `{el: runElement, offset: number}` per character. (6) For each correction (sort by articleId numerically): search `correction.englishExcerpt` in logical text string; if not found, record failure; if found, identify spanning run(s) and character ranges; split affected `w:r` elements (clone `w:rPr` to split segments); insert `<w:del w:id="N" w:author="..." w:date="..."><w:r><w:rPr>...</w:rPr><w:delText xml:space="preserve">...</w:delText></w:r></w:del>` followed by `<w:ins w:id="N+1" ...><w:r><w:rPr>...</w:rPr><w:t xml:space="preserve">...</w:t></w:r></w:ins>`; increment nextId by 2. (7) Serialize DOM back to XML string; replace `word/document.xml` in zip. (8) Return `zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'})` as output buffer plus counts. Never touch existing `<w:del>` or `<w:ins>` elements during step 6 traversal. (Depends on T004)
- [x] T019 [US2] Implement `extensions/legal-proofreader/src/tools/stage2-tool.ts` — export `createStage2Tool(api: OpenClawPluginApi): AnyAgentTool`. Tool name: `proofread_stage2`, label: "Legal Proofreader — Stage 2". TypeBox schema per `contracts/tool-schema.md`: `xlsx_report`, `source_docx`, `output_path?`, `author?`. Execute: (1) validate xlsx_report and source_docx exist; (2) call `readIssuesReport` to get Apply=Yes corrections; (3) if zero corrections, return early with no-op message and `correctionSkipped` count; (4) load DOCX buffer from source_docx; (5) call `patchDocxWithTrackChanges` with author defaulting to `"Legal Proofreader"`; (6) write output buffer to `output_path` (default: workspace dir + auto-generated filename); (7) return `jsonResult` with summary text and details `{correctedDocxPath, correctionsApplied, correctionsFailed, correctionSkipped, failures}`. (Depends on T017, T018)
- [x] T020 [US2] Update `extensions/legal-proofreader/index.ts` — import `createStage2Tool` from `./src/tools/stage2-tool.js` and call `api.registerTool(createStage2Tool(api), { optional: true })` inside the `register` function. (Depends on T019)
- [x] T021 [P] [US2] Write unit tests in `extensions/legal-proofreader/src/services/xlsx-reader.test.ts` — test: (a) rows with Apply?="Yes" included, Apply?="No" excluded, (b) case-insensitive match (YES, yes, Yes all pass), (c) rows with empty Issue ID skipped, (d) file not found throws with path in message, (e) missing "Issues" sheet throws; generate test XLSX files programmatically with ExcelJS
- [x] T022 [US2] Write unit tests in `extensions/legal-proofreader/src/services/docx-patcher.test.ts` — test using real minimal DOCX buffers built from XML strings and jszip: (a) simple correction in a single `<w:r>` — output contains `<w:del>` + `<w:ins>` pair; (b) correction spanning run boundary — preceding and following runs preserved, corrected range wrapped in del+ins; (c) document with pre-existing `<w:del>` + `<w:ins>` — existing elements not modified, new elements have higher w:id values; (d) correction text not found — recorded in failures array, no XML change; (e) all injected w:id values are unique (no collisions with existing); (f) Arabic RTL run with `<w:bidi/>` in `w:rPr` — split run carries `<w:bidi/>` in cloned rPr

**Checkpoint**: Both stages fully functional and independently testable.

---

## Phase 5: Polish and Cross-Cutting Concerns

**Purpose**: Quality gates, verification, and end-to-end validation.

- [x] T023 [P] Run `pnpm check` (oxfmt format check + oxlint) scoped to `extensions/legal-proofreader/src/` and fix all format and lint violations
- [x] T024 [P] Run `pnpm tsgo` on the extension source to verify TypeScript types compile clean; fix any type errors, especially around `AnyAgentTool`, TypeBox schemas, and pdfjs-dist `TextItem` types
- [x] T025 Validate end-to-end against `specs/001-legal-proofreader-agent/quickstart.md` — run both stages on a sample Arabic PDF + English DOCX; verify XLSX has RTL Arabic column, severity colors, and Apply? = "Yes"; verify corrected DOCX opens in a word processor with individually reviewable track changes

---

## Dependencies and Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
  - T003 and T004 can run in parallel after T001+T002
- **Foundational (Phase 2)**: Depends on T004 (types) — BLOCKS all user stories
  - T005 and T006 can run in parallel; T007 requires both T005 and T006
- **User Story 1 (Phase 3)**: Depends on Phase 2 completion (T005, T006, T007)
  - T008 and T009 can run in parallel immediately after T007
  - T010 requires T005+T006+T007+T008+T009
  - T011 requires T010
  - Unit tests T012–T016 can all run in parallel (once Phase 2 complete)
- **User Story 2 (Phase 4)**: Depends on Phase 2 completion (T004, T007)
  - T017 and T018 can run in parallel (different files, different services)
  - T019 requires T017+T018
  - T020 requires T019 (and T011 must already be done to not break index.ts)
  - Unit tests T021 and T022 can run in parallel
- **Polish (Phase 5)**: Depends on Phase 3+4 completion

### User Story Dependencies

- **US1 (Stage 1)**: Depends on Phase 2 only — independently implementable
- **US2 (Stage 2)**: Depends on Phase 2 only — independently implementable; reads US1's XLSX output at runtime but has no compile-time dependency on US1 code

### Parallel Opportunities Within Each Story

```text
# US1 — after T007 completes:
T008 xlsx-writer.ts      ─┐
T009 ai-reviewer.ts      ─┤→ T010 stage1-tool.ts → T011 index.ts
T012 pdf-extractor.test  ─┤
T013 docx-reader.test    ─┤ (all tests in parallel)
T014 article-aligner.test─┤
T015 xlsx-writer.test    ─┤
T016 ai-reviewer.test    ─┘

# US2 — after Phase 2 completes:
T017 xlsx-reader.ts   ─┐
T018 docx-patcher.ts  ─┴→ T019 stage2-tool.ts → T020 index.ts
T021 xlsx-reader.test ─┐
T022 docx-patcher.test─┘ (tests in parallel)
```

---

## Parallel Example: User Story 1

```text
# Launch after T007 (article-aligner) completes:

Agent A: T008 — Implement xlsx-writer.ts (ExcelJS, RTL cells, severity colors)
Agent B: T009 — Implement ai-reviewer.ts (batching, parallel AI calls, parser)
Agent C: T012 — Write pdf-extractor.test.ts
Agent D: T013 — Write docx-reader.test.ts
Agent E: T014 — Write article-aligner.test.ts
Agent F: T015 — Write xlsx-writer.test.ts
Agent G: T016 — Write ai-reviewer.test.ts

# Then sequentially:
T010 — stage1-tool.ts (needs T008 + T009)
T011 — index.ts registration (needs T010)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T004)
2. Complete Phase 2: Foundational (T005–T007) — **CRITICAL: blocks both stories**
3. Complete Phase 3: User Story 1 (T008–T016)
4. **STOP and VALIDATE**: Test Stage 1 independently — upload files, run `proofread_stage1`, verify XLSX
5. Ship MVP: Stage 1 alone delivers immediate value as a standalone QA tool

### Incremental Delivery

1. Complete Setup + Foundational → extraction and alignment infrastructure ready
2. Add User Story 1 → XLSX issues report → validate → **MVP delivery**
3. Add User Story 2 → track-change DOCX → validate → **Full workflow delivery**
4. Each stage adds value without breaking the other

### Single-Developer Sequence

```
T001 → T002 → T003+T004 (parallel)
     → T005+T006 (parallel) → T007
     → T008+T009 (parallel) → T010 → T011
     → T012–T016 (parallel, can do anytime after Phase 2)
     → T017+T018 (parallel) → T019 → T020
     → T021+T022 (parallel)
     → T023+T024 (parallel) → T025
```

---

## Notes

- `[P]` tasks operate on different files with no shared state — safe to run in parallel
- Each story (US1, US2) is independently completable and testable
- No test task requires another test task to pass first
- T018 (`docx-patcher.ts`) is the highest-complexity task — allocate proportionally more time
- T009 (`ai-reviewer.ts`) requires access to the OpenClaw configured AI provider for integration testing
- Arabic text handling: always use `.normalize('NFC')`, never pre-reverse or pre-shape; pass raw Unicode to ExcelJS and AI API
- DOCX track changes: `w:id` uniqueness is critical — never hardcode IDs; always scan existing document first
