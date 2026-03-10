# Document Project Workflow Router

<critical>The workflow execution engine is governed by: {project-root}/_bmad/core/tasks/workflow.xml</critical>
<critical>You MUST have already loaded and processed: {project-root}/_bmad/bmm/workflows/document-project/workflow.yaml</critical>
<critical>Communicate all responses in {communication_language}</critical>

<workflow>

<critical>This router determines workflow mode and delegates to specialized sub-workflows</critical>

<step n="1" goal="Check for ability to resume and determine workflow mode">
<action>Check for existing state file at: {project_knowledge}/project-scan-report.json</action>

<check if="project-scan-report.json exists">
  <action>Read state file and extract: timestamps, mode, scan_level, current_step, completed_steps, project_classification</action>
  <action>Extract cached project_type_id(s) from state file if present</action>
  <action>Calculate age of state file (current time - last_updated)</action>

<ask>I found an in-progress workflow state from {{last_updated}}.

    **Current Progress:**

    - Mode: {{mode}}
    - Scan Level: {{scan_level}}
    - Completed Steps: {{completed_steps_count}}/{{total_steps}}
    - Last Step: {{current_step}}
    - Project Type(s): {{cached_project_types}}

    Would you like to:

    1. **Resume from where we left off** - Continue from step {{current_step}}
    2. **Start fresh** - Archive old state and begin new scan
    3. **Cancel** - Exit without changes

    Your choice [1/2/3]:
</ask>

  <check if="user selects 1">
    <action>Set resume_mode = true</action>
    <action>Set workflow_mode = {{mode}}</action>
    <action>Load findings summaries from state file</action>
    <action>Load cached project_type_id(s) from state file</action>

    <critical>CONDITIONAL CSV LOADING FOR RESUME:</critical>
    <action>For each cached project_type_id, load ONLY the corresponding row from: {documentation_requirements_csv}</action>
    <action>Skip loading project-types.csv and architecture_registry.csv (not needed on resume)</action>
    <action>Store loaded doc requirements for use in remaining steps</action>

    <action>Display: "Resuming {{workflow_mode}} from {{current_step}} with cached project type(s): {{cached_project_types}}"</action>

    <check if="workflow_mode == deep_dive">
      <action>Read fully and follow: {installed_path}/workflows/deep-dive-instructions.md with resume context</action>
    </check>

    <check if="workflow_mode == initial_scan OR workflow_mode == full_rescan">
      <action>Read fully and follow: {installed_path}/workflows/full-scan-instructions.md with resume context</action>
    </check>

  </check>

  <check if="user selects 2">
    <action>Create archive directory: {project_knowledge}/.archive/</action>
    <action>Move old state file to: {project_knowledge}/.archive/project-scan-report-{{timestamp}}.json</action>
    <action>Set resume_mode = false</action>
    <action>Continue to Step 0.5</action>
  </check>

  <check if="user selects 3">
    <action>Display: "Exiting workflow without changes."</action>
    <action>Exit workflow</action>
  </check>

  <check if="state file age >= 24 hours">
    <action>Display: "Found old state file (>24 hours). Starting fresh scan."</action>
    <action>Archive old state file to: {project_knowledge}/.archive/project-scan-report-{{timestamp}}.json</action>
    <action>Set resume_mode = false</action>
    <action>Continue to Step 0.5</action>
  </check>

</step>

<step n="3" goal="Check for existing documentation and determine workflow mode" if="resume_mode == false">
<action>Check if {project_knowledge}/index.md exists</action>

<check if="index.md exists">
  <action>Read existing index.md to extract metadata (date, project structure, parts count)</action>
  <action>Store as {{existing_doc_date}}, {{existing_structure}}</action>

<ask>I found existing documentation generated on {{existing_doc_date}}.

What would you like to do?

1. **Re-scan entire project** - Update all documentation with latest changes
2. **Deep-dive into specific area** - Generate detailed documentation for a particular feature/module/folder
3. **Cancel** - Keep existing documentation as-is

Your choice [1/2/3]:
</ask>

  <check if="user selects 1">
    <action>Set workflow_mode = "full_rescan"</action>
    <action>Display: "Starting full project rescan..."</action>
    <action>Read fully and follow: {installed_path}/workflows/full-scan-instructions.md</action>
    <action>After sub-workflow completes, continue to Step 4</action>
  </check>

  <check if="user selects 2">
    <action>Set workflow_mode = "deep_dive"</action>
    <action>Set scan_level = "exhaustive"</action>
    <action>Display: "Starting deep-dive documentation mode..."</action>
    <action>Read fully and follow: {installed_path}/workflows/deep-dive-instructions.md</action>
    <action>After sub-workflow completes, continue to Step 4</action>
  </check>

  <check if="user selects 3">
    <action>Display message: "Keeping existing documentation. Exiting workflow."</action>
    <action>Exit workflow</action>
  </check>
</check>

<check if="index.md does not exist">
  <action>Set workflow_mode = "initial_scan"</action>
  <action>Display: "No existing documentation found. Starting initial project scan..."</action>
  <action>Read fully and follow: {installed_path}/workflows/full-scan-instructions.md</action>
  <action>After sub-workflow completes, continue to Step 4</action>
</check>

</step>

</workflow>
