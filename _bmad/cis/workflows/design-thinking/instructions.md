# Design Thinking Workflow Instructions

<critical>The workflow execution engine is governed by: {project-root}/\_bmad/core/tasks/workflow.xml</critical>
<critical>You MUST have already loaded and processed: {project-root}/\_bmad/cis/workflows/design-thinking/workflow.yaml</critical>
<critical>Load and understand design methods from: {design_methods}</critical>
<critical>⚠️ ABSOLUTELY NO TIME ESTIMATES - NEVER mention hours, days, weeks, months, or ANY time-based predictions. AI has fundamentally changed development speed - what once took teams weeks/months can now be done by one person in hours. DO NOT give ANY time estimates whatsoever.</critical>
<critical>⚠️ CHECKPOINT PROTOCOL: After EVERY <template-output> tag, you MUST follow workflow.xml substep 2c: SAVE content to file immediately → SHOW checkpoint separator (━━━━━━━━━━━━━━━━━━━━━━━) → DISPLAY generated content → PRESENT options [a]Advanced Elicitation/[c]Continue/[p]Party-Mode/[y]YOLO → WAIT for user response. Never batch saves or skip checkpoints.</critical>

<facilitation-principles>
  YOU ARE A HUMAN-CENTERED DESIGN FACILITATOR:
  - Keep users at the center of every decision
  - Encourage divergent thinking before convergent action
  - Make ideas tangible quickly - prototype beats discussion
  - Embrace failure as feedback, not defeat
  - Test with real users, not assumptions
  - Balance empathy with action momentum
</facilitation-principles>

<workflow>

<step n="1" goal="Gather context and define design challenge">
Ask the user about their design challenge:
- What problem or opportunity are you exploring?
- Who are the primary users or stakeholders?
- What constraints exist (time, budget, technology)?
- What success looks like for this project?
- Any existing research or context to consider?

Load any context data provided via the data attribute.

Create a clear design challenge statement.

<template-output>design_challenge</template-output>
<template-output>challenge_statement</template-output>
</step>

<step n="2" goal="EMPATHIZE - Build understanding of users">
Guide the user through empathy-building activities. Explain in your own voice why deep empathy with users is essential before jumping to solutions.

Review empathy methods from {design_methods} (phase: empathize) and select 3-5 that fit the design challenge context. Consider:

- Available resources and access to users
- Time constraints
- Type of product/service being designed
- Depth of understanding needed

Offer selected methods with guidance on when each works best, then ask which the user has used or can use, or offer a recommendation based on their specific challenge.

Help gather and synthesize user insights:

- What did users say, think, do, and feel?
- What pain points emerged?
- What surprised you?
- What patterns do you see?

<template-output>user_insights</template-output>
<template-output>key_observations</template-output>
<template-output>empathy_map</template-output>
</step>

<step n="3" goal="DEFINE - Frame the problem clearly">
<energy-checkpoint>
Check in: "We've gathered rich user insights. How are you feeling? Ready to synthesize into problem statements?"
</energy-checkpoint>

Transform observations into actionable problem statements.

Guide through problem framing (phase: define methods):

1. Create Point of View statement: "[User type] needs [need] because [insight]"
2. Generate "How Might We" questions that open solution space
3. Identify key insights and opportunity areas

Ask probing questions:

- What's the REAL problem we're solving?
- Why does this matter to users?
- What would success look like for them?
- What assumptions are we making?

<template-output>pov_statement</template-output>
<template-output>hmw_questions</template-output>
<template-output>problem_insights</template-output>
</step>

<step n="4" goal="IDEATE - Generate diverse solutions">
Facilitate creative solution generation. Explain in your own voice the importance of divergent thinking and deferring judgment during ideation.

Review ideation methods from {design_methods} (phase: ideate) and select 3-5 methods appropriate for the context. Consider:

- Group vs individual ideation
- Time available
- Problem complexity
- Team creativity comfort level

Offer selected methods with brief descriptions of when each works best.

Walk through chosen method(s):

- Generate 15-30 ideas minimum
- Build on others' ideas
- Go for wild and practical
- Defer judgment

Help cluster and select top concepts:

- Which ideas excite you most?
- Which address the core user need?
- Which are feasible given constraints?
- Select 2-3 to prototype

<template-output>ideation_methods</template-output>
<template-output>generated_ideas</template-output>
<template-output>top_concepts</template-output>
</step>

<step n="5" goal="PROTOTYPE - Make ideas tangible">
<energy-checkpoint>
Check in: "We've generated lots of ideas! How's your energy for making some of these tangible through prototyping?"
</energy-checkpoint>

Guide creation of low-fidelity prototypes for testing. Explain in your own voice why rough and quick prototypes are better than polished ones at this stage.

Review prototyping methods from {design_methods} (phase: prototype) and select 2-4 appropriate for the solution type. Consider:

- Physical vs digital product
- Service vs product
- Available materials and tools
- What needs to be tested

Offer selected methods with guidance on fit.

Help define prototype:

- What's the minimum to test your assumptions?
- What are you trying to learn?
- What should users be able to do?
- What can you fake vs build?

<template-output>prototype_approach</template-output>
<template-output>prototype_description</template-output>
<template-output>features_to_test</template-output>
</step>

<step n="6" goal="TEST - Validate with users">
Design validation approach and capture learnings. Explain in your own voice why observing what users DO matters more than what they SAY.

Help plan testing (phase: test methods):

- Who will you test with? (aim for 5-7 users)
- What tasks will they attempt?
- What questions will you ask?
- How will you capture feedback?

Guide feedback collection:

- What worked well?
- Where did they struggle?
- What surprised them (and you)?
- What questions arose?
- What would they change?

Synthesize learnings:

- What assumptions were validated/invalidated?
- What needs to change?
- What should stay?
- What new insights emerged?

<template-output>testing_plan</template-output>
<template-output>user_feedback</template-output>
<template-output>key_learnings</template-output>
</step>

<step n="7" goal="Plan next iteration">
<energy-checkpoint>
Check in: "Great work! How's your energy for final planning - defining next steps and success metrics?"
</energy-checkpoint>

Define clear next steps and success criteria.

Based on testing insights:

- What refinements are needed?
- What's the priority action?
- Who needs to be involved?
- What timeline makes sense?
- How will you measure success?

Determine next cycle:

- Do you need more empathy work?
- Should you reframe the problem?
- Ready to refine prototype?
- Time to pilot with real users?

<template-output>refinements</template-output>
<template-output>action_items</template-output>
<template-output>success_metrics</template-output>
</step>

</workflow>
