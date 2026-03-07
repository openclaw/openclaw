# Notion Production Readiness Checklist (AgencyOS + OpenClaw)

## Purpose
This checklist defines the production readiness requirements for:
- AgencyOS-style Notion workspace (dashboards + databases + client portals)
- OpenClaw compliance verification (schema + templates + portals)
- Mirroring from Trello / GHL / Stripe / QuickBooks summary into Notion with drift healing

Notion is the operational cockpit and visibility plane. Trello remains the fulfillment source of truth.

---

## 0. Preconditions (Hard Requirements)

### 0.1 Notion Integration
- [ ] Dedicated Notion integration created: `OpenClaw`
- [ ] Integration shared to the AgencyOS root page
- [ ] Integration shared to all canonical databases listed in `template_manifest.yaml`
- [ ] Integration has no access outside the AgencyOS scope

### 0.2 System Settings Page
- [ ] `System Settings` page exists under `00_SYSTEM`
- [ ] Contains required keys:
  - template_version (string)
  - os_version (string)
  - write_lock (checkbox / boolean)
  - last_verified_at (datetime)
  - last_heal_at (datetime)
  - last_backup_at (datetime)
  - emergency_override_until (datetime, optional)
- [ ] OpenClaw has the Notion page_id for System Settings

### 0.3 Views Registry DB
- [ ] `Views Registry` database exists and is shared to OpenClaw
- [ ] All required views are represented as rows (see manifest strategy)

### 0.4 Schema Lock Discipline
- [ ] Humans do not edit database properties directly
- [ ] All schema changes go through:
  1) update `template_manifest.yaml`
  2) OpenClaw `drift_healer` simulate
  3) OpenClaw `drift_healer` apply (write_lock must allow)

---

## 1. Canonical Database Presence

- [ ] Clients DB exists (Master)
- [ ] CRM Pipeline DB exists
- [ ] Outcomes DB exists
- [ ] Projects DB exists
- [ ] Tasks DB exists
- [ ] Efforts DB exists
- [ ] Invoices DB exists
- [ ] Expenses DB exists
- [ ] Meetings DB exists
- [ ] Contacts DB exists
- [ ] Client Assets DB exists
- [ ] Agency Assets DB exists
- [ ] SOP Library DB exists
- [ ] Team Directory DB exists
- [ ] System Audit Log DB exists

Each must match:
- database name
- required properties (type + options)
- required relations (target DB)
- required rollups/formulas as specified in manifest

---

## 2. Client Portal Template Compliance

### 2.1 Client Portal Template Exists
- [ ] Client portal template exists inside Clients DB
- [ ] Template includes required sections:
  - Overview
  - Onboarding Checklist
  - Brand Assets
  - Active Projects
  - Deliverables
  - Meetings
  - Financial Summary

### 2.2 Client Portal Pre-Access Verification
Before granting client access to a portal page, OpenClaw must confirm:
- [ ] required sections exist
- [ ] required linked DB views exist OR are represented in Views Registry
- [ ] sensitive credential policy text is present (no passwords stored inline)

---

## 3. Mirroring & Drift Healing Readiness

### 3.1 Identity & Mapping Fields
- [ ] Notion Clients DB has fields for:
  - ghl_contact_id (text)
  - trello_board_id (text)
  - stripe_customer_id (text)
  - stripe_subscription_id (text, optional)
  - qb_customer_id (text, optional)
  - attribution_campaign_id (text)
  - attribution_combo_id (text)
- [ ] CRM Pipeline DB has fields for:
  - appointment_key (text)
  - setter_id (text)
  - calendar_source (select: ghl | calendly)
- [ ] OpenClaw SQLite has mapping tables:
  - ghl_contact_index
  - notion_bindings
  - trello_board_links
  - attribution_events + normalization tables

### 3.2 Drift Healing Mode Discipline
- [ ] Default mode = SAFE (simulate)
- [ ] Apply requires:
  - write_lock=false OR emergency override active
  - operator correlation_id
  - audit logging enabled
- [ ] Rate limit budget defined

---

## 4. Security Controls

- [ ] No credentials stored as plaintext in Notion
- [ ] Use password manager vault references only (links allowed)
- [ ] Notion integration token stored in Secret Manager / env vault only
- [ ] IP allowlisting for admin endpoints (if feasible)
- [ ] Admin endpoints require:
  - auth token
  - role check
  - audit log record per request

---

## 5. Backups & Restore

### 5.1 Backup Cadence
- [ ] Weekly Notion export (workspace or root scope)
- [ ] Daily OpenClaw DB snapshot
- [ ] Daily Trello metadata export (boards/lists/cards minimal)
- [ ] Monthly restore drill executed and logged

### 5.2 Restore Drill Definition
A drill is complete if:
- DB snapshot restored successfully
- Notion compliance passes after reconcile
- Trello<>GHL<>Notion mapping is consistent for 10 sampled clients

---

## 6. Go/No-Go Criteria
Production-ready if:
- [ ] All canonical DBs pass compliance verification
- [ ] Client portal template passes compliance verification
- [ ] Drift healer can simulate cleanly with no critical missing fields
- [ ] Audit log is working
- [ ] Backups jobs configured and tested
- [ ] Rate limiting + cooldown is active
