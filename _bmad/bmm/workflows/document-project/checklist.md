# Document Project Workflow - Validation Checklist

## Scan Level and Resumability

- [ ] Scan level selection offered (quick/deep/exhaustive) for initial_scan and full_rescan modes
- [ ] Deep-dive mode automatically uses exhaustive scan (no choice given)
- [ ] Quick scan does NOT read source files (only patterns, configs, manifests)
- [ ] Deep scan reads files in critical directories per project type
- [ ] Exhaustive scan reads ALL source files (excluding node_modules, dist, build)
- [ ] State file (project-scan-report.json) created at workflow start
- [ ] State file updated after each step completion
- [ ] State file contains all required fields per schema
- [ ] Resumability prompt shown if state file exists and is <24 hours old
- [ ] Old state files (>24 hours) automatically archived
- [ ] Resume functionality loads previous state correctly
- [ ] Workflow can jump to correct step when resuming

## Write-as-you-go Architecture

- [ ] Each document written to disk IMMEDIATELY after generation
- [ ] Document validation performed right after writing (section-level)
- [ ] State file updated after each document is written
- [ ] Detailed findings purged from context after writing (only summaries kept)
- [ ] Context contains only high-level summaries (1-2 sentences per section)
- [ ] No accumulation of full project analysis in memory

## Batching Strategy (Deep/Exhaustive Scans)

- [ ] Batching applied for deep and exhaustive scan levels
- [ ] Batches organized by SUBFOLDER (not arbitrary file count)
- [ ] Large files (>5000 LOC) handled with appropriate judgment
- [ ] Each batch: read files, extract info, write output, validate, purge context
- [ ] Batch completion tracked in state file (batches_completed array)
- [ ] Batch summaries kept in context (1-2 sentences max)

## Project Detection and Classification

- [ ] Project type correctly identified and matches actual technology stack
- [ ] Multi-part vs single-part structure accurately detected
- [ ] All project parts identified if multi-part (no missing client/server/etc.)
- [ ] Documentation requirements loaded for each part type
- [ ] Architecture registry match is appropriate for detected stack

## Technology Stack Analysis

- [ ] All major technologies identified (framework, language, database, etc.)
- [ ] Versions captured where available
- [ ] Technology decision table is complete and accurate
- [ ] Dependencies and libraries documented
- [ ] Build tools and package managers identified

## Codebase Scanning Completeness

- [ ] All critical directories scanned based on project type
- [ ] API endpoints documented (if requires_api_scan = true)
- [ ] Data models captured (if requires_data_models = true)
- [ ] State management patterns identified (if requires_state_management = true)
- [ ] UI components inventoried (if requires_ui_components = true)
- [ ] Configuration files located and documented
- [ ] Authentication/security patterns identified
- [ ] Entry points correctly identified
- [ ] Integration points mapped (for multi-part projects)
- [ ] Test files and patterns documented

## Source Tree Analysis

- [ ] Complete directory tree generated with no major omissions
- [ ] Critical folders highlighted and described
- [ ] Entry points clearly marked
- [ ] Integration paths noted (for multi-part)
- [ ] Asset locations identified (if applicable)
- [ ] File organization patterns explained

## Architecture Documentation Quality

- [ ] Architecture document uses appropriate template from registry
- [ ] All template sections filled with relevant information (no placeholders)
- [ ] Technology stack section is comprehensive
- [ ] Architecture pattern clearly explained
- [ ] Data architecture documented (if applicable)
- [ ] API design documented (if applicable)
- [ ] Component structure explained (if applicable)
- [ ] Source tree included and annotated
- [ ] Testing strategy documented
- [ ] Deployment architecture captured (if config found)

## Development and Operations Documentation

- [ ] Prerequisites clearly listed
- [ ] Installation steps documented
- [ ] Environment setup instructions provided
- [ ] Local run commands specified
- [ ] Build process documented
- [ ] Test commands and approach explained
- [ ] Deployment process documented (if applicable)
- [ ] CI/CD pipeline details captured (if found)
- [ ] Contribution guidelines extracted (if found)

## Multi-Part Project Specific (if applicable)

- [ ] Each part documented separately
- [ ] Part-specific architecture files created (architecture-{part_id}.md)
- [ ] Part-specific component inventories created (if applicable)
- [ ] Part-specific development guides created
- [ ] Integration architecture document created
- [ ] Integration points clearly defined with type and details
- [ ] Data flow between parts explained
- [ ] project-parts.json metadata file created

## Index and Navigation

