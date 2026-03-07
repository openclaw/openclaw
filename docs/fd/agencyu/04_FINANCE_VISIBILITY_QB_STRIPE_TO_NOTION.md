# 04 — Finance Visibility (QuickBooks + Stripe → Notion)

## 1. Purpose

This document specifies how to expose financial visibility inside Notion while retaining QuickBooks as the accounting system of record and Stripe as the payments/subscription system.

Notion provides:
- Revenue and receivables overview
- Expense visibility
- Client profitability rollups
- MRR rollups and churn markers
- Invoice-level references with source IDs

## 2. System of Record

- QuickBooks = accounting truth (COA, reconciliation, tax reporting)
- Stripe = payments truth (subscription state, invoices, payment intents)
- Notion = management truth (dashboards and rollups only)

## 3. Notion Databases

### 3.1 Invoices
Tracks:
- client relation
- amount
- status (draft/sent/paid/overdue/cancelled)
- issue/due/paid dates
- stripe_id (if any)
- qb_id (if any)
- period label

### 3.2 Expenses
Tracks:
- amount/date/category
- client relation optional (blank = overhead)
- project relation optional
- receipt link/file
- recurring flag
- approval flag

## 4. Data Sources & Mapping

### 4.1 Stripe → Notion Invoices
Trigger: payment received or invoice finalized/paid.

Create/Update Notion invoice:
- Amount
- Paid date
- Payment method
- Stripe ID
- Client (resolved by Stripe customer mapping)

Also update Client.MRR when subscription is created/updated.

### 4.2 QuickBooks → Notion Invoices/Expenses
Trigger: periodic poll (e.g., 15–60 minutes) to capture reconciled truth.

Notion invoice pages must store qb_id; Notion is not used for posting journal entries or reconciliation.

## 5. Reconciliation Logic

- If Stripe and QuickBooks both create invoice representations, Notion invoice page should link both IDs.
- Canonical invoice record maintains:
  - stripe_invoice_id (nullable)
  - qb_invoice_id (nullable)
  - total_amount, paid_amount, balance
  - status mapping to Notion.Status

## 6. Financial Dashboard Requirements

Monthly widgets:
- Paid invoices sum (current month)
- Expenses sum (current month)
- Net profit (formula)
- Outstanding invoices (sent/overdue)
- Revenue by client

## 7. Finance Drift Healing

- Source-of-truth precedence:
  - Paid status and amount: QuickBooks wins once reconciled; Stripe wins in near-real-time until QB appears.
  - Category and COA mapping: QuickBooks wins.
  - Notes and "period label": Notion can own derived fields.

## 8. Auditability

All finance sync operations must write:
- raw payload storage reference (L0)
- sync_run_id
- time observed
- source IDs

This allows later debugging and trust calibration.
