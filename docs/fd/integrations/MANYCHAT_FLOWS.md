# MANYCHAT_FLOWS.md — Instagram DM Automation Specification

## 0) Purpose

Define deterministic DM entry funnels for:

- Full Digital lead capture
- CUTMV lead capture

ManyChat is the conversational intake layer.

---

## 1) Entry Triggers

Allowed triggers:

- Comment keyword on ad
- DM keyword
- Story reply

Each must include:

```
brand = fulldigital OR cutmv
```

---

## 2) Required Question Sequence

Minimal Full Digital intake:

```
Q1: What do you need help with?
Q2: Rough budget?
Q3: Timeline?
```

All answers stored in payload.

---

## 3) Webhook Payload Requirements

Must include:

```
instagram_handle
first_name
answers
brand
```

Send POST to:

```
/webhooks/manychat
```

Include header:

```
X-Webhook-Secret
```

---

## 4) Response Logic

System replies:

Booking link message.

Template:

```
"Got you — here's the booking link: {BOOKING_LINK}"
```

---

## 5) Safety Rules

- Never allow ManyChat to execute payments
- Never allow ManyChat to assign fulfillment
- ManyChat only collects information and routes

---

## 6) Retry Logic

If webhook fails:

Retry 3 times.

If still fails:

Send fallback message:

```
"Something glitched — please book here: {BOOKING_LINK}"
```
