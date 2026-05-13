---
name: openclaw-docs-audit
description: Audit OpenClaw docs migrations and rewrites for paragraph-level coverage, moved-content traceability, generated-doc ownership, and exact destination line ranges.
---

# OpenClaw Docs Audit

Use this skill when the user asks for a rewrite audit, migration audit,
paragraph-level audit, moved-section checklist, coverage check, or asks whether
docs content was lost during an OpenClaw docs refactor.

This skill composes with `openclaw-docs` and `openclaw-refactor-docs`. Use those
skills for page quality, refactor workflow, and verification standards; use this
skill for source-to-destination coverage accounting.

## Contract

Audit the pre-rewrite source in source order. Do not treat the current rewritten
file as the original source unless the user explicitly lists it as the source.

For every original content unit, map where equivalent information now lives. A
destination is valid only if it contains equivalent information, not just a
related topic.

Content units are contiguous Markdown blocks:

- frontmatter metadata block, when relevant
- heading
- paragraph
- list
- table
- code block
- admonition or MDX component block
- link block

Do not audit every frontmatter line as its own unit. Treat frontmatter as one
metadata row when metadata changed, moved, was removed, or affects navigation or
discoverability. If frontmatter is unchanged and irrelevant to the migration,
omit it from the audit.

Keep a list, table, or admonition together unless child items moved to different
destinations. If child items moved separately, split the unit and explain why.

## Inputs

Expected inputs:

- source page path or paths, such as `docs/tools/plugin.md`
- a pre-rewrite source ref, archive path, patch, or commit expression
- expected destination pages, if the user knows them
- output location, if the user wants a durable report

If the user provides a placeholder such as `<SOURCE_REF_OR_ARCHIVE>`, resolve it
from nearby context or existing spec/report notes before asking. If no
pre-rewrite source can be identified, inspect `git log -- <path>` and propose
the likely pre-rewrite ref. Ask only when multiple plausible refs would change
the audit.

## Source Handling

Use source refs explicitly:

```bash
git show <source-ref>:<path> | nl -ba | sed -n '<start>,<end>p'
```

When the source is an archive or copied file, preserve its path and line numbers
separately from current repo files.

Never cite current destination files as source lines. The `source:` field must
name the original page and line range from the pre-rewrite source.

## Destination Handling

Use current repo files for destination line ranges.

For generated docs:

- cite the generated page line range
- cite the generator line range when possible
- do not hand-edit generated output to create coverage

For external-only destinations, write:

```text
external source; no repo line
```

If content was removed:

- `generated-source`: destination is required
- `redundant`: destination is required
- `obsolete`, `unsupported`, `duplicate-linking`, or `nav-only`: destination may
  be empty and status should be `intentionally-removed`

## Unit Actions

Use these action values:

- `retained`: same information remains on the same page or same-scope section
- `paraphrase`: same information remains but wording or label changed
- `moved`: unit moved to a different page or section
- `split`: one unit now lives in multiple destinations
- `merged`: several source units collapsed into one destination
- `removed`: content intentionally removed

Use these reason values:

- `same-scope`
- `redundant`
- `verbose`
- `mis-categorized`
- `generated-source`
- `obsolete`
- `unsupported`
- `duplicate-linking`
- `nav-only`

Use these status values:

- `covered`
- `partially-covered`
- `missing`
- `intentionally-removed`
- `needs-source-check`

Mark `missing`, `partially-covered`, and `needs-source-check` directly in the
unit status. Do not hide gaps in notes.

## Audit Outputs

For durable audits, produce two report pages:

1. **General checklist**: a moved-section checklist for humans reviewing the
   migration shape. This should resemble
   `.mem/main/specs/9-plugin-docs-refactor/reports/plugin-docs-9.2-moved-section-checklist.md`.
   It summarizes each shortened source page, then lists removed or shortened
   headings with destination pages/anchors, destination lines, and verification
   state.
2. **Detailed checklist**: the paragraph-level audit. This is the unit-by-unit
   source-to-destination accounting described below.

If the user asks for a chat-only audit, include the level they requested. If
they do not specify, provide the general checklist in chat and offer the
detailed checklist only when it is short enough to be useful.

### General checklist format

Use this shape for the general checklist:

