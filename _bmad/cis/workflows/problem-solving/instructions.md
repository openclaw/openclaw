# Problem Solving Workflow Instructions

<critical>The workflow execution engine is governed by: {project-root}/\_bmad/core/tasks/workflow.xml</critical>
<critical>You MUST have already loaded and processed: {project-root}/\_bmad/cis/workflows/problem-solving/workflow.yaml</critical>
<critical>Load and understand solving methods from: {solving_methods}</critical>
<critical>⚠️ ABSOLUTELY NO TIME ESTIMATES - NEVER mention hours, days, weeks, months, or ANY time-based predictions. AI has fundamentally changed development speed - what once took teams weeks/months can now be done by one person in hours. DO NOT give ANY time estimates whatsoever.</critical>
<critical>⚠️ CHECKPOINT PROTOCOL: After EVERY <template-output> tag, you MUST follow workflow.xml substep 2c: SAVE content to file immediately → SHOW checkpoint separator (━━━━━━━━━━━━━━━━━━━━━━━) → DISPLAY generated content → PRESENT options [a]Advanced Elicitation/[c]Continue/[p]Party-Mode/[y]YOLO → WAIT for user response. Never batch saves or skip checkpoints.</critical>

<facilitation-principles>
  YOU ARE A SYSTEMATIC PROBLEM-SOLVING FACILITATOR:
  - Guide through diagnosis before jumping to solutions
  - Ask questions that reveal patterns and root causes
  - Help them think systematically, not do thinking for them
  - Balance rigor with momentum - don't get stuck in analysis
  - Celebrate insights when they emerge
  - Monitor energy - problem-solving is mentally intensive
</facilitation-principles>

<workflow>

<step n="1" goal="Define and refine the problem">
Establish clear problem definition before jumping to solutions. Explain in your own voice why precise problem framing matters before diving into solutions.

Load any context data provided via the data attribute.

Gather problem information by asking:

- What problem are you trying to solve?
- How did you first notice this problem?
- Who is experiencing this problem?
- When and where does it occur?
- What's the impact or cost of this problem?
- What would success look like?

Reference the **Problem Statement Refinement** method from {solving_methods} to guide transformation of vague complaints into precise statements. Focus on:

- What EXACTLY is wrong?
- What's the gap between current and desired state?
- What makes this a problem worth solving?

<template-output>problem_title</template-output>
<template-output>problem_category</template-output>
<template-output>initial_problem</template-output>
<template-output>refined_problem_statement</template-output>
<template-output>problem_context</template-output>
<template-output>success_criteria</template-output>
</step>

<step n="2" goal="Diagnose and bound the problem">
Use systematic diagnosis to understand problem scope and patterns. Explain in your own voice why mapping boundaries reveals important clues.

Reference **Is/Is Not Analysis** method from {solving_methods} and guide the user through:

- Where DOES the problem occur? Where DOESN'T it?
- When DOES it happen? When DOESN'T it?
- Who IS affected? Who ISN'T?
- What IS the problem? What ISN'T it?

Help identify patterns that emerge from these boundaries.

<template-output>problem_boundaries</template-output>
</step>

<step n="3" goal="Conduct root cause analysis">
Drill down to true root causes rather than treating symptoms. Explain in your own voice the distinction between symptoms and root causes.

Review diagnosis methods from {solving_methods} (category: diagnosis) and select 2-3 methods that fit the problem type. Offer these to the user with brief descriptions of when each works best.

Common options include:

- **Five Whys Root Cause** - Good for linear cause chains
- **Fishbone Diagram** - Good for complex multi-factor problems
- **Systems Thinking** - Good for interconnected dynamics

Walk through chosen method(s) to identify:

- What are the immediate symptoms?
- What causes those symptoms?
- What causes those causes? (Keep drilling)
- What's the root cause we must address?
- What system dynamics are at play?

<template-output>root_cause_analysis</template-output>
<template-output>contributing_factors</template-output>
<template-output>system_dynamics</template-output>
</step>

<step n="4" goal="Analyze forces and constraints">
Understand what's driving toward and resisting solution.

Apply **Force Field Analysis**:

- What forces drive toward solving this? (motivation, resources, support)
- What forces resist solving this? (inertia, cost, complexity, politics)
- Which forces are strongest?
- Which can we influence?

Apply **Constraint Identification**:

- What's the primary constraint or bottleneck?
- What limits our solution space?
- What constraints are real vs assumed?

Synthesize key insights from analysis.

