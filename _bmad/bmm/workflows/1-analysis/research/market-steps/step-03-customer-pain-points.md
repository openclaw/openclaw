# Market Research Step 3: Customer Pain Points and Needs

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without web search verification

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ Search the web to verify and supplement your knowledge with current facts
- 📋 YOU ARE A CUSTOMER NEEDS ANALYST, not content generator
- 💬 FOCUS on customer pain points, challenges, and unmet needs
- 🔍 WEB SEARCH REQUIRED - verify current facts against live sources
- 📝 WRITE CONTENT IMMEDIATELY TO DOCUMENT
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show web search analysis before presenting findings
- ⚠️ Present [C] continue option after pain points content generation
- 📝 WRITE CUSTOMER PAIN POINTS ANALYSIS TO DOCUMENT IMMEDIATELY
- 💾 ONLY proceed when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1, 2, 3]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from previous steps are available
- Customer behavior analysis completed in previous step
- Focus on customer pain points, challenges, and unmet needs
- Web search capabilities with source verification are enabled
- **Research topic = "{{research_topic}}"** - established from initial discussion
- **Research goals = "{{research_goals}}"** - established from initial discussion

## YOUR TASK:

Conduct customer pain points and needs analysis with emphasis on challenges and frustrations.

## CUSTOMER PAIN POINTS ANALYSIS SEQUENCE:

### 1. Begin Customer Pain Points Analysis

**UTILIZE SUBPROCESSES AND SUBAGENTS**: Use research subagents, subprocesses or parallel processing if available to thoroughly analyze different customer pain point areas simultaneously and thoroughly.

Start with customer pain points research approach:
"Now I'll conduct **customer pain points analysis** for **{{research_topic}}** to understand customer challenges.

**Customer Pain Points Focus:**

- Customer challenges and frustrations
- Unmet needs and unaddressed problems
- Barriers to adoption or usage
- Service and support pain points
- Customer satisfaction gaps

**Let me search for current customer pain points insights.**"

### 2. Parallel Pain Points Research Execution

**Execute multiple web searches simultaneously:**

Search the web: "{{research_topic}} customer pain points challenges"
Search the web: "{{research_topic}} customer frustrations"
Search the web: "{{research_topic}} unmet customer needs"
Search the web: "{{research_topic}} customer barriers to adoption"

**Analysis approach:**

- Look for customer satisfaction surveys and reports
- Search for customer complaints and reviews
- Research customer support and service issues
- Analyze barriers to customer adoption
- Study unmet needs and market gaps

### 3. Analyze and Aggregate Results

**Collect and analyze findings from all parallel searches:**

"After executing comprehensive parallel web searches, let me analyze and aggregate customer pain points findings:

**Research Coverage:**

- Customer challenges and frustrations
- Unmet needs and unaddressed problems
- Barriers to adoption or usage
- Service and support pain points

**Cross-Pain Points Analysis:**
[Identify patterns connecting different types of pain points]

**Quality Assessment:**
[Overall confidence levels and research gaps identified]"

### 4. Generate Customer Pain Points Content

**WRITE IMMEDIATELY TO DOCUMENT**

Prepare customer pain points analysis with web search citations:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## Customer Pain Points and Needs

### Customer Challenges and Frustrations

[Customer challenges analysis with source citations]
_Primary Frustrations: [Major customer frustrations identified]_
_Usage Barriers: [Barriers preventing effective usage]_
_Service Pain Points: [Customer service and support issues]_
_Frequency Analysis: [How often these challenges occur]_
_Source: [URL]_

### Unmet Customer Needs

[Unmet needs analysis with source citations]
_Critical Unmet Needs: [Most important unaddressed needs]_
_Solution Gaps: [Opportunities to address unmet needs]_
_Market Gaps: [Market opportunities from unmet needs]_
_Priority Analysis: [Which needs are most critical]_
_Source: [URL]_

### Barriers to Adoption

[Adoption barriers analysis with source citations]
_Price Barriers: [Cost-related barriers to adoption]_
_Technical Barriers: [Complexity or technical barriers]_
_Trust Barriers: [Trust and credibility issues]_
_Convenience Barriers: [Ease of use or accessibility issues]_
_Source: [URL]_

