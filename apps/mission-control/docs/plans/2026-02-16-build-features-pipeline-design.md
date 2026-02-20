# Build Features Pipeline — Design

## Goal

When a user presses "Build" on a Learning Hub lesson, an agent improves Mission Control (new feature or code improvement), and the result appears in a "Feature Builds" list showing all builds with their status.

## Approach: Client-Side Build Tracker (Approach A)

Use existing localStorage state (`buildTaskByLesson`) plus task API status to power a new "Feature Builds" tab inside the Learning Hub.

## Changes

### 1. Build Prompt Rewrite

Current prompt is generic ("apply this lesson into a workspace improvement"). Replace with a Mission Control-scoped prompt that lets the agent decide whether to build something new or improve existing code.

New prompt:
- Scoped to Mission Control dashboard
- Agent decides: new feature vs improve existing code
- Delivery criteria: practical, testable, visible in running app
- Includes lesson title, source, summary, content excerpt

### 2. "Feature Builds" Tab

Add a new filter option to the Learning Hub filter bar alongside All / Elite / Saved / To Build.

When selected, shows all lessons with a build task, displaying:
- Lesson title
- Status badge: Building (amber) / In Review (blue) / Done (green) / Failed (red)
- Agent name
- Relative timestamp
- "Open Task" button

Data source: `buildTaskByLesson` localStorage map matched against task list from parent component (already available via `useTasks` hook).

### 3. Files to Modify

| File | Change |
|------|--------|
| `src/components/views/learning-hub.tsx` | Add "Feature Builds" filter, `FeatureBuildsList` component, rewrite build prompt |

No new files, API routes, or dependencies.

## Decisions

- **Build scope:** Agent decides (new feature vs improve existing)
- **List location:** Inside Learning Hub as a filter tab
- **Detail level:** Minimal (title, agent, date, status badge)
- **Build states shown:** All (in-progress, review, done)
