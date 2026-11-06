---
summary: "Draft scope for globally sorting Android Threads by recent activity"
title: "Android Threads recency sorting"
---

# Android Threads recency sorting

Status: **Draft proposal — not implemented.**

Related: https://github.com/openclaw/openclaw/issues/194109

## User problem

The supplied Android screenshot shows a 3m-old conversation in Active followed
by 17h- and 1d-old conversations, while a 5m-old conversation appears farther
down in Channels. Group-first ordering separates the two recently used chats.
The sort selector is outside the screenshot; the reporter identifies the issue
as Threads sorting. Active is a section label, not evidence of an executing run.

## Desired behavior

Recency sorting should order conversations globally by the existing canonical
activity timestamp rather than sorting independently within each group.
For the reported example, the 3m and 5m entries should be adjacent, above the
17h and 1d entries. Preserve the documented behavior for pinned items.

Keep group membership as visible metadata and leave stored groups unchanged.
Offer an explicitly grouped view for group-first navigation instead of silently
ignoring groups in every mode. Make the selected ordering understandable.

## Implementation handoff

- Trace the current Threads sorting and section-building owners on the latest
  base, including search, filters, archived sessions, and child-session trees.
- Reuse the canonical activity timestamp and comparator; do not infer activity
  from titles, running-state badges, or UI-local timestamps.
- Separate global recency ordering from the optional grouped presentation.
- Preserve existing hidden-session filters, pins, unread/attention states,
  snoozing, gateway scoping, and tree relationships.
- Decide and document parent/child presentation without letting unrelated group
  sections place stale conversations between recently active top-level chats.
- Do not mutate stored group membership or invent a new persistence owner.

## Acceptance and proof checklist

- [ ] Recent-first orders non-pinned top-level chats globally across groups.
- [ ] A fixture with ages 3m, 5m, 17h, and 1d has that order in recency mode.
- [ ] Group-first mode still groups, with clear mode labels.
- [ ] Oldest-first reverses activity ordering consistently.
- [ ] Ties are deterministic using the existing comparator contract.
- [ ] Search, snoozed/archive filters, pins, and child trees retain their rules.
- [ ] Focused Android tests exercise the actual ordering/section boundary.
- [ ] Sanitized, inspected before/after screenshots are attached in chat and PR.

This is a starter handoff, not a claim of implemented or device-tested behavior.
Replace or remove this proposal when implementation and user docs are complete.
