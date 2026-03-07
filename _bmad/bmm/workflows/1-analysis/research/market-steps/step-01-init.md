# Market Research Step 1: Market Research Initialization

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate research content in init step
- ✅ ALWAYS confirm understanding of user's research goals
- 📋 YOU ARE A MARKET RESEARCH FACILITATOR, not content generator
- 💬 FOCUS on clarifying scope and approach
- 🔍 NO WEB RESEARCH in init - that's for later steps
- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete research
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Confirm research understanding before proceeding
- ⚠️ Present [C] continue option after scope clarification
- 💾 Write initial scope document immediately
- 📖 Update frontmatter `stepsCompleted: [1]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from main workflow discovery are available
- Research type = "market" is already set
- **Research topic = "{{research_topic}}"** - discovered from initial discussion
- **Research goals = "{{research_goals}}"** - captured from initial discussion
- Focus on market research scope clarification
- Web search capabilities are enabled for later steps

## YOUR TASK:

Initialize market research by confirming understanding of {{research_topic}} and establishing clear research scope.

## MARKET RESEARCH INITIALIZATION:

### 1. Confirm Research Understanding

**INITIALIZE - DO NOT RESEARCH YET**

Start with research confirmation:
"I understand you want to conduct **market research** for **{{research_topic}}** with these goals: {{research_goals}}

**My Understanding of Your Research Needs:**

- **Research Topic**: {{research_topic}}
- **Research Goals**: {{research_goals}}
- **Research Type**: Market Research
- **Approach**: Comprehensive market analysis with source verification

**Market Research Areas We'll Cover:**

- Market size, growth dynamics, and trends
- Customer insights and behavior analysis
- Competitive landscape and positioning
- Strategic recommendations and implementation guidance

**Does this accurately capture what you're looking for?**"

### 2. Refine Research Scope

Gather any clarifications needed:

#### Scope Clarification Questions:

- "Are there specific customer segments or aspects of {{research_topic}} we should prioritize?"
- "Should we focus on specific geographic regions or global market?"
- "Is this for market entry, expansion, product development, or other business purpose?"
- "Any competitors or market segments you specifically want us to analyze?"

### 3. Document Initial Scope

**WRITE IMMEDIATELY TO DOCUMENT**

Write initial research scope to document:

```markdown
# Market Research: {{research_topic}}

## Research Initialization

### Research Understanding Confirmed

**Topic**: {{research_topic}}
**Goals**: {{research_goals}}
**Research Type**: Market Research
**Date**: {{date}}

### Research Scope

**Market Analysis Focus Areas:**

- Market size, growth projections, and dynamics
- Customer segments, behavior patterns, and insights
- Competitive landscape and positioning analysis
- Strategic recommendations and implementation guidance

**Research Methodology:**

- Current web data with source verification
- Multiple independent sources for critical claims
- Confidence level assessment for uncertain data
- Comprehensive coverage with no critical gaps

### Next Steps

**Research Workflow:**

1. ✅ Initialization and scope setting (current step)
2. Customer Insights and Behavior Analysis
3. Competitive Landscape Analysis
4. Strategic Synthesis and Recommendations

**Research Status**: Scope confirmed, ready to proceed with detailed market analysis
```

### 4. Present Confirmation and Continue Option

Show initial scope document and present continue option:
"I've documented our understanding and initial scope for **{{research_topic}}** market research.

**What I've established:**

- Research topic and goals confirmed
- Market analysis focus areas defined
- Research methodology verification
- Clear workflow progression

**Document Status:** Initial scope written to research file for your review

**Ready to begin detailed market research?**
[C] Continue - Confirm scope and proceed to customer insights analysis
[Modify] Suggest changes to research scope before proceeding

### 5. Handle User Response

#### If 'C' (Continue):

- Update frontmatter: `stepsCompleted: [1]`
- Add confirmation note to document: "Scope confirmed by user on {{date}}"
- Load: `{project-root}/_bmad/bmm/workflows/1-analysis/research/market-steps/step-02-customer-behavior.md`

#### If 'Modify':

- Gather user changes to scope
- Update document with modifications
- Re-present updated scope for confirmation

## SUCCESS METRICS:

✅ Research topic and goals accurately understood
✅ Market research scope clearly defined
✅ Initial scope document written immediately
✅ User opportunity to review and modify scope
✅ [C] continue option presented and handled correctly
✅ Document properly updated with scope confirmation

## FAILURE MODES:

❌ Not confirming understanding of research topic and goals
❌ Generating research content instead of just scope clarification
❌ Not writing initial scope document to file
❌ Not providing opportunity for user to modify scope
❌ Proceeding to next step without user confirmation
❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor research decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## INITIALIZATION PRINCIPLES:

This step ensures:

- Clear mutual understanding of research objectives
- Well-defined research scope and approach
- Immediate documentation for user review
- User control over research direction before detailed work begins

## NEXT STEP:

After user confirmation and scope finalization, load `{project-root}/_bmad/bmm/workflows/1-analysis/research/market-steps/step-02-customer-behavior.md` to begin detailed market research with customer insights analysis.

Remember: Init steps confirm understanding and scope, not generate research content!
