# OpenClaw Naming Conventions (Meta + Funnel Identity Contract)
# Version: 1
# Purpose: Enforce deterministic identity propagation across Meta, ManyChat, ClickFunnels, Stripe, GHL, Notion.

## 1) The Combo Identity Contract (Non-Negotiable)

Every experiment unit MUST have a stable `combo_id`.

The string `combo:<combo_id>` MUST appear in:
- Meta Campaign Name
- Meta Ad Set Name
- Meta Ad Name

This is the canonical anchor that allows OpenClaw to:
- Aggregate spend/CTR/CPM/frequency per combo from Meta Insights
- Join conversions/revenue per combo from the Attribution Ledger
- Run kill/scale/fatigue rules deterministically

If `combo:<combo_id>` is missing, the combo is treated as **unattributable** and must be excluded from automation.

---

## 2) Meta Naming Format (Required)

### 2.1 Campaign Name
Format: `{brand} | {objective} | {phase} | combo:{combo_id}`

Examples:
- `cutmv | sales | p1 | combo:8a19c2f10c6d4a55`
- `fulldigital | leads | p1 | combo:0b77a13d1c2f091e`

### 2.2 Ad Set Name
Format: `{audience_id} | {placement} | {geo} | combo:{combo_id}`

Examples:
- `aud_03 | ig_reels | US | combo:8a19c2f10c6d4a55`
- `aud_label_01 | ig_feed | US | combo:0b77a13d1c2f091e`

### 2.3 Ad Name
Format: `{creative_id} | {cta_id} | {dm_copy_id} | {offer_id} | combo:{combo_id}`

Examples:
- `cr_12 | cta_02 | dm_05 | offer_cutmv_pro | combo:8a19c2f10c6d4a55`
- `cr_07 | cta_04 | dm_02 | fd_offer_01_visual_era | combo:0b77a13d1c2f091e`

---

## 3) UTM Naming Format (Required)

OpenClaw must also set UTMs on destinations (landing/VSL/application/checkout):
- `utm_campaign` = `combo:{combo_id}`
- `utm_source` = `meta`
- `utm_medium` = `{placement}` (e.g., ig_reels, ig_feed)
- `utm_content` = `{creative_id}`
- `utm_term` = `{audience_id}`

If destination URLs cannot be modified, `combo:<combo_id>` MUST still exist in Meta names.

---

## 4) Funnel Event Identity Format (Required)

When OpenClaw writes events into the Attribution Ledger, each event MUST include:
- `combo_id`
- `brand`
- `stage`
- `chain_id`
- `source` system (meta/manychat/clickfunnels/stripe/ghl/trello/notion/qb)
- Raw IDs (where available): `ad_id`, `adset_id`, `campaign_id`, `visitor_id`, `ghl_contact_id`, `stripe_checkout_id`

---

## 5) Human Override Rules

Humans MUST NOT rename Meta campaigns/adsets/ads once OpenClaw creates them.
If a rename is required, do it via OpenClaw admin endpoint only.

---

## 6) Drift Healing Policy

If OpenClaw detects Meta entities missing `combo:<id>`:
- If `safe_mode=true`: report in warnings, do not mutate.
- If `safe_mode=false`: optionally rename to restore compliance (requires `write_unlock`).

---

## 7) Compliance Checks (Required)

The daily policy cycle MUST verify:
- % of spend attributable by combo_id >= 95%
- 0 active combos missing combo tag in Meta names
- Stripe paid events include combo_id in metadata OR are resolvable via chain_id mapping
