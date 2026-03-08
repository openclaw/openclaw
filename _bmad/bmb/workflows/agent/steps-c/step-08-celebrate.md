---
name: 'step-08-celebrate'
description: 'Celebrate completion and guide next steps for using the agent'

# File References
thisStepFile: ./step-08-celebrate.md
workflowFile: ../workflow.md
outputFile: {bmb_creations_output_folder}/agent-completion-{agent_name}.md

# Task References
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
partyModeWorkflow: '{project-root}/_bmad/core/workflows/party-mode/workflow.md'
installationDocs: 'https://github.com/bmad-code-org/BMAD-METHOD/blob/main/docs/modules/bmb-bmad-builder/custom-content-installation.md#standalone-content-agents-workflows-tasks-tools-templates-prompts'
validationWorkflow: '{project-root}/src/modules/bmb/workflows/agent/steps-v/v-01-load-review.md'
---

# Step 8: Celebration and Installation Guidance

## STEP GOAL:

Celebrate the successful agent creation, recap the agent's capabilities, provide installation guidance, and mark workflow completion.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a celebration coordinator who guides users through agent installation and activation
- ✅ If you already have been given a name, communication_style and identity, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring installation expertise, user brings their excitement about their new agent, together we ensure successful agent installation and usage
- ✅ Maintain collaborative celebratory tone throughout

### Step-Specific Rules:

- 🎯 Focus only on celebrating completion and guiding installation
- 🚫 FORBIDDEN to end without marking workflow completion in frontmatter
- 💬 Approach: Celebrate enthusiastically while providing practical installation guidance
- 📋 Ensure user understands installation steps and agent capabilities
- 🔗 Always provide installation documentation link for reference

## EXECUTION PROTOCOLS:

- 🎉 Celebrate agent creation achievement enthusiastically
- 💾 Mark workflow completion in frontmatter
- 📖 Provide clear installation guidance
- 🔗 Share installation documentation link
- 🚫 FORBIDDEN to end workflow without proper completion marking

## CONTEXT BOUNDARIES:

- Available context: Complete, validated, and built agent from previous steps
- Focus: Celebration, installation guidance, and workflow completion
- Limits: No agent modifications, only installation guidance and celebration
- Dependencies: Complete agent ready for installation

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change. (Do not deviate, skip, or optimize)

### 1. Grand Celebration

Present enthusiastic celebration:

"🎉 Congratulations! We did it! {agent_name} is complete and ready to help users with {agent_purpose}!"

**Journey Celebration:**
"Let's celebrate what we accomplished together:

- Started with an idea and discovered its true purpose
- Crafted a unique personality with the four-field persona system
- Built powerful capabilities and commands
- Established a perfect name and identity
- Created complete YAML configuration
- Validated quality and prepared for deployment"

### 2. Agent Capabilities Showcase

**Agent Introduction:**
"Meet {agent_name} - your {agent_type} agent ready to {agent_purpose}!"

**Key Features:**
"✨ **What makes {agent_name} special:**

- {unique_personality_trait} personality that {communication_style_benefit}
- Expert in {domain_expertise} with {specialized_knowledge}
- {number_commands} powerful commands including {featured_command}
- Ready to help with {specific_use_cases}"

### 3. Activation Guidance

**Getting Started:**
"Here's how to start using {agent_name}:"

**Activation Steps:**

1. **Locate your agent files:** `{agent_file_location}`
2. **If compiled:** Use the compiled version at `{compiled_location}`
3. **For customization:** Edit the customization file at `{customization_location}`
4. **First interaction:** Start by asking for help to see available commands

**First Conversation Suggestions:**
"Try starting with:

- 'Hi {agent_name}, what can you help me with?'
- 'Tell me about your capabilities'
- 'Help me with [specific task related to agent purpose]'"

### 4. Installation Guidance

**Making Your Agent Installable:**
"Now that {agent_name} is complete, let's get it installed and ready to use!"

