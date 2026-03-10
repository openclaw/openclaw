# Step 7: Architecture Validation & Completion

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ ALWAYS treat this as collaborative discovery between architectural peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on validating architectural coherence and completeness
- ✅ VALIDATE all requirements are covered by architectural decisions
- ⚠️ ABSOLUTELY NO TIME ESTIMATES - AI development speed has fundamentally changed
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- ✅ Run comprehensive validation checks on the complete architecture
- ⚠️ Present A/P/C menu after generating validation results
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1, 2, 3, 4, 5, 6, 7]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## COLLABORATION MENUS (A/P/C):

This step will generate content and present choices:

- **A (Advanced Elicitation)**: Use discovery protocols to address complex architectural issues found during validation
- **P (Party Mode)**: Bring multiple perspectives to resolve validation concerns
- **C (Continue)**: Save the validation results and complete the architecture

## PROTOCOL INTEGRATION:

- When 'A' selected: Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml
- When 'P' selected: Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md
- PROTOCOLS always return to display this step's A/P/C menu after the A or P have completed
- User accepts/rejects protocol changes before proceeding

## CONTEXT BOUNDARIES:

- Complete architecture document with all sections is available
- All architectural decisions, patterns, and structure are defined
- Focus on validation, gap analysis, and coherence checking
- Prepare for handoff to implementation phase

## YOUR TASK:

Validate the complete architecture for coherence, completeness, and readiness to guide AI agents through consistent implementation.

## VALIDATION SEQUENCE:

### 1. Coherence Validation

Check that all architectural decisions work together:

**Decision Compatibility:**

- Do all technology choices work together without conflicts?
- Are all versions compatible with each other?
- Do patterns align with technology choices?
- Are there any contradictory decisions?

**Pattern Consistency:**

- Do implementation patterns support the architectural decisions?
- Are naming conventions consistent across all areas?
- Do structure patterns align with technology stack?
- Are communication patterns coherent?

**Structure Alignment:**

- Does the project structure support all architectural decisions?
- Are boundaries properly defined and respected?
- Does the structure enable the chosen patterns?
- Are integration points properly structured?

### 2. Requirements Coverage Validation

Verify all project requirements are architecturally supported:

**From Epics (if available):**

- Does every epic have architectural support?
- Are all user stories implementable with these decisions?
- Are cross-epic dependencies handled architecturally?
- Are there any gaps in epic coverage?

**From FR Categories (if no epics):**

- Does every functional requirement have architectural support?
- Are all FR categories fully covered by architectural decisions?
- Are cross-cutting FRs properly addressed?
- Are there any missing architectural capabilities?

**Non-Functional Requirements:**

- Are performance requirements addressed architecturally?
- Are security requirements fully covered?
- Are scalability considerations properly handled?
- Are compliance requirements architecturally supported?

### 3. Implementation Readiness Validation

Assess if AI agents can implement consistently:

**Decision Completeness:**

- Are all critical decisions documented with versions?
- Are implementation patterns comprehensive enough?
- Are consistency rules clear and enforceable?
- Are examples provided for all major patterns?

**Structure Completeness:**

- Is the project structure complete and specific?
- Are all files and directories defined?
- Are integration points clearly specified?
- Are component boundaries well-defined?

**Pattern Completeness:**

- Are all potential conflict points addressed?
- Are naming conventions comprehensive?
- Are communication patterns fully specified?
- Are process patterns (error handling, etc.) complete?

### 4. Gap Analysis

Identify and document any missing elements:

**Critical Gaps:**

- Missing architectural decisions that block implementation
- Incomplete patterns that could cause conflicts
- Missing structural elements needed for development
- Undefined integration points

**Important Gaps:**

- Areas that need more detailed specification
- Patterns that could be more comprehensive
- Documentation that would help implementation
- Examples that would clarify complex decisions

**Nice-to-Have Gaps:**

- Additional patterns that would be helpful
- Supplementary documentation
- Tooling recommendations
- Development workflow optimizations

### 5. Address Validation Issues

For any issues found, facilitate resolution:

**Critical Issues:**
"I found some issues that need to be addressed before implementation:

{{critical_issue_description}}

These could cause implementation problems. How would you like to resolve this?"

**Important Issues:**
"I noticed a few areas that could be improved:

{{important_issue_description}}

These aren't blocking, but addressing them would make implementation smoother. Should we work on these?"

**Minor Issues:**
"Here are some minor suggestions for improvement:

{{minor_issue_description}}

These are optional refinements. Would you like to address any of these?"

### 6. Generate Validation Content

Prepare the content to append to the document:

#### Content Structure:

```markdown
## Architecture Validation Results

### Coherence Validation ✅

**Decision Compatibility:**
{{assessment_of_how_all_decisions_work_together}}

**Pattern Consistency:**
{{verification_that_patterns_support_decisions}}

**Structure Alignment:**
{{confirmation_that_structure_supports_architecture}}

### Requirements Coverage Validation ✅

**Epic/Feature Coverage:**
{{verification_that_all_epics_or_features_are_supported}}

**Functional Requirements Coverage:**
{{confirmation_that_all_FRs_are_architecturally_supported}}

**Non-Functional Requirements Coverage:**
{{verification_that_NFRs_are_addressed}}

### Implementation Readiness Validation ✅

**Decision Completeness:**
{{assessment_of_decision_documentation_completeness}}

**Structure Completeness:**
{{evaluation_of_project_structure_completeness}}

**Pattern Completeness:**
{{verification_of_implementation_patterns_completeness}}

### Gap Analysis Results

{{gap_analysis_findings_with_priority_levels}}

### Validation Issues Addressed

{{description_of_any_issues_found_and_resolutions}}

### Architecture Completeness Checklist

**✅ Requirements Analysis**

- [x] Project context thoroughly analyzed
- [x] Scale and complexity assessed
- [x] Technical constraints identified
- [x] Cross-cutting concerns mapped

**✅ Architectural Decisions**

- [x] Critical decisions documented with versions
- [x] Technology stack fully specified
- [x] Integration patterns defined
- [x] Performance considerations addressed

**✅ Implementation Patterns**

- [x] Naming conventions established
- [x] Structure patterns defined
- [x] Communication patterns specified
- [x] Process patterns documented

**✅ Project Structure**

- [x] Complete directory structure defined
- [x] Component boundaries established
- [x] Integration points mapped
- [x] Requirements to structure mapping complete

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION

**Confidence Level:** {{high/medium/low}} based on validation results

**Key Strengths:**
{{list_of_architecture_strengths}}

**Areas for Future Enhancement:**
{{areas_that_could_be_improved_later}}

### Implementation Handoff

**AI Agent Guidelines:**

- Follow all architectural decisions exactly as documented
- Use implementation patterns consistently across all components
- Respect project structure and boundaries
- Refer to this document for all architectural questions

**First Implementation Priority:**
{{starter_template_command_or_first_architectural_step}}
```

### 7. Present Content and Menu

Show the validation results and present choices:

"I've completed a comprehensive validation of your architecture.

**Validation Summary:**

- ✅ Coherence: All decisions work together
- ✅ Coverage: All requirements are supported
- ✅ Readiness: AI agents can implement consistently

**Here's what I'll add to complete the architecture document:**

[Show the complete markdown content from step 6]

**What would you like to do?**
[A] Advanced Elicitation - Address any complex architectural concerns
[P] Party Mode - Review validation from different implementation perspectives
[C] Continue - Complete the architecture and finish workflow

### 8. Handle Menu Selection

#### If 'A' (Advanced Elicitation):

- Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml with validation issues
- Process enhanced solutions for complex concerns
- Ask user: "Accept these architectural improvements? (y/n)"
- If yes: Update content, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'P' (Party Mode):

- Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md with validation context
- Process collaborative insights on implementation readiness
- Ask user: "Accept these changes to the validation results? (y/n)"
- If yes: Update content, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'C' (Continue):

- Append the final content to `{planning_artifacts}/architecture.md`
- Update frontmatter: `stepsCompleted: [1, 2, 3, 4, 5, 6, 7]`
- Load `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-08-complete.md`

## APPEND TO DOCUMENT:

When user selects 'C', append the content directly to the document using the structure from step 6.

## SUCCESS METRICS:

✅ All architectural decisions validated for coherence
✅ Complete requirements coverage verified
✅ Implementation readiness confirmed
✅ All gaps identified and addressed
✅ Comprehensive validation checklist completed
✅ A/P/C menu presented and handled correctly
✅ Content properly appended to document when C selected

## FAILURE MODES:

❌ Skipping validation of decision compatibility
❌ Not verifying all requirements are architecturally supported
❌ Missing potential implementation conflicts
❌ Not addressing gaps found during validation
❌ Providing incomplete validation checklist
❌ Not presenting A/P/C menu after content generation

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## NEXT STEP:

After user selects 'C' and content is saved to document, load `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-08-complete.md` to complete the workflow and provide implementation guidance.

Remember: Do NOT proceed to step-08 until user explicitly selects 'C' from the A/P/C menu and content is saved!