```markdown
## Summary

<Short explanation of what was audited and where the detailed checklist lives.>

## Findings

| Source page            | Coverage                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/tools/plugin.md` | Shortened into a Getting Started topic page; removed detail is linked to install, dependency, inventory, CLI, manifest, SDK, and troubleshooting pages. |

### docs/tools/plugin.md

| Removed or shortened heading | Destination page or anchor                                  | Destination line(s)                                                                                                     | Verified? |
| ---------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| `## Package entrypoints`     | `docs/plugins/dependency-resolution.md#package-entrypoints` | `docs/plugins/dependency-resolution.md:110`; managed/local checkout rule at `docs/plugins/dependency-resolution.md:121` | yes       |

## Evidence

- Source ref: `<source-ref>`.
- Detailed checklist: `<path-to-detailed-report>`.
- Generated pages checked: `<generated-page>` from `<generator>`.

## Follow-ups

None.
```

Keep the general checklist heading-level and reviewable. It is not a substitute
for paragraph-level coverage. Use it to answer "where did the old sections go?"
quickly.

### Detailed checklist format

Use one page section per audited source page.

```markdown
### docs/tools/plugin.md

| Source page            | Coverage                                             |
| ---------------------- | ---------------------------------------------------- |
| `docs/tools/plugin.md` | Paragraph-level audit of all original content units. |

| ID                  | Source                                                              | Summary | Action | Reason | Destination                                                              | Status | Notes |
| ------------------- | ------------------------------------------------------------------- | ------- | ------ | ------ | ------------------------------------------------------------------------ | ------ | ----- |
| P001: <short label> | `docs/tools/plugin.md:<start>-<end>` from `<SOURCE_REF_OR_ARCHIVE>` | ...     | ...    | ...    | `docs/plugins/manage-plugins.md:41-72`<br />`docs/cli/plugins.md:74-180` | ...    | ...   |

source_units=<n> audited_units=<n> gaps=<ids or none>
```

Use one audit table per page instead of one subsection per unit. Keep IDs stable
and source-order based: `P001`, `P002`, and so on. If the audit covers multiple
pages, restart numbering per page unless the user asks for one global sequence.

### Reusable JSON and viewer

For durable paragraph-level audits, use JSON as the reusable intermediate. The
same JSON can power a static HTML review UI and, when needed, regenerate a
normalized detailed Markdown table.

Use the bundled script from repo root:

```bash
node .agents/skills/openclaw-docs-audit/scripts/audit-report-viewer.mjs \
  --report .mem/main/specs/<spec-id>/reports/<detailed-report>.md \
  --out-dir .mem/main/specs/<spec-id>/report \
  --basename <short-audit-name> \
  --changed-pages docs/tools/plugin.md,docs/plugins/manage-plugins.md
```

This writes:

```text
.mem/main/specs/<spec-id>/report/<short-audit-name>-audit-data.json
.mem/main/specs/<spec-id>/report/<short-audit-name>-audit-viewer.html
```

The script reads the detailed checklist table, resolves source lines from the
report `source_ref`, resolves current destination and generator lines, writes the
JSON, and renders the static HTML from `./assets/audit-viewer.html`. Do not
hand-edit generated viewer HTML; patch the template or script, then rerun it.

Use `--changed-pages` when reviewing a PR-sized migration. The viewer selector
uses those pages as page views: source pages show original audit units, while
destination pages show only units that landed on the selected page.

The viewer has block and doc modes. Block mode lists audit rows as cards. Doc
mode renders the pre-rewrite source Markdown from `source_ref`; clicking a
mapped source block selects the audit unit and updates the destination preview.

For the parser, JSON, and static viewer flow, read `./flow.md`.

If JSON is the canonical source for a later edit, render from JSON instead:

```bash
node .agents/skills/openclaw-docs-audit/scripts/audit-report-viewer.mjs \
  --data .mem/main/specs/<spec-id>/report/<short-audit-name>-audit-data.json \
  --html-out .mem/main/specs/<spec-id>/report/<short-audit-name>-audit-viewer.html \
  --detailed-out .mem/main/specs/<spec-id>/reports/<detailed-report>.md
