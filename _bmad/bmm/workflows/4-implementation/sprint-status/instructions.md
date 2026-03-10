# Sprint Status - Multi-Mode Service

<critical>The workflow execution engine is governed by: {project-root}/_bmad/core/tasks/workflow.xml</critical>
<critical>You MUST have already loaded and processed: {project-root}/_bmad/bmm/workflows/4-implementation/sprint-status/workflow.yaml</critical>
<critical>Modes: interactive (default), validate, data</critical>
<critical>⚠️ ABSOLUTELY NO TIME ESTIMATES. Do NOT mention hours, days, weeks, or timelines.</critical>

<workflow>

<step n="0" goal="Determine execution mode">
  <action>Set mode = {{mode}} if provided by caller; otherwise mode = "interactive"</action>

  <check if="mode == data">
    <action>Jump to Step 20</action>
  </check>

  <check if="mode == validate">
    <action>Jump to Step 30</action>
  </check>

  <check if="mode == interactive">
    <action>Continue to Step 1</action>
  </check>
</step>

<step n="1" goal="Locate sprint status file">
  <action>Load {project_context} for project-wide patterns and conventions (if exists)</action>
  <action>Try {sprint_status_file}</action>
  <check if="file not found">
    <output>❌ sprint-status.yaml not found.
Run `/bmad:bmm:workflows:sprint-planning` to generate it, then rerun sprint-status.</output>
    <action>Exit workflow</action>
  </check>
  <action>Continue to Step 2</action>
</step>

<step n="2" goal="Read and parse sprint-status.yaml">
  <action>Read the FULL file: {sprint_status_file}</action>
  <action>Parse fields: generated, project, project_key, tracking_system, story_location</action>
  <action>Parse development_status map. Classify keys:</action>
  - Epics: keys starting with "epic-" (and not ending with "-retrospective")
  - Retrospectives: keys ending with "-retrospective"
  - Stories: everything else (e.g., 1-2-login-form)
  <action>Map legacy story status "drafted" → "ready-for-dev"</action>
  <action>Count story statuses: backlog, ready-for-dev, in-progress, review, done</action>
  <action>Map legacy epic status "contexted" → "in-progress"</action>
  <action>Count epic statuses: backlog, in-progress, done</action>
  <action>Count retrospective statuses: optional, done</action>

<action>Validate all statuses against known values:</action>

- Valid story statuses: backlog, ready-for-dev, in-progress, review, done, drafted (legacy)
- Valid epic statuses: backlog, in-progress, done, contexted (legacy)
- Valid retrospective statuses: optional, done

  <check if="any status is unrecognized">
    <output>
