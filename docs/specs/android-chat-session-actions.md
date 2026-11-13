---
summary: "Draft implementation scope for Android chat rename and session-reference actions"
title: "Android chat session actions"
---

# Android chat session actions

Status: **Draft proposal — not implemented.**

Related: https://github.com/openclaw/openclaw/issues/194108

## User problem

On Android, the reporter can rename a chat through the Threads context menu,
but cannot find Rename from the chat list or inside the open conversation.
The reporter also needs a mobile-only way to copy an unambiguous session
reference and paste it into another conversation.

The provided screenshot confirms Rename in Threads and no copy-reference item
in that menu. The other missing entry points are reporter observations, not an
independent reproduction. Do not publish unrelated conversation titles.

## Proposed experience

| Entry point | Rename | Copy session reference |
| --- | --- | --- |
| Chat-list item actions | Required | Required |
| Open chat menu | Required | Required |
| Existing Threads context menu | Preserve | Add |

Reuse the existing rename dialog and session mutation owner. Keep selection,
conversation history, composer draft, attachments, and navigation unchanged.
Report save failures without losing the proposed name.

Copy a canonical session key suitable for cross-session lookup, not just its
display title or a position in the list. Confirm the precise reference format
against the existing lookup contract during implementation. If the reference
includes a title or session ID, label the fields clearly. Do not copy gateway
credentials, auth tokens, or private connection URLs.

Clipboard actions should show confirmation and have accessible names. Distinct
sessions with identical titles must produce distinguishable references.

## Implementation handoff

- Identify the actual chat-list and open-chat action owners on the current base.
- Inspect the existing Threads rename path in SessionsScreen and reuse its
  gateway-scoped target and mutation behavior rather than introducing another
  rename implementation or persistence layer.
- Reuse existing clipboard confirmation behavior where appropriate.
- Bind actions to the selected row/session, not a subsequently focused chat.
- Revalidate gateway/session identity before applying an asynchronous rename;
  switching gateways or sessions must not rename a different conversation.
- Preserve existing permissions and disabled/offline behavior; report failures.
- Follow the app's localization and accessibility conventions.
- Update Android user documentation only once the behavior is implemented.

## Acceptance and proof checklist

- [ ] Rename works from the chat list and from inside the open chat.
- [ ] Existing Threads Rename still works.
- [ ] Copy reference works from all three entry points above.
- [ ] Paste a copied reference in another session and resolve the intended chat.
- [ ] Test identical titles and switching sessions/gateways during rename.
- [ ] Cancel and failed rename preserve the conversation and composer state.
- [ ] Run focused Android validation and record exact results in the PR.
- [ ] Attach sanitized, inspected before/after screenshots in chat and the PR.

This starter PR records the agreed scope for implementation; it is not a claim
that the requested controls exist or have passed device testing. Replace or
remove this proposal as the implementation and user documentation land.
