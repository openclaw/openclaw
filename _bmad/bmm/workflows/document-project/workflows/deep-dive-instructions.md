# Deep-Dive Documentation Instructions

<workflow>

<critical>This workflow performs exhaustive deep-dive documentation of specific areas</critical>
<critical>Called by: ../document-project/instructions.md router</critical>
<critical>Handles: deep_dive mode only</critical>

<step n="13" goal="Deep-dive documentation of specific area" if="workflow_mode == deep_dive">
<critical>Deep-dive mode requires literal full-file review. Sampling, guessing, or relying solely on tooling output is FORBIDDEN.</critical>
<action>Load existing project structure from index.md and project-parts.json (if exists)</action>
<action>Load source tree analysis to understand available areas</action>

<step n="13a" goal="Identify area for deep-dive">
  <action>Analyze existing documentation to suggest deep-dive options</action>

<ask>What area would you like to deep-dive into?

**Suggested Areas Based on Project Structure:**

{{#if has_api_routes}}

## API Routes ({{api_route_count}} endpoints found)

{{#each api_route_groups}}
{{group_index}}. {{group_name}} - {{endpoint_count}} endpoints in `{{path}}`
{{/each}}
{{/if}}

{{#if has_feature_modules}}

## Feature Modules ({{feature_count}} features)

{{#each feature_modules}}
{{module_index}}. {{module_name}} - {{file_count}} files in `{{path}}`
{{/each}}
{{/if}}

{{#if has_ui_components}}

### UI Component Areas

{{#each component_groups}}
{{group_index}}. {{group_name}} - {{component_count}} components in `{{path}}`
{{/each}}
{{/if}}

{{#if has_services}}

### Services/Business Logic

{{#each service_groups}}
{{service_index}}. {{service_name}} - `{{path}}`
{{/each}}
{{/if}}

**Or specify custom:**

- Folder path (e.g., "client/src/features/dashboard")
- File path (e.g., "server/src/api/users.ts")
- Feature name (e.g., "authentication system")

Enter your choice (number or custom path):
</ask>

<action>Parse user input to determine: - target_type: "folder" | "file" | "feature" | "api_group" | "component_group" - target_path: Absolute path to scan - target_name: Human-readable name for documentation - target_scope: List of all files to analyze
</action>

<action>Store as {{deep_dive_target}}</action>

<action>Display confirmation:
Target: {{target_name}}
Type: {{target_type}}
Path: {{target_path}}
Estimated files to analyze: {{estimated_file_count}}

This will read EVERY file in this area. Proceed? [y/n]
</action>

<action if="user confirms 'n'">Return to Step 13a (select different area)</action>
</step>

<step n="13b" goal="Comprehensive exhaustive scan of target area">
  <action>Set scan_mode = "exhaustive"</action>
  <action>Initialize file_inventory = []</action>
  <critical>You must read every line of every file in scope and capture a plain-language explanation (what the file does, side effects, why it matters) that future developer agents can act on. No shortcuts.</critical>

  <check if="target_type == folder">
    <action>Get complete recursive file list from {{target_path}}</action>
    <action>Filter out: node_modules/, .git/, dist/, build/, coverage/, *.min.js, *.map</action>
    <action>For EVERY remaining file in folder:
      - Read complete file contents (all lines)
      - Extract all exports (functions, classes, types, interfaces, constants)
      - Extract all imports (dependencies)
      - Identify purpose from comments and code structure
      - Write 1-2 sentences (minimum) in natural language describing behaviour, side effects, assumptions, and anything a developer must know before modifying the file
      - Extract function signatures with parameter types and return types
      - Note any TODOs, FIXMEs, or comments
      - Identify patterns (hooks, components, services, controllers, etc.)
      - Capture per-file contributor guidance: `contributor_note`, `risks`, `verification_steps`, `suggested_tests`
      - Store in file_inventory
    </action>
  </check>

  <check if="target_type == file">
    <action>Read complete file at {{target_path}}</action>
    <action>Extract all information as above</action>
    <action>Read all files it imports (follow import chain 1 level deep)</action>
    <action>Find all files that import this file (dependents via grep)</action>
    <action>Store all in file_inventory</action>
  </check>

  <check if="target_type == api_group">
    <action>Identify all route/controller files in API group</action>
    <action>Read all route handlers completely</action>
    <action>Read associated middleware, controllers, services</action>
    <action>Read data models and schemas used</action>
    <action>Extract complete request/response schemas</action>
    <action>Document authentication and authorization requirements</action>
    <action>Store all in file_inventory</action>
  </check>

  <check if="target_type == feature">
    <action>Search codebase for all files related to feature name</action>
    <action>Include: UI components, API endpoints, models, services, tests</action>
    <action>Read each file completely</action>
    <action>Store all in file_inventory</action>
  </check>

  <check if="target_type == component_group">
    <action>Get all component files in group</action>
    <action>Read each component completely</action>
    <action>Extract: Props interfaces, hooks used, child components, state management</action>
    <action>Store all in file_inventory</action>
  </check>

<action>For each file in file\*inventory, document: - **File Path:** Full path - **Purpose:** What this file does (1-2 sentences) - **Lines of Code:** Total LOC - **Exports:** Complete list with signatures

- Functions: `functionName(param: Type): ReturnType` - Description
  - Classes: `ClassName` - Description with key methods
  - Types/Interfaces: `TypeName` - Description
  - Constants: `CONSTANT_NAME: Type` - Description - **Imports/Dependencies:** What it uses and why - **Used By:** Files that import this (dependents) - **Key Implementation Details:** Important logic, algorithms, patterns - **State Management:** If applicable (Redux, Context, local state) - **Side Effects:** API calls, database queries, file I/O, external services - **Error Handling:** Try/catch blocks, error boundaries, validation - **Testing:** Associated test files and coverage - **Comments/TODOs:** Any inline documentation or planned work
    </action>

<template-output>comprehensive_file_inventory</template-output>
</step>

<step n="13c" goal="Analyze relationships and data flow">
  <action>Build dependency graph for scanned area:
    - Create graph with files as nodes
    - Add edges for import relationships
    - Identify circular dependencies if any
    - Find entry points (files not imported by others in scope)
    - Find leaf nodes (files that don't import others in scope)
  </action>

<action>Trace data flow through the system: - Follow function calls and data transformations - Track API calls and their responses - Document state updates and propagation - Map database queries and mutations
</action>

<action>Identify integration points: - External APIs consumed - Internal APIs/services called - Shared state accessed - Events published/subscribed - Database tables accessed
</action>

<template-output>dependency_graph</template-output>
<template-output>data_flow_analysis</template-output>
<template-output>integration_points</template-output>
</step>

<step n="13d" goal="Find related code and similar patterns">
  <action>Search codebase OUTSIDE scanned area for:
    - Similar file/folder naming patterns
    - Similar function signatures
    - Similar component structures
    - Similar API patterns
    - Reusable utilities that could be used
  </action>

<action>Identify code reuse opportunities: - Shared utilities available - Design patterns used elsewhere - Component libraries available - Helper functions that could apply
</action>

<action>Find reference implementations: - Similar features in other parts of codebase - Established patterns to follow - Testing approaches used elsewhere
</action>

<template-output>related_code_references</template-output>
<template-output>reuse_opportunities</template-output>
</step>

<step n="13e" goal="Generate comprehensive deep-dive documentation">
  <action>Create documentation filename: deep-dive-{{sanitized_target_name}}.md</action>
  <action>Aggregate contributor insights across files:
    - Combine unique risk/gotcha notes into {{risks_notes}}
    - Combine verification steps developers should run before changes into {{verification_steps}}
    - Combine recommended test commands into {{suggested_tests}}
  </action>

<action>Load complete deep-dive template from: {installed_path}/templates/deep-dive-template.md</action>
<action>Fill template with all collected data from steps 13b-13d</action>
<action>Write filled template to: {project_knowledge}/deep-dive-{{sanitized_target_name}}.md</action>
<action>Validate deep-dive document completeness</action>

<template-output>deep_dive_documentation</template-output>

<action>Update state file: - Add to deep_dive_targets array: {"target_name": "{{target_name}}", "target_path": "{{target_path}}", "files_analyzed": {{file_count}}, "output_file": "deep-dive-{{sanitized_target_name}}.md", "timestamp": "{{now}}"} - Add output to outputs_generated - Update last_updated timestamp
</action>
</step>

<step n="13f" goal="Update master index with deep-dive link">
  <action>Read existing index.md</action>

<action>Check if "Deep-Dive Documentation" section exists</action>

  <check if="section does not exist">
    <action>Add new section after "Generated Documentation":

## Deep-Dive Documentation

Detailed exhaustive analysis of specific areas:

    </action>

  </check>

<action>Add link to new deep-dive doc:

- [{{target_name}} Deep-Dive](./deep-dive-{{sanitized_target_name}}.md) - Comprehensive analysis of {{target_description}} ({{file_count}} files, {{total_loc}} LOC) - Generated {{date}}
  </action>

  <action>Update index metadata:
  Last Updated: {{date}}
  Deep-Dives: {{deep_dive_count}}
  </action>

  <action>Save updated index.md</action>

  <template-output>updated_index</template-output>
  </step>

<step n="13g" goal="Offer to continue or complete">
  <action>Display summary:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Deep-Dive Documentation Complete! ✓

**Generated:** {project_knowledge}/deep-dive-{{target_name}}.md
**Files Analyzed:** {{file_count}}
**Lines of Code Scanned:** {{total_loc}}
**Time Taken:** ~{{duration}}

**Documentation Includes:**

- Complete file inventory with all exports
- Dependency graph and data flow
- Integration points and API contracts
- Testing analysis and coverage
- Related code and reuse opportunities
- Implementation guidance

**Index Updated:** {project_knowledge}/index.md now includes link to this deep-dive

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
</action>

<ask>Would you like to:

1. **Deep-dive another area** - Analyze another feature/module/folder
2. **Finish** - Complete workflow

Your choice [1/2]:
</ask>

  <action if="user selects 1">
    <action>Clear current deep_dive_target</action>
    <action>Go to Step 13a (select new area)</action>
  </action>

  <action if="user selects 2">
    <action>Display final message:

All deep-dive documentation complete!

**Master Index:** {project_knowledge}/index.md
**Deep-Dives Generated:** {{deep_dive_count}}

These comprehensive docs are now ready for:

- Architecture review
- Implementation planning
- Code understanding
- Brownfield PRD creation

Thank you for using the document-project workflow!
</action>
<action>Exit workflow</action>
</action>
</step>
</step>

</workflow>