⚠️ **Unknown status detected:**
{{#each invalid_entries}}

- `{{key}}`: "{{status}}" (not recognized)
  {{/each}}

**Valid statuses:**

- Stories: backlog, ready-for-dev, in-progress, review, done
- Epics: backlog, in-progress, done
- Retrospectives: optional, done
  </output>
  <ask>How should these be corrected?
  {{#each invalid_entries}}
  {{@index}}. {{key}}: "{{status}}" → [select valid status]
  {{/each}}

Enter corrections (e.g., "1=in-progress, 2=backlog") or "skip" to continue without fixing:</ask>
<check if="user provided corrections">
<action>Update sprint-status.yaml with corrected values</action>
<action>Re-parse the file with corrected statuses</action>
</check>
</check>

<action>Detect risks:</action>

- IF any story has status "review": suggest `/bmad:bmm:workflows:code-review`
- IF any story has status "in-progress" AND no stories have status "ready-for-dev": recommend staying focused on active story
- IF all epics have status "backlog" AND no stories have status "ready-for-dev": prompt `/bmad:bmm:workflows:create-story`
- IF `generated` timestamp is more than 7 days old: warn "sprint-status.yaml may be stale"
- IF any story key doesn't match an epic pattern (e.g., story "5-1-..." but no "epic-5"): warn "orphaned story detected"
- IF any epic has status in-progress but has no associated stories: warn "in-progress epic has no stories"
  </step>

<step n="3" goal="Select next action recommendation">
  <action>Pick the next recommended workflow using priority:</action>
  <note>When selecting "first" story: sort by epic number, then story number (e.g., 1-1 before 1-2 before 2-1)</note>
  1. If any story status == in-progress → recommend `dev-story` for the first in-progress story
  2. Else if any story status == review → recommend `code-review` for the first review story
  3. Else if any story status == ready-for-dev → recommend `dev-story`
  4. Else if any story status == backlog → recommend `create-story`
  5. Else if any retrospective status == optional → recommend `retrospective`
  6. Else → All implementation items done; congratulate the user - you both did amazing work together!
  <action>Store selected recommendation as: next_story_id, next_workflow_id, next_agent (SM/DEV as appropriate)</action>
</step>

<step n="4" goal="Display summary">
  <output>
## 📊 Sprint Status

- Project: {{project}} ({{project_key}})
- Tracking: {{tracking_system}}
- Status file: {sprint_status_file}

**Stories:** backlog {{count_backlog}}, ready-for-dev {{count_ready}}, in-progress {{count_in_progress}}, review {{count_review}}, done {{count_done}}

**Epics:** backlog {{epic_backlog}}, in-progress {{epic_in_progress}}, done {{epic_done}}

**Next Recommendation:** /bmad:bmm:workflows:{{next_workflow_id}} ({{next_story_id}})

{{#if risks}}
**Risks:**
{{#each risks}}

- {{this}}
  {{/each}}
  {{/if}}

  </output>
  </step>

<step n="5" goal="Offer actions">
  <ask>Pick an option:
1) Run recommended workflow now
2) Show all stories grouped by status
3) Show raw sprint-status.yaml
4) Exit
Choice:</ask>

  <check if="choice == 1">
    <output>Run `/bmad:bmm:workflows:{{next_workflow_id}}`.
If the command targets a story, set `story_key={{next_story_id}}` when prompted.</output>
  </check>

  <check if="choice == 2">
    <output>
### Stories by Status
- In Progress: {{stories_in_progress}}
- Review: {{stories_in_review}}
- Ready for Dev: {{stories_ready_for_dev}}
- Backlog: {{stories_backlog}}
- Done: {{stories_done}}
    </output>
  </check>

  <check if="choice == 3">
    <action>Display the full contents of {sprint_status_file}</action>
  </check>

  <check if="choice == 4">
    <action>Exit workflow</action>
  </check>
</step>

<!-- ========================= -->
<!-- Data mode for other flows -->
<!-- ========================= -->

<step n="20" goal="Data mode output">
  <action>Load and parse {sprint_status_file} same as Step 2</action>
  <action>Compute recommendation same as Step 3</action>
  <template-output>next_workflow_id = {{next_workflow_id}}</template-output>
  <template-output>next_story_id = {{next_story_id}}</template-output>
  <template-output>count_backlog = {{count_backlog}}</template-output>
  <template-output>count_ready = {{count_ready}}</template-output>
  <template-output>count_in_progress = {{count_in_progress}}</template-output>
  <template-output>count_review = {{count_review}}</template-output>
  <template-output>count_done = {{count_done}}</template-output>
  <template-output>epic_backlog = {{epic_backlog}}</template-output>
  <template-output>epic_in_progress = {{epic_in_progress}}</template-output>
  <template-output>epic_done = {{epic_done}}</template-output>
  <template-output>risks = {{risks}}</template-output>
  <action>Return to caller</action>
</step>

<!-- ========================= -->
<!-- Validate mode -->
<!-- ========================= -->

<step n="30" goal="Validate sprint-status file">
  <action>Check that {sprint_status_file} exists</action>
  <check if="missing">
    <template-output>is_valid = false</template-output>
    <template-output>error = "sprint-status.yaml missing"</template-output>
    <template-output>suggestion = "Run sprint-planning to create it"</template-output>
    <action>Return</action>
  </check>

<action>Read and parse {sprint_status_file}</action>

<action>Validate required metadata fields exist: generated, project, project_key, tracking_system, story_location</action>
<check if="any required field missing">
<template-output>is_valid = false</template-output>
<template-output>error = "Missing required field(s): {{missing_fields}}"</template-output>
<template-output>suggestion = "Re-run sprint-planning or add missing fields manually"</template-output>
<action>Return</action>
</check>

<action>Verify development_status section exists with at least one entry</action>
<check if="development_status missing or empty">
<template-output>is_valid = false</template-output>
<template-output>error = "development_status missing or empty"</template-output>
<template-output>suggestion = "Re-run sprint-planning or repair the file manually"</template-output>
<action>Return</action>
</check>

<action>Validate all status values against known valid statuses:</action>

- Stories: backlog, ready-for-dev, in-progress, review, done (legacy: drafted)
- Epics: backlog, in-progress, done (legacy: contexted)
- Retrospectives: optional, done
  <check if="any invalid status found">
  <template-output>is_valid = false</template-output>
  <template-output>error = "Invalid status values: {{invalid_entries}}"</template-output>
  <template-output>suggestion = "Fix invalid statuses in sprint-status.yaml"</template-output>
  <action>Return</action>
  </check>

<template-output>is_valid = true</template-output>
<template-output>message = "sprint-status.yaml valid: metadata complete, all statuses recognized"</template-output>
</step>

</workflow>
