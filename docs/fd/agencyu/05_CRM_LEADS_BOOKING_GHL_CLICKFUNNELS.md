# 05 — CRM + Leads + Booking (GHL/ManyChat + Calendly + Notion)

## 1. Purpose

This document defines the unified lead lifecycle and how lead events are mirrored into Notion CRM Pipeline while retaining external CRMs (GHL and/or ManyChat-based DM qualification) as operational acquisition tools.

## 2. Lead Lifecycle (Canonical)

1. New Lead
2. Qualified
3. Booked
4. Called
5. Proposal Sent
6. Negotiating
7. Closed Won / Closed Lost

Notion CRM Pipeline is the management surface; source systems provide events.

## 3. Required Notion CRM Fields

- Lead Name (title)
- Pipeline Stage (status)
- Source (select)
- Campaign (text)
- Revenue Tier (select)
- Pain Point (select)
- Assigned Setter (person)
- IG Handle (url)
- Email (email)
- Phone (phone)
- Call Date (date)
- Call Notes (text)
- Deal Value (number)
- Follow-Up Date (date)
- Last Contacted (date)
- ManyChat Tags (multi-select)
- Objections (multi-select)
- Converted to Client (relation to Clients)
- Created (created time)

## 4. Ingestion Options

### 4.1 GHL → Notion
- Contacts create/update → Notion CRM upsert
- Opportunities stage changes → Notion PipelineStage update
- Appointments → Notion Meeting create/update + CRM stage "Booked"

### 4.2 ManyChat + Calendly + Zapier → Notion
- ManyChat qualification tags → Notion CRM create/update
- Calendly booking → Notion CRM stage "Booked" + create Meeting
- No-show → Notion stage "No-Show" or tracking field + trigger follow-up sequence externally

## 5. Conversion to Client

When lead stage becomes "Closed Won":
- Create Clients record from template
- Create client portal (Client Portal property)
- Seed Outcomes/Projects/Tasks for onboarding
- Create initial invoice or confirm Stripe subscription state
- Send Slack notification (ops + fulfillment)

## 6. Attribution Requirements

Each lead record must capture:
- Source channel (meta_ad / organic / referral / cold_outreach)
- Campaign string (utm_campaign or equivalent)
- Contact ID in the originating platform (ghl_contact_id, manychat_contact_id)

Attribution is essential for later ROI analysis.

## 7. Compliance

Before enabling CRM sync, the Notion template manifest validator must confirm:
- CRM Pipeline database exists
- required properties exist with correct types and select options
- required views exist (pipeline board, follow-up queue, campaign grouping)

See `06_NOTION_COMPLIANCE_AND_DRIFT_HEALING.md`.
