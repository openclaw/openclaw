---
summary: "Markdown-first Spec Center plugin for auditable workflow previews"
read_when:
  - You want to import or preview Markdown-first specs
  - You are evaluating Spec Center, Daily Run Spec, or workflow-spec behavior
  - You are connecting repo-backed validation specs to OpenClaw
title: "Spec Center"
---

Spec Center is a bundled plugin for Markdown-first specs. It gives teams a
chat-first way to import a repo-backed spec, check the contract, and create a
run preview before wiring deeper execution.

P0 keeps the scope narrow: Spec Center is a plugin-owned surface, not a new core
workflow language. It uses existing OpenClaw primitives where available and
stores plugin state under the OpenClaw state directory.

## Current P0

- `/spec init` records team, owner, and approver metadata.
- `/spec import` imports a local repo-backed Markdown spec directory.
- legacy `daily.yaml`, `spec.yaml`, `daily.yml`, or `spec.yml` can be converted
  into generated Markdown artifact metadata for review.
- `/spec check` validates required artifacts, steps, dependencies, and missing
  approval gates for high-risk steps.
- `/spec preview` creates a run preview and, when a session key is available,
  creates a managed Task Flow record for observability.
- `/spec schedule`, `/spec pause`, and `/spec resume` store the Feishu-facing
  schedule state before real Cron binding is wired.
- `/spec report` summarizes the latest run, schedule, validation lanes, and
  pending spec optimization.
- `/spec optimize` creates a preview-only spec change proposal from a natural
  language instruction.
- `/spec approve` records the approval decision for a spec optimization
  proposal.

Remote Git import, real Cron execution, Feishu interactive cards, MR creation,
and the full Native Spec Runtime are follow-up slices.

## Markdown artifacts

Spec Center expects these files when they exist:

- `overview.md`
- `requirements.md`
- `design.md`
- `tasks.md`
- `coverage.md`
- `runbook.md`

`tasks.md` can use a compact table:

```markdown
| id                | type       | title                 | dependsOn         | outputs          |
| ----------------- | ---------- | --------------------- | ----------------- | ---------------- |
| validate_api      | tool_task  | Run API validation    | -                 | api_result       |
| diagnose_failures | agent_task | Diagnose failed lanes | validate_api      | diagnosis_report |
| approve_submit    | approval   | Approve submission    | diagnose_failures | -                |
```

## Commands

```bash
/spec init team=arkclaw owner=plugins-platform approvers=@alice,@bob
/spec import id=arkclaw-plugins-daily-run repo=/path/to/arkclaw_plugins_spec path=specs/arkclaw-plugins-daily targetRepo=openclaw/openclaw
/spec check arkclaw-plugins-daily-run
/spec preview arkclaw-plugins-daily-run
/spec schedule arkclaw-plugins-daily-run cron="0 9 * * 1-5" timezone=Asia/Shanghai reportTo=this_chat
/spec report arkclaw-plugins-daily-run
/spec optimize arkclaw-plugins-daily-run "add fixture validation lane"
/spec approve opt-1234567890
/spec pause arkclaw-plugins-daily-run
/spec resume arkclaw-plugins-daily-run
/spec status arkclaw-plugins-daily-run
```

Use the same text commands from Feishu. Feishu does not require native slash
command registration for this P0 flow.
