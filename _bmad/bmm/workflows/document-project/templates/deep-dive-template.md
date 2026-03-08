# {{target_name}} - Deep Dive Documentation

**Generated:** {{date}}
**Scope:** {{target_path}}
**Files Analyzed:** {{file_count}}
**Lines of Code:** {{total_loc}}
**Workflow Mode:** Exhaustive Deep-Dive

## Overview

{{target_description}}

**Purpose:** {{target_purpose}}
**Key Responsibilities:** {{responsibilities}}
**Integration Points:** {{integration_summary}}

## Complete File Inventory

{{#each files_in_inventory}}

### {{file_path}}

**Purpose:** {{purpose}}
**Lines of Code:** {{loc}}
**File Type:** {{file_type}}

**What Future Contributors Must Know:** {{contributor_note}}

**Exports:**
{{#each exports}}

- `{{signature}}` - {{description}}
  {{/each}}

**Dependencies:**
{{#each imports}}

- `{{import_path}}` - {{reason}}
  {{/each}}

**Used By:**
{{#each dependents}}

- `{{dependent_path}}`
  {{/each}}

**Key Implementation Details:**

```{{language}}
{{key_code_snippet}}
```

{{implementation_notes}}

**Patterns Used:**
{{#each patterns}}

- {{pattern_name}}: {{pattern_description}}
  {{/each}}

**State Management:** {{state_approach}}

**Side Effects:**
{{#each side_effects}}

- {{effect_type}}: {{effect_description}}
  {{/each}}

**Error Handling:** {{error_handling_approach}}

**Testing:**

- Test File: {{test_file_path}}
- Coverage: {{coverage_percentage}}%
- Test Approach: {{test_approach}}

**Comments/TODOs:**
{{#each todos}}

- Line {{line_number}}: {{todo_text}}
  {{/each}}

---

{{/each}}

## Contributor Checklist

- **Risks & Gotchas:** {{risks_notes}}
- **Pre-change Verification Steps:** {{verification_steps}}
- **Suggested Tests Before PR:** {{suggested_tests}}

## Architecture & Design Patterns

### Code Organization

{{organization_approach}}

### Design Patterns

{{#each design_patterns}}

- **{{pattern_name}}**: {{usage_description}}
  {{/each}}

### State Management Strategy

{{state_management_details}}

### Error Handling Philosophy

{{error_handling_philosophy}}

### Testing Strategy

{{testing_strategy}}

## Data Flow

{{data_flow_diagram}}

### Data Entry Points

{{#each entry_points}}

- **{{entry_name}}**: {{entry_description}}
  {{/each}}

### Data Transformations

{{#each transformations}}

- **{{transformation_name}}**: {{transformation_description}}
  {{/each}}

### Data Exit Points

{{#each exit_points}}

- **{{exit_name}}**: {{exit_description}}
  {{/each}}

## Integration Points

### APIs Consumed

{{#each apis_consumed}}

- **{{api_endpoint}}**: {{api_description}}
  - Method: {{method}}
  - Authentication: {{auth_requirement}}
  - Response: {{response_schema}}
    {{/each}}

### APIs Exposed

{{#each apis_exposed}}

- **{{api_endpoint}}**: {{api_description}}
  - Method: {{method}}
  - Request: {{request_schema}}
  - Response: {{response_schema}}
    {{/each}}

### Shared State

{{#each shared_state}}

- **{{state_name}}**: {{state_description}}
  - Type: {{state_type}}
  - Accessed By: {{accessors}}
    {{/each}}

### Events

{{#each events}}

- **{{event_name}}**: {{event_description}}
  - Type: {{publish_or_subscribe}}
  - Payload: {{payload_schema}}
    {{/each}}

### Database Access

{{#each database_operations}}

- **{{table_name}}**: {{operation_type}}
  - Queries: {{query_patterns}}
  - Indexes Used: {{indexes}}
    {{/each}}

## Dependency Graph

{{dependency_graph_visualization}}

### Entry Points (Not Imported by Others in Scope)

{{#each entry_point_files}}

- {{file_path}}
  {{/each}}

### Leaf Nodes (Don't Import Others in Scope)

{{#each leaf_files}}

- {{file_path}}
  {{/each}}

### Circular Dependencies

{{#if has_circular_dependencies}}
⚠️ Circular dependencies detected:
{{#each circular_deps}}

- {{cycle_description}}
  {{/each}}
  {{else}}
  ✓ No circular dependencies detected
  {{/if}}

## Testing Analysis

### Test Coverage Summary

- **Statements:** {{statements_coverage}}%
- **Branches:** {{branches_coverage}}%
- **Functions:** {{functions_coverage}}%
- **Lines:** {{lines_coverage}}%

### Test Files

{{#each test_files}}

- **{{test_file_path}}**
  - Tests: {{test_count}}
  - Approach: {{test_approach}}
  - Mocking Strategy: {{mocking_strategy}}
    {{/each}}

### Test Utilities Available

{{#each test_utilities}}

- `{{utility_name}}`: {{utility_description}}
  {{/each}}

### Testing Gaps

{{#each testing_gaps}}

- {{gap_description}}
  {{/each}}

## Related Code & Reuse Opportunities

### Similar Features Elsewhere

{{#each similar_features}}

- **{{feature_name}}** (`{{feature_path}}`)
  - Similarity: {{similarity_description}}
  - Can Reference For: {{reference_use_case}}
    {{/each}}

### Reusable Utilities Available

{{#each reusable_utilities}}

- **{{utility_name}}** (`{{utility_path}}`)
  - Purpose: {{utility_purpose}}
  - How to Use: {{usage_example}}
    {{/each}}

### Patterns to Follow

{{#each patterns_to_follow}}

- **{{pattern_name}}**: Reference `{{reference_file}}` for implementation
  {{/each}}

## Implementation Notes

### Code Quality Observations

{{#each quality_observations}}

- {{observation}}
  {{/each}}

### TODOs and Future Work

{{#each all_todos}}

- **{{file_path}}:{{line_number}}**: {{todo_text}}
  {{/each}}

### Known Issues

{{#each known_issues}}

- {{issue_description}}
  {{/each}}

### Optimization Opportunities

{{#each optimizations}}

- {{optimization_suggestion}}
  {{/each}}

### Technical Debt

{{#each tech_debt_items}}

- {{debt_description}}
  {{/each}}

## Modification Guidance

### To Add New Functionality

{{modification_guidance_add}}

### To Modify Existing Functionality

{{modification_guidance_modify}}

### To Remove/Deprecate

{{modification_guidance_remove}}

### Testing Checklist for Changes

{{#each testing_checklist_items}}

- [ ] {{checklist_item}}
      {{/each}}

---

_Generated by `document-project` workflow (deep-dive mode)_
_Base Documentation: docs/index.md_
_Scan Date: {{date}}_
_Analysis Mode: Exhaustive_
