# TEA Workflow Step Files

This folder contains the Test Architect (TEA) workflows converted to step-file architecture for strict LLM compliance. Each workflow is tri-modal (create, edit, validate) and uses small, ordered step files instead of a single monolithic instruction file.

## Why Step Files

- Enforces sequential execution and prevents improvisation
- Keeps context small and focused per step
- Makes validation and edits deterministic

## Standard Layout (per workflow)

```
<workflow>/
├── workflow.md             # Mode routing (create / edit / validate)
├── workflow-plan.md        # Design reference for step order and intent
├── workflow.yaml           # Installer metadata
├── instructions.md         # Short entrypoint / summary
├── checklist.md            # Validation criteria for outputs
├── steps-c/                # Create mode steps
├── steps-e/                # Edit mode steps
├── steps-v/                # Validate mode steps
├── templates/              # Output templates (if applicable)
└── validation-report-*.md  # Validator outputs (latest run)
```

## Modes

- **Create (steps-c/):** Primary execution flow to generate outputs
- **Edit (steps-e/):** Structured edits to existing outputs
- **Validate (steps-v/):** Checklist-based validation of outputs

## Execution Rules (Summary)

- Load **one step at a time**. Do not preload future steps.
- Follow the **MANDATORY SEQUENCE** exactly in each step.
- Do not skip steps, reorder, or improvise.
- If a step writes outputs, do so **before** loading the next step.

## Step Naming Conventions

- `step-01-*.md` is the init step (no menus unless explicitly required).
- `step-01b-*.md` is a continuation/resume step if the workflow is continuable.
- `step-0X-*.md` are sequential create-mode steps.
- `steps-v/step-01-validate.md` is the validate mode entrypoint.
- `steps-e/step-01-assess.md` is the edit mode entrypoint.

## Validation

- Each workflow has a latest `validation-report-*.md` in its folder.
- Validation uses the BMad Builder workflow validator (workflow-builder).
- The goal is 100% compliance with no warnings.

## References

- Step-file architecture: `docs/explanation/step-file-architecture.md`
- Subagent patterns: `docs/explanation/subagent-architecture.md`

## TEA Workflows

- test-design
- automate
- atdd
- test-review
- trace
- framework
- ci
- nfr-assess

## Notes

- `workflow.md` is the canonical entrypoint. `instructions.md` is a short summary for quick context.
- Output files typically use `{test_artifacts}` or `{project-root}` variables.
- If a workflow produces multiple artifacts (e.g., system-level vs epic-level), the step file will specify which templates and output paths to use.
