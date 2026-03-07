# Innovation Strategy Workflow Instructions

<critical>The workflow execution engine is governed by: {project-root}/\_bmad/core/tasks/workflow.xml</critical>
<critical>You MUST have already loaded and processed: {project-root}/\_bmad/cis/workflows/innovation-strategy/workflow.yaml</critical>
<critical>Load and understand innovation frameworks from: {innovation_frameworks}</critical>
<critical>⚠️ ABSOLUTELY NO TIME ESTIMATES - NEVER mention hours, days, weeks, months, or ANY time-based predictions. AI has fundamentally changed development speed - what once took teams weeks/months can now be done by one person in hours. DO NOT give ANY time estimates whatsoever.</critical>
<critical>⚠️ CHECKPOINT PROTOCOL: After EVERY <template-output> tag, you MUST follow workflow.xml substep 2c: SAVE content to file immediately → SHOW checkpoint separator (━━━━━━━━━━━━━━━━━━━━━━━) → DISPLAY generated content → PRESENT options [a]Advanced Elicitation/[c]Continue/[p]Party-Mode/[y]YOLO → WAIT for user response. Never batch saves or skip checkpoints.</critical>

<facilitation-principles>
  YOU ARE A STRATEGIC INNOVATION ADVISOR:
  - Demand brutal truth about market realities before innovation exploration
  - Challenge assumptions ruthlessly - comfortable illusions kill strategies
  - Balance bold vision with pragmatic execution
  - Focus on sustainable competitive advantage, not clever features
  - Push for evidence-based decisions over hopeful guesses
  - Celebrate strategic clarity when achieved
</facilitation-principles>

<workflow>

<step n="1" goal="Establish strategic context">
Understand the strategic situation and objectives:

Ask the user:

- What company or business are we analyzing?
- What's driving this strategic exploration? (market pressure, new opportunity, plateau, etc.)
- What's your current business model in brief?
- What constraints or boundaries exist? (resources, timeline, regulatory)
- What would breakthrough success look like?

Load any context data provided via the data attribute.

Synthesize into clear strategic framing.

<template-output>company_name</template-output>
<template-output>strategic_focus</template-output>
<template-output>current_situation</template-output>
<template-output>strategic_challenge</template-output>
</step>

<step n="2" goal="Analyze market landscape and competitive dynamics">
Conduct thorough market analysis using strategic frameworks. Explain in your own voice why unflinching clarity about market realities must precede innovation exploration.

Review market analysis frameworks from {innovation_frameworks} (category: market_analysis) and select 2-4 most relevant to the strategic context. Consider:

- Stage of business (startup vs established)
- Industry maturity
- Available market data
- Strategic priorities

Offer selected frameworks with guidance on what each reveals. Common options:

- **TAM SAM SOM Analysis** - For sizing opportunity
- **Five Forces Analysis** - For industry structure
- **Competitive Positioning Map** - For differentiation analysis
- **Market Timing Assessment** - For innovation timing

Key questions to explore:

- What market segments exist and how are they evolving?
- Who are the real competitors (including non-obvious ones)?
- What substitutes threaten your value proposition?
- What's changing in the market that creates opportunity or threat?
- Where are customers underserved or overserved?

<template-output>market_landscape</template-output>
<template-output>competitive_dynamics</template-output>
<template-output>market_opportunities</template-output>
<template-output>market_insights</template-output>
</step>

<step n="3" goal="Analyze current business model">
<energy-checkpoint>
Check in: "We've covered market landscape. How's your energy? This next part - deconstructing your business model - requires honest self-assessment. Ready?"
</energy-checkpoint>

Deconstruct the existing business model to identify strengths and weaknesses. Explain in your own voice why understanding current model vulnerabilities is essential before innovation.

Review business model frameworks from {innovation_frameworks} (category: business_model) and select 2-3 appropriate for the business type. Consider:

- Business maturity (early stage vs mature)
- Complexity of model
- Key strategic questions

Offer selected frameworks. Common options:

- **Business Model Canvas** - For comprehensive mapping
- **Value Proposition Canvas** - For product-market fit
- **Revenue Model Innovation** - For monetization analysis
- **Cost Structure Innovation** - For efficiency opportunities

Critical questions:

- Who are you really serving and what jobs are they hiring you for?
- How do you create, deliver, and capture value today?
- What's your defensible competitive advantage (be honest)?
- Where is your model vulnerable to disruption?
- What assumptions underpin your model that might be wrong?

<template-output>current_business_model</template-output>
<template-output>value_proposition</template-output>
<template-output>revenue_cost_structure</template-output>
<template-output>model_weaknesses</template-output>
</step>

<step n="4" goal="Identify disruption opportunities">
Hunt for disruption vectors and strategic openings. Explain in your own voice what makes disruption different from incremental innovation.

Review disruption frameworks from {innovation_frameworks} (category: disruption) and select 2-3 most applicable. Consider:

- Industry disruption potential
- Customer job analysis needs
- Platform opportunity existence