### Service and Support Pain Points

[Service pain points analysis with source citations]
_Customer Service Issues: [Common customer service problems]_
_Support Gaps: [Areas where customer support is lacking]_
_Communication Issues: [Communication breakdowns and frustrations]_
_Response Time Issues: [Slow response and resolution problems]_
_Source: [URL]_

### Customer Satisfaction Gaps

[Satisfaction gap analysis with source citations]
_Expectation Gaps: [Differences between expectations and reality]_
_Quality Gaps: [Areas where quality expectations aren't met]_
_Value Perception Gaps: [Perceived value vs actual value]_
_Trust and Credibility Gaps: [Trust issues affecting satisfaction]_
_Source: [URL]_

### Emotional Impact Assessment

[Emotional impact analysis with source citations]
_Frustration Levels: [Customer frustration severity assessment]_
_Loyalty Risks: [How pain points affect customer loyalty]_
_Reputation Impact: [Impact on brand or product reputation]_
_Customer Retention Risks: [Risk of customer loss from pain points]_
_Source: [URL]_

### Pain Point Prioritization

[Pain point prioritization with source citations]
_High Priority Pain Points: [Most critical pain points to address]_
_Medium Priority Pain Points: [Important but less critical pain points]_
_Low Priority Pain Points: [Minor pain points with lower impact]_
_Opportunity Mapping: [Pain points with highest solution opportunity]_
_Source: [URL]_
```

### 5. Present Analysis and Continue Option

**Show analysis and present continue option:**

"I've completed **customer pain points analysis** for {{research_topic}}, focusing on customer challenges.

**Key Pain Points Findings:**

- Customer challenges and frustrations thoroughly documented
- Unmet needs and solution gaps clearly identified
- Adoption barriers and service pain points analyzed
- Customer satisfaction gaps assessed
- Pain points prioritized by impact and opportunity

**Ready to proceed to customer decision processes?**
[C] Continue - Save this to document and proceed to decision processes analysis

### 6. Handle Continue Selection

#### If 'C' (Continue):

- **CONTENT ALREADY WRITTEN TO DOCUMENT**
- Update frontmatter: `stepsCompleted: [1, 2, 3]`
- Load: `{project-root}/_bmad/bmm/workflows/1-analysis/research/market-steps/step-04-customer-decisions.md`

## APPEND TO DOCUMENT:

Content is already written to document when generated in step 4. No additional append needed.

## SUCCESS METRICS:

✅ Customer challenges and frustrations clearly documented
✅ Unmet needs and solution gaps identified
✅ Adoption barriers and service pain points analyzed
✅ Customer satisfaction gaps assessed
✅ Pain points prioritized by impact and opportunity
✅ Content written immediately to document
✅ [C] continue option presented and handled correctly
✅ Proper routing to next step (customer decisions)
✅ Research goals alignment maintained

## FAILURE MODES:

❌ Relying solely on training data without web verification for current facts

❌ Missing critical customer challenges or frustrations
❌ Not identifying unmet needs or solution gaps
❌ Incomplete adoption barriers analysis
❌ Not writing content immediately to document
❌ Not presenting [C] continue option after content generation
❌ Not routing to customer decisions analysis step

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## CUSTOMER PAIN POINTS RESEARCH PROTOCOLS:

- Research customer satisfaction surveys and reviews
- Use customer feedback and complaint data
- Analyze customer support and service issues
- Study barriers to customer adoption
- Focus on current pain point data
- Present conflicting information when sources disagree
- Apply confidence levels appropriately

## PAIN POINTS ANALYSIS STANDARDS:

- Always cite URLs for web search results
- Use authoritative customer research sources
- Note data currency and potential limitations
- Present multiple perspectives when sources conflict
- Apply confidence levels to uncertain data
- Focus on actionable pain point insights

## NEXT STEP:

After user selects 'C', load `{project-root}/_bmad/bmm/workflows/1-analysis/research/market-steps/step-04-customer-decisions.md` to analyze customer decision processes, journey mapping, and decision factors for {{research_topic}}.

Remember: Always write research content to document immediately and emphasize current customer pain points data with rigorous source verification!
