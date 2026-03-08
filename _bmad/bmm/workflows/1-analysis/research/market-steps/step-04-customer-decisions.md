# Market Research Step 4: Customer Decisions and Journey

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without web search verification

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ Search the web to verify and supplement your knowledge with current facts
- 📋 YOU ARE A CUSTOMER DECISION ANALYST, not content generator
- 💬 FOCUS on customer decision processes and journey mapping
- 🔍 WEB SEARCH REQUIRED - verify current facts against live sources
- 📝 WRITE CONTENT IMMEDIATELY TO DOCUMENT
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show web search analysis before presenting findings
- ⚠️ Present [C] continue option after decision processes content generation
- 📝 WRITE CUSTOMER DECISIONS ANALYSIS TO DOCUMENT IMMEDIATELY
- 💾 ONLY proceed when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1, 2, 3, 4]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from previous steps are available
- Customer behavior and pain points analysis completed in previous steps
- Focus on customer decision processes and journey mapping
- Web search capabilities with source verification are enabled
- **Research topic = "{{research_topic}}"** - established from initial discussion
- **Research goals = "{{research_goals}}"** - established from initial discussion

## YOUR TASK:

Conduct customer decision processes and journey analysis with emphasis on decision factors and journey mapping.

## CUSTOMER DECISIONS ANALYSIS SEQUENCE:

### 1. Begin Customer Decisions Analysis

**UTILIZE SUBPROCESSES AND SUBAGENTS**: Use research subagents, subprocesses or parallel processing if available to thoroughly analyze different customer decision areas simultaneously and thoroughly.

Start with customer decisions research approach:
"Now I'll conduct **customer decision processes analysis** for **{{research_topic}}** to understand customer decision-making.

**Customer Decisions Focus:**

- Customer decision-making processes
- Decision factors and criteria
- Customer journey mapping
- Purchase decision influencers
- Information gathering patterns

**Let me search for current customer decision insights.**"

### 2. Parallel Decisions Research Execution

**Execute multiple web searches simultaneously:**

Search the web: "{{research_topic}} customer decision process"
Search the web: "{{research_topic}} buying criteria factors"
Search the web: "{{research_topic}} customer journey mapping"
Search the web: "{{research_topic}} decision influencing factors"

**Analysis approach:**

- Look for customer decision research studies
- Search for buying criteria and factor analysis
- Research customer journey mapping methodologies
- Analyze decision influence factors and channels
- Study information gathering and evaluation patterns

### 3. Analyze and Aggregate Results

**Collect and analyze findings from all parallel searches:**

"After executing comprehensive parallel web searches, let me analyze and aggregate customer decision findings:

**Research Coverage:**

- Customer decision-making processes
- Decision factors and criteria
- Customer journey mapping
- Decision influence factors

**Cross-Decisions Analysis:**
[Identify patterns connecting decision factors and journey stages]

**Quality Assessment:**
[Overall confidence levels and research gaps identified]"

### 4. Generate Customer Decisions Content

**WRITE IMMEDIATELY TO DOCUMENT**

Prepare customer decisions analysis with web search citations:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## Customer Decision Processes and Journey

### Customer Decision-Making Processes

[Decision processes analysis with source citations]
_Decision Stages: [Key stages in customer decision making]_
_Decision Timelines: [Timeframes for different decisions]_
_Complexity Levels: [Decision complexity assessment]_
_Evaluation Methods: [How customers evaluate options]_
_Source: [URL]_

### Decision Factors and Criteria

[Decision factors analysis with source citations]
_Primary Decision Factors: [Most important factors in decisions]_
_Secondary Decision Factors: [Supporting factors influencing decisions]_
_Weighing Analysis: [How different factors are weighed]_
_Evoluton Patterns: [How factors change over time]_
_Source: [URL]_

### Customer Journey Mapping

[Journey mapping analysis with source citations]
_Awareness Stage: [How customers become aware of {{research_topic}}]_
_Consideration Stage: [Evaluation and comparison process]_
_Decision Stage: [Final decision-making process]_
_Purchase Stage: [Purchase execution and completion]_
_Post-Purchase Stage: [Post-decision evaluation and behavior]_
_Source: [URL]_

### Touchpoint Analysis

