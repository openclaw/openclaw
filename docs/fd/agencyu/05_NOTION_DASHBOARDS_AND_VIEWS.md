# Notion Dashboards & Views (AgencyOS-Style)

## 1. CEO Overview

- MRR total (rollup from Clients)
- New qualified leads (CRM Pipeline filtered)
- Calls booked next 7 days (Meetings)
- Active work orders (Work Orders, status != Published/Delivered)
- Delivery throughput (count of Published/Delivered this week)

AgencyOS research describes CEO overview as the daily "bird's-eye" dashboard and emphasizes rollups/formulas for MRR, churn, etc.

## 2. Sales Dashboard

Views:
- CRM Kanban by stage
- "Booked calls today"
- "No-show rescue queue"
- "Follow-up required"
- Campaign leaderboard (ROAS derived)

## 3. Fulfillment Dashboard

Views:
- Work Orders by status (Requests/In Progress/Needs Review/Approved/Published)
- "Stale in Needs Review > 3 days"
- "In Progress but dueComplete=true missing links"
- Release-date queue (Approved/Ready with release date upcoming)

## 4. Finance Dashboard

Views:
- Invoices paid last 30 days
- Profit estimate (revenue - expenses)
- Ad spend and ROAS (when spend integrated)
- Overdue invoices (QB derived)

## 5. Team & Capacity Dashboard

Views:
- Workload per team member (rollup)
- Utilization proxy (open cards / capacity)
- Hiring pipeline (optional)

## 6. SOP Library Dashboard

Views:
- SOPs by department
- Recently updated SOPs
- SOP compliance checklist (optional)
