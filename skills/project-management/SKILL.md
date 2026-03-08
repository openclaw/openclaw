---
name: project-management
description: "Manage complex projects using an Executable Task Graph (V3). Optimized for AI-Human collaboration with visual dashboards, Mermaid support, milestone tracking, and deadline-driven execution. Use when planning or running projects that need explicit Owner/Deadline/Status/Done criteria, overdue highlighting, and weekly milestone checkpoints. Tools: project_init, project_add_task, project_get_ready_tasks, project_update_task, project_log_event, project_view."
metadata: { "openclaw": { "emoji": "📊", "requires": { "anyBins": ["node", "bun"] } } }
---

# Project Management (Executable Task Graph V3)

This skill provides a structured framework for project execution with a strong focus on **Human-Agent Collaboration** via visual projections.

## Storage Structure

- `.openclaw/projects/<id>/project.yaml`: Project metadata.
- `.openclaw/projects/<id>/tasks.yaml`: Task graph.
- `.openclaw/projects/<id>/events.jsonl`: Event log.
- `.openclaw/projects/<id>/PROJECT_STATUS.md`: Human-readable summary with Mermaid charts.
- `.openclaw/projects/<id>/dashboard.html`: Interactive visual dashboard.

---

## 🛠 Tools (Selected V3 Additions)

### 6. `project_view`

Generate a Mermaid.js flowchart code from `tasks.yaml`.

```bash
# Recommended implementation logic (node -e):
# 1. Read tasks.yaml.
# 2. Output "flowchart TD".
# 3. For each task, output "ID([Title])" or "ID{Title}".
# 4. For each dependency, output "DEP_ID --> ID".
# 5. Add status-based styling (ClassDef):
#    classDef done fill:#9f9,stroke:#333
#    classDef in_progress fill:#99f,stroke:#333
#    classDef blocked fill:#f99,stroke:#333
```

### 7. `project_sync_dashboard` (Internal or Side-effect)

Update `PROJECT_STATUS.md` and `dashboard.html` after any status change.

---

## 🎨 Human Interface Patterns

### 1. The Mermaid View

The agent should maintain a `PROJECT_STATUS.md` in the project directory that looks like this:

```markdown
# Project Status: [Title]

## Roadmap

\`\`\`mermaid
flowchart TD
T1([Task 1]) --> T2([Task 2])
class T1 done
class T2 in_progress
classDef done fill:#2ecc71,color:white
classDef in_progress fill:#3498db,color:white
\`\`\`

## Active Blockers

- **T3**: Blocked by missing API Key.
```

### 2. The Interactive Dashboard

A `dashboard.html` that uses a CDN for `mermaid.js` and `js-yaml` to render the project state directly in any browser.

---

## ⏱ Deadline-Driven Task Standard (Required)

For every task in project plans and dashboards, always include:

- **Owner**: single accountable person (`you`, `assistant`, or named owner)
- **Deadline**: specific date/time (avoid vague terms like "this week")
- **Status**: `todo` / `in_progress` / `done` / `blocked` / `overdue`
- **Done Criteria**: objective completion condition

Use weekly milestones by default:

- **W1**: foundation / setup complete
- **W2**: first deliverable shipped
- **W3+**: optimization and scale

Overdue rule:

- If deadline passes by 24h without completion, mark task as `overdue` and record:
  1. delay reason
  2. corrective action
  3. new deadline

## 🤖 Agent Workflow (Collaboration Optimized)

1. **Alignment**: Every time a major task is added or decomposed, run `project_view` and update and `PROJECT_STATUS.md` to keep the Human in the loop.
2. **Transparency**: In `project_log_event`, include a `human_note` field if the decision requires explanation.
3. **Loop**:
   - `project_get_ready_tasks` -> pick a task.
   - Run `project_update_task --status in_progress`.
   - Run `project_view` to refresh visuals.
   - Execute work.
   - Run `project_update_task --status done`.
   - Refresh visuals.