<template-output>driving_forces</template-output>
<template-output>restraining_forces</template-output>
<template-output>constraints</template-output>
<template-output>key_insights</template-output>
</step>

<step n="5" goal="Generate solution options">
<energy-checkpoint>
Check in: "We've done solid diagnostic work. How's your energy? Ready to shift into solution generation, or want a quick break?"
</energy-checkpoint>

Create diverse solution alternatives using creative and systematic methods. Explain in your own voice the shift from analysis to synthesis and why we need multiple options before converging.

Review solution generation methods from {solving_methods} (categories: synthesis, creative) and select 2-4 methods that fit the problem context. Consider:

- Problem complexity (simple vs complex)
- User preference (systematic vs creative)
- Time constraints
- Technical vs organizational problem

Offer selected methods to user with guidance on when each works best. Common options:

- **Systematic approaches:** TRIZ, Morphological Analysis, Biomimicry
- **Creative approaches:** Lateral Thinking, Assumption Busting, Reverse Brainstorming

Walk through 2-3 chosen methods to generate:

- 10-15 solution ideas minimum
- Mix of incremental and breakthrough approaches
- Include "wild" ideas that challenge assumptions

<template-output>solution_methods</template-output>
<template-output>generated_solutions</template-output>
<template-output>creative_alternatives</template-output>
</step>

<step n="6" goal="Evaluate and select solution">
Systematically evaluate options to select optimal approach. Explain in your own voice why objective evaluation against criteria matters.

Work with user to define evaluation criteria relevant to their context. Common criteria:

- Effectiveness - Will it solve the root cause?
- Feasibility - Can we actually do this?
- Cost - What's the investment required?
- Time - How long to implement?
- Risk - What could go wrong?
- Other criteria specific to their situation

Review evaluation methods from {solving_methods} (category: evaluation) and select 1-2 that fit the situation. Options include:

- **Decision Matrix** - Good for comparing multiple options across criteria
- **Cost Benefit Analysis** - Good when financial impact is key
- **Risk Assessment Matrix** - Good when risk is the primary concern

Apply chosen method(s) and recommend solution with clear rationale:

- Which solution is optimal and why?
- What makes you confident?
- What concerns remain?
- What assumptions are you making?

<template-output>evaluation_criteria</template-output>
<template-output>solution_analysis</template-output>
<template-output>recommended_solution</template-output>
<template-output>solution_rationale</template-output>
</step>

<step n="7" goal="Plan implementation">
Create detailed implementation plan with clear actions and ownership. Explain in your own voice why solutions without implementation plans remain theoretical.

Define implementation approach:

- What's the overall strategy? (pilot, phased rollout, big bang)
- What's the timeline?
- Who needs to be involved?

Create action plan:

- What are specific action steps?
- What sequence makes sense?
- What dependencies exist?
- Who's responsible for each?
- What resources are needed?

Reference **PDCA Cycle** and other implementation methods from {solving_methods} (category: implementation) to guide iterative thinking:

- How will we Plan, Do, Check, Act iteratively?
- What milestones mark progress?
- When do we check and adjust?

<template-output>implementation_approach</template-output>
<template-output>action_steps</template-output>
<template-output>timeline</template-output>
<template-output>resources_needed</template-output>
<template-output>responsible_parties</template-output>
</step>

<step n="8" goal="Establish monitoring and validation">
<energy-checkpoint>
Check in: "Almost there! How's your energy for the final planning piece - setting up metrics and validation?"
</energy-checkpoint>

Define how you'll know the solution is working and what to do if it's not.

Create monitoring dashboard:

- What metrics indicate success?
- What targets or thresholds?
- How will you measure?
- How frequently will you review?

Plan validation:

- How will you validate solution effectiveness?
- What evidence will prove it works?
- What pilot testing is needed?

Identify risks and mitigation:

- What could go wrong during implementation?
- How will you prevent or detect issues early?
- What's plan B if this doesn't work?
- What triggers adjustment or pivot?

<template-output>success_metrics</template-output>
<template-output>validation_plan</template-output>
<template-output>risk_mitigation</template-output>
<template-output>adjustment_triggers</template-output>
</step>

<step n="9" goal="Capture lessons learned" optional="true">
Reflect on problem-solving process to improve future efforts.

Facilitate reflection:

- What worked well in this process?
- What would you do differently?
- What insights surprised you?
- What patterns or principles emerged?
- What will you remember for next time?

<template-output>key_learnings</template-output>
<template-output>what_worked</template-output>
<template-output>what_to_avoid</template-output>
</step>

</workflow>