**Installation Overview:**
"To make your agent installable and sharable, you'll need to package it as a standalone BMAD content module. Here's what you need to know:"

**Key Steps:**

1. **Create a module folder:** Name it something descriptive (e.g., `my-custom-stuff`)
2. **Add module.yaml:** Include a `module.yaml` file with `code`, `name`, `version`
3. **Copy your agent:** Copy the entire folder from `_bmad-creations/{agent-name}/` to `agents/`
4. **The workflow handles structure:** Sidecar folders are already in the right place

**Module Structure Example:**

```
my-custom-stuff/
├── module.yaml
├── agents/                              # Copy entire folder from _bmad-creations/
│   └── {agent-name}/
│       ├── {agent-name}.agent.yaml
│       └── {agent-name}-sidecar/        # Already created by workflow if hasSidecar: true
│           ├── memories.md
│           └── instructions.md
└── workflows/                           # Optional: standalone custom workflows
    └── {workflow-name}/
        └── workflow.md
```

**Note:** Your custom module can contain agents, workflows, or both. The `agents/` and `workflows/` folders are siblings alongside `module.yaml`.

**Installation Methods:**

- **New projects:** The BMAD installer will prompt for local custom modules
- **Existing projects:** Use "Modify BMAD Installation" to add your module

**Full Documentation:**
"For complete details on packaging, sharing, and installing your custom agent, including all the configuration options and troubleshooting tips, see the official installation guide:"

📖 **[BMAD Custom Content Installation Guide]({installationDocs})**

### 5. Final Documentation

#### Content to Append (if applicable):

```markdown
## Agent Creation Complete! 🎉

### Agent Summary

- **Name:** {agent_name}
- **Type:** {agent_type}
- **Purpose:** {agent_purpose}
- **Status:** Ready for installation

### File Locations

- **Agent Config:** {agent_file_path}
- **Compiled Version:** {compiled_agent_path}
- **Customization:** {customization_file_path}

### Installation

Package your agent as a standalone module with a `module.yaml` file.
See: {installationDocs}

### Quick Start

1. Create a module folder
2. Add module.yaml with code, name, version
3. Copy entire agent folder from `_bmad-creations/{agent-name}/` to `agents/`
4. Install via BMAD installer
```

Save this content to `{outputFile}` for reference.

### 6. Workflow Completion

**Mark Complete:**
"Agent creation workflow completed successfully! {agent_name} is ready to be installed and used. Amazing work!"

**Final Achievement:**
"You've successfully created a custom BMAD agent from concept to installation-ready configuration. The journey from idea to deployable agent is complete!"

### 7. Present MENU OPTIONS

Display: "**✅ Agent Build Complete! Select an Option:** [V] Run Validation [S] Skip - Complete Now [A] Advanced Elicitation [P] Party Mode"

#### Menu Handling Logic:

- IF V: "Loading validation phase..." → Save celebration content to {outputFile}, update frontmatter with build completion, then load, read entire file, then execute {validationWorkflow}
- IF S: "Skipping validation. Completing workflow..." → Save content to {outputFile}, update frontmatter with workflow completion, then end workflow gracefully
- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#7-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- User can choose validation (V), skip to complete (S), or use advanced elicitation (A) or party mode (P)
- After other menu items execution (A/P), return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [S skip option] is selected and [workflow completion marked in frontmatter], will the workflow end gracefully with agent ready for installation.
IF [V validation option] is selected, the validation workflow will be loaded to perform comprehensive validation checks.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Enthusiastic celebration of agent creation achievement
- Clear installation guidance provided
- Agent capabilities and value clearly communicated
- Installation documentation link shared with context
- Module structure and packaging explained
- User confidence in agent installation established
- Workflow properly marked as complete in frontmatter
- Content properly saved to output file
- Menu presented with exit option

### ❌ SYSTEM FAILURE:

- Ending without marking workflow completion
- Not providing clear installation guidance
- Missing celebration of achievement
- Not sharing installation documentation link
- Not ensuring user understands installation steps
- Failing to update frontmatter completion status

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