```

## Durable Reports

When the user asks to write the audit into OpenClaw memory/specs, prefer the
existing AGD/spec report slot and create two files:

```text
.mem/main/specs/<spec-id>/reports/<short-audit-name>-general.md
.mem/main/specs/<spec-id>/reports/<short-audit-name>-detailed.md
```

If a repo or spec already has an established naming convention, preserve it and
make the pair obvious, for example `plugin-docs-9.2-moved-section-checklist.md`
and `plugin-docs-9.2-paragraph-rewrite-audit.md`.

Use `ag-dir-v2` frontmatter for spec reports:

```yaml
---
title: <Title>
spec: <spec-id>
schema: ag-dir-v2
status: complete
last_refreshed: YYYY-MM-DD
last_refreshed_by: Codex
source_ref: <source-ref>
report_kind: general-checklist | detailed-checklist
---
```

If the user asks for a chat-only audit, do not create a file.

## Coverage Rules

- Audit every original content unit in source order.
- Include frontmatter only as a single metadata row when it changed, moved, was
  removed, or affects navigation or discoverability.
- Do not collapse a source unit just because the new docs are shorter.
- Before marking a unit `covered`, check every material claim in the source block
  against the cited destination range. For multi-claim units, enumerate the
  claims mentally: commands, flags, failure modes, timing, defaults, compatibility
  aliases, side effects, and rollback behavior all need equivalent coverage.
- Do not cite a broad related section as coverage when only one sentence or row
  is equivalent. Prefer the smallest exact destination range that proves the
  claim. If equivalent content exists elsewhere, cite that exact range instead.
- If the destination covers the general topic but loses a material subclaim,
  mark the row `partially-covered` and name the missing subclaim in Notes.
- Use `split` when one source unit maps to multiple destinations.
- Use `merged` when several original units share one surviving destination.
- Use `removed` only when the reason explains why the content no longer needs a
  destination, or when generated/redundant content has a cited surviving
  destination.
- Prefer exact smallest line ranges that contain the equivalent information.
- For destination tables, cite the full row range only when the whole table is
  needed to prove equivalence; otherwise cite the smallest relevant row range.
- For headings, cite the heading line plus any lines needed to prove the
  information is present.

## Gap Handling

For a pure audit request, do not patch docs just to make the report green unless
the user also asks to repair coverage.

If the current task is a migration implementation or the user asks to ensure no
content was lost, you may restore small, source-backed missing facts before
finalizing. When you do, mention that in the final report and cite the new
destination lines in the audit.

For every gap, record:

- source unit id
- missing or partial information
- closest current destination, if any
- source file or code area to check next, if source verification is needed

## Verification

After writing durable audit reports:

1. Verify destination line refs exist.
2. Run docs checks for any docs pages changed during the audit.
3. Run formatter/checks for both reports and touched docs.
4. Run `git diff --check`.

A simple destination-line verifier can be run from repo root:

```bash
node - <report-path> <<'NODE'
const fs = require("fs");
const report = process.argv[2];
const text = fs.readFileSync(report, "utf8");
const misses = [];
for (const [i, line] of text.split(/\n/).entries()) {
  if (line.startsWith("source_ref:")) continue;
  const re = /`([^`]+\.(?:md|mjs|json|json5|ts|tsx)):(\d+)(?:-(\d+))?`/g;
  let m;
  while ((m = re.exec(line))) {
    if (line.slice(m.index + m[0].length).startsWith(" from `<SOURCE_REF_OR_ARCHIVE>`")) {
      continue;
    }
    const file = m[1];
    const start = Number(m[2]);
    const end = Number(m[3] || m[2]);
    if (!fs.existsSync(file)) {
      misses.push(`${i + 1}: missing file ${file}`);
      continue;
    }
    const count = fs.readFileSync(file, "utf8").split(/\n/).length;
    if (start < 1 || end < start || end > count) {
      misses.push(`${i + 1}: bad range ${file}:${start}-${end} (lines=${count})`);
    }
  }
}
if (misses.length) {
  console.error(misses.join("\n"));
  process.exit(1);
}
console.log("line refs ok");
NODE
```

Use repo docs checks when relevant:

```bash
pnpm docs:list
node scripts/check-docs-mdx.mjs <docs-files>
node_modules/.bin/oxfmt --check --threads=1 <report-and-docs-files>
git diff --check
```

## Final Report

Report only the useful facts:

- where the general and detailed reports were written
- source ref used
- `source_units`, `audited_units`, and `gaps`
- any docs coverage restored during the audit
- verification commands and results

If gaps remain, lead with them.