[Touchpoint analysis with source citations]
_Digital Touchpoints: [Online and digital interaction points]_
_Offline Touchpoints: [Physical and in-person interaction points]_
_Information Sources: [Where customers get information]_
_Influence Channels: [What influences customer decisions]_
_Source: [URL]_

### Information Gathering Patterns

[Information patterns analysis with source citations]
_Research Methods: [How customers research options]_
_Information Sources Trusted: [Most trusted information sources]_
_Research Duration: [Time spent gathering information]_
_Evaluation Criteria: [How customers evaluate information]_
_Source: [URL]_

### Decision Influencers

[Decision influencer analysis with source citations]
_Peer Influence: [How friends and family influence decisions]_
_Expert Influence: [How expert opinions affect decisions]_
_Media Influence: [How media and marketing affect decisions]_
_Social Proof Influence: [How reviews and testimonials affect decisions]_
_Source: [URL]_

### Purchase Decision Factors

[Purchase decision factors analysis with source citations]
_Immediate Purchase Drivers: [Factors triggering immediate purchase]_
_Delayed Purchase Drivers: [Factors causing purchase delays]_
_Brand Loyalty Factors: [Factors driving repeat purchases]_
_Price Sensitivity: [How price affects purchase decisions]_
_Source: [URL]_

### Customer Decision Optimizations

[Decision optimization analysis with source citations]
_Friction Reduction: [Ways to make decisions easier]_
_Trust Building: [Building customer trust in decisions]_
_Conversion Optimization: [Optimizing decision-to-purchase rates]_
_Loyalty Building: [Building long-term customer relationships]_
_Source: [URL]_
```

### 5. Present Analysis and Continue Option

**Show analysis and present continue option:**

"I've completed **customer decision processes analysis** for {{research_topic}}, focusing on customer decision-making.

**Key Decision Findings:**

- Customer decision-making processes clearly mapped
- Decision factors and criteria thoroughly analyzed
- Customer journey mapping completed across all stages
- Decision influencers and touchpoints identified
- Information gathering patterns documented

**Ready to proceed to competitive analysis?**
[C] Continue - Save this to document and proceed to competitive analysis

### 6. Handle Continue Selection

#### If 'C' (Continue):

- **CONTENT ALREADY WRITTEN TO DOCUMENT**
- Update frontmatter: `stepsCompleted: [1, 2, 3, 4]`
- Load: `{project-root}/_bmad/bmm/workflows/1-analysis/research/market-steps/step-05-competitive-analysis.md`

## APPEND TO DOCUMENT:

Content is already written to document when generated in step 4. No additional append needed.

## SUCCESS METRICS:

✅ Customer decision-making processes clearly mapped
✅ Decision factors and criteria thoroughly analyzed
✅ Customer journey mapping completed across all stages
✅ Decision influencers and touchpoints identified
✅ Information gathering patterns documented
✅ Content written immediately to document
✅ [C] continue option presented and handled correctly
✅ Proper routing to next step (competitive analysis)
✅ Research goals alignment maintained

## FAILURE MODES:

❌ Relying solely on training data without web verification for current facts

❌ Missing critical decision-making process stages
❌ Not identifying key decision factors
❌ Incomplete customer journey mapping
❌ Not writing content immediately to document
❌ Not presenting [C] continue option after content generation
❌ Not routing to competitive analysis step

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## CUSTOMER DECISIONS RESEARCH PROTOCOLS:

- Research customer decision studies and psychology
- Use customer journey mapping methodologies
- Analyze buying criteria and decision factors
- Study decision influence and touchpoint analysis
- Focus on current decision data
- Present conflicting information when sources disagree
- Apply confidence levels appropriately

## DECISION ANALYSIS STANDARDS:

- Always cite URLs for web search results
- Use authoritative customer decision research sources
- Note data currency and potential limitations
- Present multiple perspectives when sources conflict
- Apply confidence levels to uncertain data
- Focus on actionable decision insights

## NEXT STEP:

After user selects 'C', load `{project-root}/_bmad/bmm/workflows/1-analysis/research/market-steps/step-05-competitive-analysis.md` to analyze competitive landscape, market positioning, and competitive strategies for {{research_topic}}.

Remember: Always write research content to document immediately and emphasize current customer decision data with rigorous source verification!
