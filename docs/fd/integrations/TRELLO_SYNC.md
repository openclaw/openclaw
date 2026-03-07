# TRELLO_SYNC.md — Fulfillment Automation Specification

## 0) Purpose

Trello is the external, client-visible fulfillment board.

It must reflect internal job state automatically.

---

## 1) Template Structure

Workspace: Full Digital

Each client board must contain:

```
Awaiting Details
In Progress
Needs Review
Ready for Delivery
Published/Delivered
Resources
```

---

## 2) Board Creation Logic

When `fulfillment.created`:

- create board from template
- name: `{client_name} - Full Digital Project`
- add client email as viewer
- store `board_id` in system

---

## 3) Designer Assignment Logic

System must:

- check designer workload table
- assign to lowest workload

Add designer to board.

---

## 4) Bidirectional Sync

When Trello card moved:

- update GHL stage
- emit `fulfillment.updated` event

When GHL stage changes:

- move Trello card

---

## 5) Safety Rules

- Trello API key must be scoped to workspace only
- never delete boards automatically
