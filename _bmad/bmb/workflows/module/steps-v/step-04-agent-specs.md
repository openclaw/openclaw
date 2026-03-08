---
name: "step-04-agent-specs"
description: "Validate agent specifications and built agents"

nextStepFile: "./step-05-workflow-specs.md"
agentSpecTemplate: "../data/agent-spec-template.md"
agentArchitectureFile: "../data/agent-architecture.md"
agentValidationWorkflow: "{project-root}/_bmad/bmb/workflows/agent/steps-v/step-01-validate.md"
validationReportOutput: "{validation_report_output}"
targetPath: "{validation_target_path}"
---

# Step 4: Agent Specs Validation

## STEP GOAL:

Validate agent specifications and/or built agents, distinguishing between placeholder specs and fully implemented agents.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Quality Assurance** — dual-mode checking
- ✅ Specs are expected, built agents are great
- ✅ Track status of each agent

---

## MANDATORY SEQUENCE

### 1. Load Agent Files

Find all agent files in `{targetPath}/agents/`:

- `.spec.md` files (placeholder specs)
- `.agent.yaml` files (built agents)

### 2. Categorize Agents

For each agent found, determine status:

**Built Agents (.agent.yaml):**

- Full implementation with complete persona, menu YAML
- Can be validated in-depth via agent validation workflow

**Spec Agents (.spec.md):**

- High-level placeholder/blueprint
- Awaiting creation via agent-builder workflow

Track counts:

- Total agents: {count}
- Built agents: {count}
- Spec agents: {count}

### 3. Validate Spec Agents (.spec.md)

For each spec agent, check:

**Required Sections:**

- [ ] Agent metadata (id, name, title, icon, module)
- [ ] Role defined
- [ ] Identity or communication style
- [ ] Menu triggers documented
- [ ] hasSidecar decision documented

**Menu Triggers:**

- [ ] At least one trigger per agent
- [ ] Trigger → workflow mapping clear
- [ ] No duplicate triggers (warn if found)

**hasSidecar Documentation:**

- [ ] Decision documented (true or false)
- [ ] Rationale if true (why memory needed)

**Placeholder Note:** These are specs awaiting agent-builder.

### 4. Validate Built Agents (.agent.yaml)

For each built agent, check:

**Frontmatter Completeness:**

- [ ] agent.metadata exists
- [ ] agent.persona exists
- [ ] agent.menu exists

**YAML Structure:**

- [ ] Valid YAML syntax
- [ ] Required fields present

**Status:** These are complete implementations and can be validated in detail via sub-process.

### 5. Record Results

Append to `{validationReportOutput}`:

```markdown
## Agent Specs Validation

**Status:** {PASS/FAIL/WARNINGS}

**Agent Summary:**

- Total Agents: {count}
- Built Agents: {count} {list}
- Spec Agents: {count} {list}

**Built Agents:**
{for each built agent}

- **{name}**: {status} - Ready for detailed validation via agent workflow

**Spec Agents:**
{for each spec agent}

- **{name}**: {status} - Placeholder awaiting agent-builder

**Issues Found:**
{list any issues}

**Recommendations:**
{if specs exist}

- Use `bmad:bmb:agents:agent-builder` to create {spec agent names}
- After building agents, re-run validation to verify compliance
  {endif}
```

### 6. Note Sub-Process Opportunity

**IF built agents exist:**

"**The following built agents can be validated in detail:**"

{list built agents}

"**After this validation completes, I can spawn sub-processes to run the agent validation workflow on each built agent for deeper compliance checking.**"

### 7. Auto-Proceed

"**✓ Agent specs check complete.**"

Proceeding to next validation...

Load `{nextStepFile}`

---

## Success Metrics

✅ All agent files checked
✅ Status tracked (spec vs built)
✅ hasSidecar decisions validated
✅ Recommendations for specs documented
✅ Sub-process opportunity noted
