const fs = require("fs");
const j = JSON.parse(fs.readFileSync("/Users/vero/.openclaw/cron/jobs.json", "utf8"));
const job = j.jobs.find((x) => x.name === "morning-ops-report");
job.payload.message = `Generate the morning ops report. Read ~/.openclaw/cache/morning-report-brief.json — it contains pre-processed data with each employee's top 5 priority work orders, SLA flags, status counts, and relevant emails from the last 2 days.

SEND INDIVIDUAL DMs:
Post ONE Slack message directly to each employee's DM (target user IDs: Clay Neser, Daxton Dillon, Sam LeSueur, Kaleb Terranova, Junrey Sullano). Do NOT post to #corporate-operations.

FORMAT PER EMPLOYEE (keep it dense, brief, useful):

🦧 Good Morning [Name]!
📅 [Day], [Date from the brief]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 WORKLOAD SUMMARY
• Total Open: [Total count]
• Breakdown: [Assigned count] assigned | [Working count] working | [Waiting count] waiting

📋 ACTIONABLE WORK ORDERS
For each of their top 5 WOs from the brief:
• [[priority]] [title] — [project] — [status] [days]d
  → [first open checklist item or "needs attention"]

📧 EMAILS TO REVIEW
For each relevant email:
• [from] — [subject] ([date])

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Focus on unblocking Assigned items. Have a productive day! 🚀`;

fs.writeFileSync("/Users/vero/.openclaw/cron/jobs.json", JSON.stringify(j, null, 2));