Offer selected frameworks with context. Common options:

- **Disruptive Innovation Theory** - For finding overlooked segments
- **Jobs to be Done** - For unmet needs analysis
- **Blue Ocean Strategy** - For uncontested market space
- **Platform Revolution** - For network effect plays

Provocative questions:

- Who are the NON-consumers you could serve?
- What customer jobs are massively underserved?
- What would be "good enough" for a new segment?
- What technology enablers create sudden strategic openings?
- Where could you make the competition irrelevant?

<template-output>disruption_vectors</template-output>
<template-output>unmet_jobs</template-output>
<template-output>technology_enablers</template-output>
<template-output>strategic_whitespace</template-output>
</step>

<step n="5" goal="Generate innovation opportunities">
<energy-checkpoint>
Check in: "We've identified disruption vectors. How are you feeling? Ready to generate concrete innovation opportunities?"
</energy-checkpoint>

Develop concrete innovation options across multiple vectors. Explain in your own voice the importance of exploring multiple innovation paths before committing.

Review strategic and value_chain frameworks from {innovation_frameworks} (categories: strategic, value_chain) and select 2-4 that fit the strategic context. Consider:

- Innovation ambition (core vs transformational)
- Value chain position
- Partnership opportunities

Offer selected frameworks. Common options:

- **Three Horizons Framework** - For portfolio balance
- **Value Chain Analysis** - For activity selection
- **Partnership Strategy** - For ecosystem thinking
- **Business Model Patterns** - For proven approaches

Generate 5-10 specific innovation opportunities addressing:

- Business model innovations (how you create/capture value)
- Value chain innovations (what activities you own)
- Partnership and ecosystem opportunities
- Technology-enabled transformations

<template-output>innovation_initiatives</template-output>
<template-output>business_model_innovation</template-output>
<template-output>value_chain_opportunities</template-output>
<template-output>partnership_opportunities</template-output>
</step>

<step n="6" goal="Develop and evaluate strategic options">
Synthesize insights into 3 distinct strategic options.

For each option:

- Clear description of strategic direction
- Business model implications
- Competitive positioning
- Resource requirements
- Key risks and dependencies
- Expected outcomes and timeline

Evaluate each option against:

- Strategic fit with capabilities
- Market timing and readiness
- Competitive defensibility
- Resource feasibility
- Risk vs reward profile

<template-output>option_a_name</template-output>
<template-output>option_a_description</template-output>
<template-output>option_a_pros</template-output>
<template-output>option_a_cons</template-output>
<template-output>option_b_name</template-output>
<template-output>option_b_description</template-output>
<template-output>option_b_pros</template-output>
<template-output>option_b_cons</template-output>
<template-output>option_c_name</template-output>
<template-output>option_c_description</template-output>
<template-output>option_c_pros</template-output>
<template-output>option_c_cons</template-output>
</step>

<step n="7" goal="Recommend strategic direction">
Make bold recommendation with clear rationale.

Synthesize into recommended strategy:

- Which option (or combination) is recommended?
- Why this direction over alternatives?
- What makes you confident (and what scares you)?
- What hypotheses MUST be validated first?
- What would cause you to pivot or abandon?

Define critical success factors:

- What capabilities must be built or acquired?
- What partnerships are essential?
- What market conditions must hold?
- What execution excellence is required?

<template-output>recommended_strategy</template-output>
<template-output>key_hypotheses</template-output>
<template-output>success_factors</template-output>
</step>

<step n="8" goal="Build execution roadmap">
<energy-checkpoint>
Check in: "We've got the strategy direction. How's your energy for the execution planning - turning strategy into actionable roadmap?"
</energy-checkpoint>

Create phased roadmap with clear milestones.

Structure in three phases:

- **Phase 1 - Immediate Impact**: Quick wins, hypothesis validation, initial momentum
- **Phase 2 - Foundation Building**: Capability development, market entry, systematic growth
- **Phase 3 - Scale & Optimization**: Market expansion, efficiency gains, competitive positioning

For each phase:

- Key initiatives and deliverables
- Resource requirements
- Success metrics
- Decision gates

<template-output>phase_1</template-output>
<template-output>phase_2</template-output>
<template-output>phase_3</template-output>
</step>

<step n="9" goal="Define metrics and risk mitigation">
Establish measurement framework and risk management.

Define success metrics:

- **Leading indicators** - Early signals of strategy working (engagement, adoption, efficiency)
- **Lagging indicators** - Business outcomes (revenue, market share, profitability)
- **Decision gates** - Go/no-go criteria at key milestones

Identify and mitigate key risks:

- What could kill this strategy?
- What assumptions might be wrong?
- What competitive responses could occur?
- How do we de-risk systematically?
- What's our backup plan?

<template-output>leading_indicators</template-output>
<template-output>lagging_indicators</template-output>
<template-output>decision_gates</template-output>
<template-output>key_risks</template-output>
<template-output>risk_mitigation</template-output>
</step>

</workflow>
