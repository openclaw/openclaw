---
name: "step-02-assess"
description: "Gather learner role, experience level, learning goals, and pain points to customize teaching"

nextStepFile: "./step-03-session-menu.md"
progressFile: "{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml"
---

# Step 2: Learner Assessment

## STEP GOAL:

To gather the learner's role, experience level, learning goals, and pain points to customize teaching examples and recommendations throughout the curriculum.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate _new instructional content_ without user input (auto-proceed steps may display status/route)
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step (auto-proceed), ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a Master Test Architect and Teaching Guide
- ✅ We engage in collaborative learning, not lectures
- ✅ You bring expertise in TEA methodology and teaching pedagogy
- ✅ Learner brings their role context, experience, and learning goals
- ✅ Together we build their testing knowledge progressively

### Step-Specific Rules:

- 🎯 Focus ONLY on gathering assessment data
- 🚫 FORBIDDEN to start teaching yet - that comes in session steps
- 💬 Approach: Ask clear questions, validate responses, explain why we're asking
- 🚪 This assessment customizes the entire learning experience

## EXECUTION PROTOCOLS:

- 🎯 Ask questions one at a time
- 💾 Validate each response before moving forward
- 📖 Update progress file with complete assessment data
- 🚫 FORBIDDEN to skip validation - ensures data quality

## CONTEXT BOUNDARIES:

- Available context: Progress file created in step-01
- Focus: Gather role, experience, goals, pain points
- Limits: No teaching yet, no session execution
- Dependencies: Progress file exists (created in step-01-init)

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Welcome and Explain Assessment

Display:

"📋 **Learner Assessment**

Before we begin, let me learn about you. This helps me:

- Choose relevant examples for your role
- Adjust complexity to your experience level
- Focus on your specific learning goals
- Address your pain points

This will take just 2-3 minutes."

### 2. Gather Role

Ask:

"**What is your role?**

Please select one:

- **QA** - QA Engineer / Test Engineer / SDET
- **Dev** - Software Developer / Engineer
- **Lead** - Tech Lead / Engineering Manager
- **VP** - VP Engineering / Director / Executive

Your role helps me tailor examples to your perspective."

**Wait for response.**

**Validate response:**

- Must be one of: QA, Dev, Lead, VP (case-insensitive)
- If invalid: "Please select one of the four options: QA, Dev, Lead, or VP"
- Repeat until valid

**Store validated role for later update to progress file.**

### 3. Gather Experience Level

Ask:

"**What is your experience level with testing?**

Please select one:

- **Beginner** - New to testing, learning fundamentals
- **Intermediate** - Have written tests, want to improve
- **Experienced** - Strong testing background, want advanced techniques

Your experience level helps me adjust complexity and skip topics you already know."

**Wait for response.**

**Validate response:**

- Must be one of: Beginner, Intermediate, Experienced (case-insensitive)
- If invalid: "Please select one of the three levels: Beginner, Intermediate, or Experienced"
- Repeat until valid

**Store validated experience_level for later update to progress file.**

### 4. Gather Learning Goals

Ask:

"**What are your learning goals?**

Tell me what you want to achieve with TEA Academy. For example:

- Learn testing fundamentals from scratch
- Understand TEA methodology and workflows
- Improve test quality and reduce flakiness
- Master advanced patterns (fixtures, network-first, etc.)
- Prepare for QA onboarding at my company

**Your answer helps me recommend which sessions to focus on.**"

**Wait for response.**

**Validate response:**

- Must not be empty
- Should be at least 10 characters
- If too short: "Please provide more detail about your learning goals (at least a sentence)"
- Repeat until valid

**Store learning_goals for later update to progress file.**

### 5. Gather Pain Points (Optional)

Ask:

"**What are your current pain points with testing?** _(Optional)_

For example:

- Flaky tests that fail randomly
- Slow test suites
- Hard to maintain tests
- Don't know where to start
- Team doesn't value testing

**This helps me provide targeted examples. You can skip this by typing 'skip' or 'none'.**"

**Wait for response.**

**Handle response:**

- If response is "skip", "none", or similar → Set pain_points to null
- If response is provided → Store pain_points for later update
- No validation needed (optional field)

### 6. Summarize Assessment

Display:

"✅ **Assessment Complete!**

Here's what I learned about you:

**Role:** {role}
**Experience Level:** {experience_level}
**Learning Goals:** {learning_goals}
**Pain Points:** {pain_points or 'None specified'}

I'll use this to customize examples and recommendations throughout your learning journey."

### 7. Update Progress File

Load {progressFile} and update the following fields:

- `role: {role}`
- `experience_level: {experience_level}`
- `learning_goals: {learning_goals}`
- `pain_points: {pain_points}` (or null if not provided)

Update stepsCompleted array:

- Append 'step-02-assess' to stepsCompleted array
- Update lastStep: 'step-02-assess'

**Save the updated progress file.**

### 8. Provide Next Steps Preview

Display:

"**Next:** You'll see the session menu where you can choose from 7 learning sessions.

**Based on your experience level:**

{If beginner:}

- I recommend starting with Session 1 (Quick Start)
- It introduces TEA with a hands-on example

{If intermediate:}

- You might want to skip to Session 3 (Architecture)
- Or review Session 2 (Core Concepts) first if you want fundamentals

{If experienced:}

- Feel free to jump to Session 7 (Advanced Patterns)
- Or pick specific sessions based on your goals

You can take sessions in any order and pause anytime!"

### 9. Proceed to Session Menu

After the assessment summary, proceed directly to the session menu:

- Load, read entire file, then execute {nextStepFile}

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- All required fields gathered (role, experience_level, learning_goals)
- Optional pain_points handled correctly
- All responses validated before proceeding
- Progress file updated with assessment data
- stepsCompleted array updated with 'step-02-assess'
- Experience-based recommendations provided
- User routed to session menu (step-03)

### ❌ SYSTEM FAILURE:

- Skipping validation of required fields
- Not updating progress file
- Not adding to stepsCompleted array
- Proceeding without waiting for user responses
- Not providing experience-based recommendations
- Hardcoding responses instead of asking user

**Master Rule:** Assessment must be complete and validated before proceeding to session menu.
