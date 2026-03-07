# 03 — Trello Internal + Client Board Sync (Mirror into Notion)

## 1. Purpose

This document defines how Full Digital uses Trello as the execution layer while providing unified visibility in Notion.

The required capability is a Trello-like internal project board that:
- mirrors internal Trello board activity,
- aligns with all client-facing Trello boards,
- and exposes unified status in Notion.

## 2. Trello Board Types

### 2.1 Internal Operations Board (Primary)
Contains:
- internal initiatives
- operational tasks (process, hiring, tooling, marketing)
- internal deliverables

### 2.2 Client Delivery Boards (One per client)
Contains:
- client requests
- deliverables
- revision workflows
- approvals and delivery artifacts

These boards are already canonical for day-to-day execution.

## 3. Canonical Mapping Model

### 3.1 Entity Mapping

- Trello Board → Notion Client (for client boards) OR internal pseudo-client "Full Digital Internal"
- Trello List → Task.Status or Project.Status (depending on configuration)
- Trello Card → Task
- Trello Checklist Item → optional TaskSubItem (or Task.Note embedded)
- Trello Member → TeamMember
- Trello Label → Priority and/or TaskType taxonomy

### 3.2 Required Trello Fields
For each card:
- card_id
- board_id
- list_id
- name
- desc
- due
- members
- labels
- url
- attachments (optional)
- last_activity_date

## 4. Notion Representation

Tasks database holds the mirrored task ledger with:

- Source System = trello
- Trello Card ID
- Trello Board ID
- Trello URL
- Status derived from list mapping
- Client derived from board→client mapping
- Project derived from optional ruleset (label-based or prefix-based)

Projects database may optionally mirror Trello "epics":
- either Trello cards with label `EPIC`,
- or cards in a specific list (e.g., "Projects / Epics").

## 5. Sync Strategy

### 5.1 Ingestion
- Poll Trello boards on interval (e.g., 60–180 seconds) OR use webhooks where available.
- Convert to canonical Task entities.
- Upsert into internal DB.
- Mirror to Notion Tasks as pages (upsert by canonical_id).

### 5.2 Drift Healing
- If Notion changes a mirrored field that is marked "source-owned" (e.g., Trello status), revert it in Notion.
- If Trello changes, propagate to Notion.
- If both changed since last sync, apply conflict policy.

## 6. Conflict Policies (Default)

- Status: Trello wins
- Assignee: Trello wins unless Notion override flag is set
- Due date: Trello wins unless Notion override flag is set
- Notes: bidirectional merge allowed if append-only and attributed
- Priority: Trello label wins, but Notion may calculate derived priority

## 7. Required "Sync Control" Fields in Notion Tasks

- sync.locked (checkbox): if checked, OpenClaw does not overwrite Notion fields except system fields.
- sync.override_owner (select): notion / trello / system (default trello)
- sync.last_source_write_at (timestamp)
- sync.health (select): ok / warning / broken
- sync.error (text)

## 8. Unified Views

Notion "Project Command Center" must include:

- Tasks by Client (filtered by Client relation)
- Tasks by Assignee (grouped)
- Overdue tasks (computed)
- Client deliverables requiring approval (Status in review/revisions)

This produces the "Trello-like" management surface without requiring Notion to replace Trello for execution.
