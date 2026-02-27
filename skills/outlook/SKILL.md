---
name: outlook
description: Automate Outlook Web (outlook.office.com) via Chrome extension relay. Use when reading emails, forwarding, composing, searching mail, or checking inbox. NOT for calendar (use Teams/Outlook calendar view directly). Requires attached Chrome extension tab.
---

# Outlook Web Automation

## Prerequisites

- Chrome extension relay attached to a tab in Edge
- Profile: `chrome`
- User authenticated via Windows SSO (Edge handles Entra ID)

## Key Limitation

Outlook compose windows return **empty accessibility snapshots**. Use screenshot + JS evaluate for compose interactions.

## Reading Emails

### Inbox

```
navigate → https://outlook.office.com/mail/inbox?focused=true
snapshot (compact, maxChars=5000) → message list with refs
```

- Focused/Other tabs available
- Unread count visible in nav pane
- Message list items are `option` elements with sender, subject, preview, time

### Open Email

Click the message `option` ref → reading pane loads with:

- From/To/Subject/Date headers
- Attachments as `option` elements in `listbox "file attachments"`
- Message body in `document "Message body"`

## Composing / Forwarding

### Forward

1. Click Forward button ref from reading pane
2. **Compose window has no snapshot refs** — switch to JS + keyboard:

### Filling the To Field

```js
// Focus the To input (first input with class r12stul0)
evaluate: (document.querySelectorAll('input.r12stul0')[0].focus(), 'focused')

// Type address via keyboard press
press: c+h+i+t+o+r+a+g+a+@+g+m+a+i+l+.+c+o+m

// Confirm recipient
press: Enter
```

### Verify with Screenshot

Always screenshot before sending to confirm recipient + attachments.

### Send

```js
evaluate: (document.querySelector('button[aria-label*="Send"]').click(), "sent");
```

## New Email

```
navigate → https://outlook.office.com/mail/deeplink/compose
```

Then use same compose patterns above.

## Search

```
click search combobox ref → type query via press keys
```

## Gotchas

- **Timezone:** Outlook displays times in user's local timezone (Bucharest). Do NOT double-convert.
- **Evaluate syntax:** Only expressions allowed, no statements. Use comma operator `(expr1, expr2)` for multi-step.
- **External recipients:** Warning banner appears for non-Microsoft addresses — expected.
- **Stale refs:** After screenshot, refs from previous snapshot are invalid. Re-snapshot if needed (but compose returns empty).
- **Class selectors may change:** `r12stul0` is a generated class name. If it stops working, find To input via: `document.querySelectorAll('input[type="text"]')` and filter by proximity to "To" label.