- [ ] index.md created as master entry point
- [ ] Project structure clearly summarized in index
- [ ] Quick reference section complete and accurate
- [ ] All generated docs linked from index
- [ ] All existing docs linked from index (if found)
- [ ] Getting started section provides clear next steps
- [ ] AI-assisted development guidance included
- [ ] Navigation structure matches project complexity (simple for single-part, detailed for multi-part)

## File Completeness

- [ ] index.md generated
- [ ] project-overview.md generated
- [ ] source-tree-analysis.md generated
- [ ] architecture.md (or per-part) generated
- [ ] component-inventory.md (or per-part) generated if UI components exist
- [ ] development-guide.md (or per-part) generated
- [ ] api-contracts.md (or per-part) generated if APIs documented
- [ ] data-models.md (or per-part) generated if data models found
- [ ] deployment-guide.md generated if deployment config found
- [ ] contribution-guide.md generated if guidelines found
- [ ] integration-architecture.md generated if multi-part
- [ ] project-parts.json generated if multi-part

## Content Quality

- [ ] Technical information is accurate and specific
- [ ] No generic placeholders or "TODO" items remain
- [ ] Examples and code snippets are relevant to actual project
- [ ] File paths and directory references are correct
- [ ] Technology names and versions are accurate
- [ ] Terminology is consistent across all documents
- [ ] Descriptions are clear and actionable

## Brownfield PRD Readiness

- [ ] Documentation provides enough context for AI to understand existing system
- [ ] Integration points are clear for planning new features
- [ ] Reusable components are identified for leveraging in new work
- [ ] Data models are documented for schema extension planning
- [ ] API contracts are documented for endpoint expansion
- [ ] Code conventions and patterns are captured for consistency
- [ ] Architecture constraints are clear for informed decision-making

## Output Validation

- [ ] All files saved to correct output folder
- [ ] File naming follows convention (no part suffix for single-part, with suffix for multi-part)
- [ ] No broken internal links between documents
- [ ] Markdown formatting is correct and renders properly
- [ ] JSON files are valid (project-parts.json if applicable)

## Final Validation

- [ ] User confirmed project classification is accurate
- [ ] User provided any additional context needed
- [ ] All requested areas of focus addressed
- [ ] Documentation is immediately usable for brownfield PRD workflow
- [ ] No critical information gaps identified

## Issues Found

### Critical Issues (must fix before completion)

-

### Minor Issues (can be addressed later)

-

### Missing Information (to note for user)

-

## Deep-Dive Mode Validation (if deep-dive was performed)

- [ ] Deep-dive target area correctly identified and scoped
- [ ] All files in target area read completely (no skipped files)
- [ ] File inventory includes all exports with complete signatures
- [ ] Dependencies mapped for all files
- [ ] Dependents identified (who imports each file)
- [ ] Code snippets included for key implementation details
- [ ] Patterns and design approaches documented
- [ ] State management strategy explained
- [ ] Side effects documented (API calls, DB queries, etc.)
- [ ] Error handling approaches captured
- [ ] Testing files and coverage documented
- [ ] TODOs and comments extracted
- [ ] Dependency graph created showing relationships
- [ ] Data flow traced through the scanned area
- [ ] Integration points with rest of codebase identified
- [ ] Related code and similar patterns found outside scanned area
- [ ] Reuse opportunities documented
- [ ] Implementation guidance provided
- [ ] Modification instructions clear
- [ ] Index.md updated with deep-dive link
- [ ] Deep-dive documentation is immediately useful for implementation

---

## State File Quality

- [ ] State file is valid JSON (no syntax errors)
- [ ] State file is optimized (no pretty-printing, minimal whitespace)
- [ ] State file contains all completed steps with timestamps
- [ ] State file outputs_generated list is accurate and complete
- [ ] State file resume_instructions are clear and actionable
- [ ] State file findings contain only high-level summaries (not detailed data)
- [ ] State file can be successfully loaded for resumption

## Completion Criteria

All items in the following sections must be checked:

- ✓ Scan Level and Resumability
- ✓ Write-as-you-go Architecture
- ✓ Batching Strategy (if deep/exhaustive scan)
- ✓ Project Detection and Classification
- ✓ Technology Stack Analysis
- ✓ Architecture Documentation Quality
- ✓ Index and Navigation
- ✓ File Completeness
- ✓ Brownfield PRD Readiness
- ✓ State File Quality
- ✓ Deep-Dive Mode Validation (if applicable)

The workflow is complete when:

1. All critical checklist items are satisfied
2. No critical issues remain
3. User has reviewed and approved the documentation
4. Generated docs are ready for use in brownfield PRD workflow
5. Deep-dive docs (if any) are comprehensive and implementation-ready
6. State file is valid and can enable resumption if interrupted
