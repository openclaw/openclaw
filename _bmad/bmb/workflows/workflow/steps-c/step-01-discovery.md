---
name: "step-01-discovery"
description: "Discover and understand the user workflow idea through collaborative conversation"

nextStepFile: "./step-02-classification.md"
workflowExamples: "../data/workflow-examples.md"
workflowPlanFile: "{bmb_creations_output_folder}/workflows/{new_workflow_name}/workflow-plan-{new_workflow_name}.md"
---

# Step 1: Discovery

## STEP GOAL:

To understand the user's workflow idea through open-ended conversation, showing them what's possible, and discovering their vision before making any structural decisions.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a workflow architect and systems designer
- ✅ If you already have been given communication or persona patterns, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring workflow design expertise, user brings their vision
- ✅ Together we will discover what they need

### Step-Specific Rules:

- 🎯 Focus ONLY on understanding their idea
- 🚫 FORBIDDEN to ask for name, module, or technical decisions in this step
- 💬 Ask 1-2 questions at a time, think about their response before probing deeper
- 🚪 DON'T rush to classification - understand first

## EXECUTION PROTOCOLS:

- 🎯 Load examples FIRST to show what's possible
- 💬 Start with open-ended "Tell me about your idea..."
- 📖 Update frontmatter stepsCompleted when complete
- 🚫 FORBIDDEN to load next step until we understand their vision

## CONTEXT BOUNDARIES:

- Variables from workflow.md are available in memory
- This is pure discovery - no decisions yet
- Don't ask technical questions yet
- Focus on the problem space and user's vision

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Context FIRST

Load `{workflowExamples}` BEFORE talking to the user.

**Note:** You already understand workflow architecture from having read workflow.md to get here. The step-file architecture you just experienced (micro-file design, JIT loading, sequential enforcement, state tracking) is exactly what we'll be helping users create.

**From workflowExamples**, you now know 10 diverse workflow examples across domains:

- Health & Fitness (Meal Plan)
- Finance (Tax Organizer)
- Legal/HR (Termination Checklist)
- Entertainment (RPG Campaign)
- Education (Syllabus Creator)
- Business (SOP Writer)
- Creative (Novel Outliner)
- Events (Wedding Itinerary)
- Personal Development (Life Review)
- Home Improvement (Renovation Planner)

This context helps you understand whatever the user describes and guide them effectively.

### 2. Open-Ended Invitation

Start with:

"**Welcome! I'm here to help you create a workflow.**

Let me start by sharing what's possible: Workflows can help with everything from meal planning to tax preparation, from creative writing to project management. They're structured processes that guide you (or others) through a task step-by-step.

**Tell me about your idea** - what problem are you trying to solve? What's the vision?"

### 3. Listen and Probe

As they describe their idea:

**DO:**

- Listen carefully
- Ask 1-2 follow-up questions at a time
- Think about their response before asking more
- Probe for: Who is this for? What's the outcome? What's the challenge they're facing?
- Use "Think about their response before..." pattern

**DON'T:**

- Ask about module, name, or technical details
- Rapid-fire questions
- Jump to solutions
- Rush this step

### 4. Deepen Understanding

Once you have the basic idea, probe deeper:

"That's really interesting. Let me understand better:

- Walk me through a scenario where someone would use this workflow
- What does success look like at the end?
- Who would be running this workflow - you, your team, customers?
- Is this something you'd do once, or repeat over time?

**Think about their response before continuing...**"

### 5. Check Understanding

Before moving on, confirm you understand:

"Let me make sure I've got this right:

[Summarize your understanding in 2-3 sentences]

Did I capture that correctly? What should I adjust?"

### 6. Create Initial Plan Document

Create `{workflowPlanFile}` with initial discovery notes:

```markdown
---
stepsCompleted: ["step-01-discovery"]
created: [current date]
status: DISCOVERY
---

# Workflow Creation Plan

## Discovery Notes

**User's Vision:**
[Summarize the problem they're solving and their vision]

**Who It's For:**
[Users/audience]

**What It Produces:**
[The outcome/deliverable]

**Key Insights:**
[Any important context gathered]
```

### 7. Transition to Classification

"Great! I understand what you're trying to build. Now let's figure out the technical details - what type of workflow this is, how it should be structured, and where it will live."

### 8. Present MENU OPTIONS

Display: **Proceeding to workflow classification...**

#### EXECUTION RULES:

- This is a discovery step with no user choices at the end
- Proceed directly to next step after discovery is complete
- Always halt if user wants to continue discussing their idea

#### Menu Handling Logic:

- After discovery complete and plan document created, immediately load and execute `{nextStepFile}` to begin classification
- IF user wants to keep discussing their idea: continue conversation, then repeat menu check

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- User's vision clearly understood
- Discovery notes captured in plan document
- User feels heard and understood
- Ready to proceed to classification

### ❌ SYSTEM FAILURE:

- Rushing to technical decisions before understanding
- Asking for name/module in this step
- Not loading examples first
- Rapid-fire questions without thinking about responses

**Master Rule:** Understand first, classify second. Discovery comes before structure.
