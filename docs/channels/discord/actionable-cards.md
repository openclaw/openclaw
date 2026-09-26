---
summary: "Contract every recurring producer must follow when it turns a Discord card into a decision, not just a message"
read_when:
  - Building a scheduled job or automation that asks for a decision via Discord components
  - Migrating a text-approval or reaction-based workflow to buttons
title: "Actionable card contract"
sidebarTitle: "Actionable card contract"
---

This page is the shared contract for any producer that turns a Discord components v2 card into a
decision surface: a button click that is supposed to mean something durable. It does not
introduce new mechanism — see [Discord components and approvals](/channels/discord/rich-messages)
for the `components` payload, TTL config, and how a click returns as an inbound message. This page
covers what a consumer must do around that mechanism so the card is a shortcut, never the record.

Three behaviours of the current implementation set the whole contract, and each is observable in
the Discord extension itself:

- a card with buttons sends from a scheduled turn exactly as from an interactive one, given an
  explicit `target`;
- a click arrives as an ordinary inbound turn, with the clicking user identified;
- `reusable: true` does not expire on first use, so the same card accepts a second, contradictory
  click and nothing in the mechanism reconciles the two.

## 1. Identifying the decided item

**Do not key the item mapping on the outbound `messageId`.** The click does not carry the card's
message id to the consumer: the inbound turn built in
`extensions/discord/src/monitor/agent-components.dispatch.ts` sets `MessageSid` to the Discord
_interaction_ id, and the card's own message id is passed as `replyToId`, which only feeds the
reply-reference planner for the outgoing answer. A consumer that recorded `messageId → item` when
it sent the card has no field to join on when the click comes back.

The item key must therefore travel in the click payload the consumer actually receives — the
inbound text. Two shapes carry it today:

- a **command action** (`action: { type: "command", command: "/verdict approve item-123" }`): the
  command string arrives verbatim as the inbound turn text, so the item key is in it;
- the **button label**, when the label is unique per item inside the producer's own namespace —
  with no command action, the inbound text is derived from the label.

A `callback` action is plugin data, not agent text: its `value` is dispatched to a registered
interactive handler, and when no plugin claims it the inbound text falls back to the label. Do not
rely on `value` reaching an agent turn. A component's `custom_id` is opaque in every case and is
never a place to smuggle meaning.

## 2. Where the decision is recorded

The button is never the record. Each consumer keeps its own durable store — a state file, a
verdict table, a row in whatever the producer already owns — and that store remains the single
source of truth. The click's only job is to produce
an inbound turn that writes to that store, exactly as a free-text approval would. A consumer that
has no durable store of its own is not ready to add a card: the card cannot become the store just
because it is more convenient to click than to type.

## 3. Repeated-click reconciliation

`reusable: true` does not expire on first use, and nothing in the mechanism reconciles two clicks
on the same card. A card that represents a one-shot decision (approve, reject, pick a verdict)
must ship `reusable: false`. When a consumer has a real reason to allow a second click on the same
card (correcting a mistake, changing a verdict before a deadline), it must treat that second click
as a **dated correction of the first**, written to the store with its own timestamp, never as a
second, independent approval. A consumer must pick one of these two paths explicitly; silently
accepting `reusable: true` with no reconciliation logic records two independent approvals for one
decision.

## 4. Readable fallback

A components v2 message ships with an empty `content`; any fallback text passed alongside
`components` is currently discarded, so a client that does not render v2 shows a blank message.
Because the card can never be the only record, every producer must keep its output legible without
it: send the decision-relevant text through the normal text body of the same turn, or as a
follow-up message, so a client (or a human) that only sees plain text still knows what was asked
and what the current state is. Do not rely on the card's own fallback field to carry that text
today.

## 5. Degradation after TTL

Component callbacks expire after `channels.discord.agentComponents.ttlMs` (default 30 minutes,
hard cap 24 hours). A card is a shortcut with validity inside that window, never the registry
itself. Once a callback expires:

- the button becomes inert; it must not be the only way left to record a decision;
- the consumer's normal text/command path (whatever existed before cards) must still be able to
  decide the same item after the button dies;
- a card whose callback expired should read as informational only, not as a broken control — it
  keeps showing what was asked, without implying a working button.

A consumer that needs a longer decision window before evaluating this degradation should ask for a
longer `ttlMs` rather than treat button death as an edge case to ignore.

## Non-goals of this contract

This contract does not change how a click is scored, verified, or authorized — `allowedUsers`,
`reusable`, and the click-to-inbound mapping already documented in
[Discord components and approvals](/channels/discord/rich-messages) apply unchanged. It also does
not cover the portable `presentation.buttons` path; that path is cross-channel and depends on
`inlineButtons` capabilities that Discord's native `components` payload does not need.
