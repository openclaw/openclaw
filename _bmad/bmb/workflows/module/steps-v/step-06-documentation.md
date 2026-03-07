---
name: "step-06-documentation"
description: "Validate documentation (README.md, TODO.md, docs/)"

nextStepFile: "./step-07-installation.md"
validationReportOutput: "{validation_report_output}"
targetPath: "{validation_target_path}"
moduleBriefPath: "{module_brief_path}"
---

# Step 6: Documentation Validation

## STEP GOAL:

Validate module documentation completeness, including user-facing docs in docs/ folder.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Quality Assurance** — checking docs
- ✅ Documentation matters for usability
- ✅ User docs can be generated from placeholder plans

---

## MANDATORY SEQUENCE

### 1. Load Documentation Files

Check for:

- `{targetPath}/README.md` (module overview)
- `{targetPath}/TODO.md` (development roadmap)
- `{targetPath}/docs/` (user documentation folder)

### 2. Validate README.md

**Required Sections:**

- [ ] Module name and description
- [ ] Installation instructions
- [ ] Components section (agents, workflows)
- [ ] Usage examples or quick start
- [ ] Module structure
- [ ] Link to docs/ folder

**Quality Checks:**

- [ ] Clear description of what module does
- [ ] Installation command shown
- [ ] Agent/workflow lists complete
- [ ] References user documentation

### 3. Validate TODO.md

**Required Content:**

- [ ] Agent build checklist
- [ ] Workflow build checklist
- [ ] Testing section
- [ ] Next steps

### 4. Validate docs/ Folder

**For Custom Modules:**

- [ ] docs/ folder exists
- [ ] Contains user-facing documentation
- [ ] Documentation is clear and helpful

**Valid docs/ Contents (may include):**

- `getting-started.md` — Quick start guide
- `agents.md` — Agent documentation
- `workflows.md` — Workflow documentation
- `examples.md` — Usage examples
- `configuration.md` — Setup/configuration guide
- `troubleshooting.md` — Common issues and solutions

**Quality Check:**

- [ ] Even with placeholder agent/workflow specs, user docs should provide useful information
- [ ] Documentation references agents/workflows by name
- [ ] Clear what functionality exists vs what is planned

### 5. Generate User Docs Recommendation

**IF docs/ missing or incomplete:**

"**User documentation can be generated from module brief and agent/workflow specs.**"

"**Even with placeholder plans, you can create helpful user documentation that describes:**

- What each agent does and when to use it
- What workflows are available and their purpose
- How to get started with the module
- Configuration options (from module.yaml)"

### 6. Record Results

Append to `{validationReportOutput}`:

```markdown
## Documentation Validation

**Status:** {PASS/FAIL/WARNINGS}

**Root Documentation:**

- **README.md:** {present/missing} - {status}
- **TODO.md:** {present/missing} - {status}

**User Documentation (docs/):**

- **docs/ folder:** {present/missing} - {status}
- **Documentation files:** {count} files found

**Docs Contents:**
{list files in docs/ folder}

**Issues Found:**
{list any issues}

**Recommendations:**
{if docs/ missing or incomplete}

- Generate user documentation from module brief and specs
- Create getting-started.md, agents.md, workflows.md
- User docs are valuable even with placeholder plans
  {endif}
```

### 7. Auto-Proceed

"**✓ Documentation check complete.**"

Proceeding to installation validation...

Load `{nextStepFile}`

---

## Success Metrics

✅ All documentation checked
✅ Required sections validated
✅ docs/ folder presence verified
✅ User documentation quality assessed
✅ Recommendations documented
