---
name: tengyi-401-pdf-autonomous-trainer
description: Execute the controlled Tengyi 401 PDF autonomous training loop from OpenClaw without overwriting source PDFs.
user-invocable: true
metadata: { "openclaw": { "emoji": "📄", "criticality": "important" } }
---

# Tengyi 401 PDF Autonomous Trainer

Use this skill when OpenClaw needs to run the Tengyi 401 PDF self-training workflow.

## Quick start

- Verify the source PDF is immutable.
- Run `classify` before any all-field training.
- Use `autotrain --all-fields` to refresh the full 401 field pass/fail set.
- Use `autotrain --all-fields --repeat-until-clean --max-attempts 1` for the formal closed-loop run.
- Inspect `latest\autotrain_result.json`, `latest\training_trace.csv`, and `latest\manual_review_required.csv` after each run.

## Safety contract

- Never overwrite source PDFs.
- Run `preflight` before `candidate`.
- Treat every edit as `candidate` until a human approval file is provided.
- Do not auto-promote learned rules unless `approve` receives an explicit approval JSON.
- Do not edit image-only PDFs with content-stream redaction; image-only PDFs are visual references only.
- Screen out unsafe edit actions before editing: source overwrite, white-box overlay, image raster overlay, font substitution without extracted source font, bold/style changes, line-art redaction, fixed-text redaction, and auto-learning without human approval.

## Commands

```powershell
python "E:\騰易企業\openclaw_401_pdf_autonomous_trainer\scripts\openclaw_401_pdf_autonomous_trainer.py" preflight
python "E:\騰易企業\openclaw_401_pdf_autonomous_trainer\scripts\openclaw_401_pdf_autonomous_trainer.py" classify
python "E:\騰易企業\openclaw_401_pdf_autonomous_trainer\scripts\openclaw_401_pdf_autonomous_trainer.py" candidate --field 25 --new-value "31,626,063"
python "E:\騰易企業\openclaw_401_pdf_autonomous_trainer\scripts\openclaw_401_pdf_autonomous_trainer.py" train --limit 6
python "E:\騰易企業\openclaw_401_pdf_autonomous_trainer\scripts\openclaw_401_pdf_autonomous_trainer.py" train --all-fields
python "E:\騰易企業\openclaw_401_pdf_autonomous_trainer\scripts\openclaw_401_pdf_autonomous_trainer.py" autotrain --all-fields
python "E:\騰易企業\openclaw_401_pdf_autonomous_trainer\scripts\openclaw_401_pdf_autonomous_trainer.py" status
```

## Field classification

Use `classify` before all-field training. It reads every bbox-dictionary field and writes:

- `classification\all_field_classification.csv`
- `latest\all_field_classification.csv`

Supported field classes:

- `left_amount`
- `left_tax`
- `left_aux_amount`
- `cross_column_total`
- `purchase_amount`
- `purchase_tax`
- `right_tax_chain`
- `special_field`

## Autonomous training

Use `train` to run independent single-field training candidates across configured field classes. It writes aggregate pass/fail evidence and never writes learned rules.
Use `autotrain` for recurring runs. It runs training, appends history, and rebuilds the dashboard files for inspection.
Use `--all-fields` when the task is to verify the whole 401 editable-PDF field set, not just representative fields.

```powershell
python "E:\騰易企業\openclaw_401_pdf_autonomous_trainer\scripts\openclaw_401_pdf_autonomous_trainer.py" train
python "E:\騰易企業\openclaw_401_pdf_autonomous_trainer\scripts\openclaw_401_pdf_autonomous_trainer.py" autotrain --all-fields
python "E:\騰易企業\openclaw_401_pdf_autonomous_trainer\scripts\openclaw_401_pdf_autonomous_trainer.py" train --fields 1,2,9,10,21,22,25
```

## Operation gate

Every candidate edit must pass the operation gate:

- Required: copy source PDF, detect original span, extract source font, narrow text redaction, insert same font, render full page, extract after edit, write trace.
- Blocked: overwrite original, white-box cover, image-only cover, substitute font, bold/style change, delete line art, delete fixed text, auto-learn without explicit human approval.
- Failed gate rows go to `manual_review_required.csv` and must not be promoted.

## Approval gate

Only after the user confirms the full-page render:

```powershell
python "E:\騰易企業\openclaw_401_pdf_autonomous_trainer\scripts\openclaw_401_pdf_autonomous_trainer.py" approve --approval-file "E:\騰易企業\output\openclaw_401_autonomous_training\latest\human_approval.json"
```

## Output

The runner writes only under:

```text
E:\騰易企業\output\openclaw_401_autonomous_training
```

OpenClaw should inspect:

- `latest\candidate_trace.json`
- `latest\training_summary.json`
- `latest\autotrain_result.json`
- `latest\training_trace.csv`
- `latest\manual_review_required.csv`
- `latest\all_field_classification.csv`
- `dashboard\training_dashboard.md`
- `dashboard\training_dashboard.html`
- `latest\compare_before_candidate.png`
- `latest\approval_result.json` when approval is used
