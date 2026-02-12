---
name: status
description: Report high-level workflow steps and task progress.
metadata: { "openclaw": { "emoji": "🚩", "requires": { "bins": ["node"] } } }
---

# Status Reporting

Use this tool to announce high-level steps in your workflow. This helps the user track your progress.

## Usage

When you start a significant logical step (like "Cleaning data", "Analyzing trends", "Generating report"), use `report_step`.

```bash
# Action must be 'TASK'
node skills/status/report.ts "TASK" "Brief Description" "Optional details"
```

Example:

```bash
node skills/status/report.ts "TASK" "Analyze revenue" "Merging Q1 and Q2 data files"
```
