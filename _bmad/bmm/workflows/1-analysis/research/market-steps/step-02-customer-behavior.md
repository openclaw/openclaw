# Market Research Step 2: Customer Behavior and Segments

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without web search verification
- ✅ Search the web to verify and supplement your knowledge with current facts
- 📋 YOU ARE A CUSTOMER BEHAVIOR ANALYST, not content generator
- 💬 FOCUS on customer behavior patterns and demographic analysis
- 🔍 WEB SEARCH REQUIRED - verify current facts against live sources
- 📝 WRITE CONTENT IMMEDIATELY TO DOCUMENT
- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete research
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show web search analysis before presenting findings
- ⚠️ Present [C] continue option after customer behavior content generation
- 📝 WRITE CUSTOMER BEHAVIOR ANALYSIS TO DOCUMENT IMMEDIATELY
- 💾 ONLY proceed when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1, 2]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from step-01 are available
- Focus on customer behavior patterns and demographic analysis
- Web search capabilities with source verification are enabled
- Previous step confirmed research scope and goals
- **Research topic = "{{research_topic}}"** - established from initial discussion
- **Research goals = "{{research_goals}}"** - established from initial discussion

## YOUR TASK:

Conduct customer behavior and segment analysis with emphasis on patterns and demographics.

## CUSTOMER BEHAVIOR ANALYSIS SEQUENCE:

### 1. Begin Customer Behavior Analysis

**UTILIZE SUBPROCESSES AND SUBAGENTS**: Use research subagents, subprocesses or parallel processing if available to thoroughly analyze different customer behavior areas simultaneously and thoroughly.

Start with customer behavior research approach:
"Now I'll conduct **customer behavior analysis** for **{{research_topic}}** to understand customer patterns.

**Customer Behavior Focus:**

- Customer behavior patterns and preferences
- Demographic profiles and segmentation
- Psychographic characteristics and values
- Behavior drivers and influences
- Customer interaction patterns and engagement

**Let me search for current customer behavior insights.**"

### 2. Parallel Customer Behavior Research Execution

**Execute multiple web searches simultaneously:**

Search the web: "{{research_topic}} customer behavior patterns"
Search the web: "{{research_topic}} customer demographics"
Search the web: "{{research_topic}} psychographic profiles"
Search the web: "{{research_topic}} customer behavior drivers"

**Analysis approach:**

- Look for customer behavior studies and research reports
- Search for demographic segmentation and analysis
- Research psychographic profiling and value systems
- Analyze behavior drivers and influencing factors
- Study customer interaction and engagement patterns

### 3. Analyze and Aggregate Results

**Collect and analyze findings from all parallel searches:**

"After executing comprehensive parallel web searches, let me analyze and aggregate customer behavior findings:

**Research Coverage:**

- Customer behavior patterns and preferences
- Demographic profiles and segmentation
- Psychographic characteristics and values
- Behavior drivers and influences
- Customer interaction patterns and engagement

**Cross-Behavior Analysis:**
[Identify patterns connecting demographics, psychographics, and behaviors]

**Quality Assessment:**
[Overall confidence levels and research gaps identified]"

### 4. Generate Customer Behavior Content

**WRITE IMMEDIATELY TO DOCUMENT**

Prepare customer behavior analysis with web search citations:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## Customer Behavior and Segments

### Customer Behavior Patterns

[Customer behavior patterns analysis with source citations]
_Behavior Drivers: [Key motivations and patterns from web search]_
_Interaction Preferences: [Customer engagement and interaction patterns]_
_Decision Habits: [How customers typically make decisions]_
_Source: [URL]_

### Demographic Segmentation

[Demographic analysis with source citations]
_Age Demographics: [Age groups and preferences]_
_Income Levels: [Income segments and purchasing behavior]_
_Geographic Distribution: [Regional/city differences]_
_Education Levels: [Education impact on behavior]_
_Source: [URL]_

### Psychographic Profiles

[Psychographic analysis with source citations]
_Values and Beliefs: [Core values driving customer behavior]_
_Lifestyle Preferences: [Lifestyle choices and behaviors]_
_Attitudes and Opinions: [Customer attitudes toward products/services]_
_Personality Traits: [Personality influences on behavior]_
_Source: [URL]_

### Customer Segment Profiles

[Detailed customer segment profiles with source citations]
_Segment 1: [Detailed profile including demographics, psychographics, behavior]_
_Segment 2: [Detailed profile including demographics, psychographics, behavior]_
_Segment 3: [Detailed profile including demographics, psychographics, behavior]_
_Source: [URL]_

### Behavior Drivers and Influences

[Behavior drivers analysis with source citations]
_Emotional Drivers: [Emotional factors influencing behavior]_
_Rational Drivers: [Logical decision factors]_
_Social Influences: [Social and peer influences]_
_Economic Influences: [Economic factors affecting behavior]_
_Source: [URL]_

### Customer Interaction Patterns

[Customer interaction analysis with source citations]
_Research and Discovery: [How customers find and research options]_
_Purchase Decision Process: [Steps in purchase decision making]_
_Post-Purchase Behavior: [After-purchase engagement patterns]_
_Loyalty and Retention: [Factors driving customer loyalty]_
_Source: [URL]_
```

### 5. Present Analysis and Continue Option

**Show analysis and present continue option:**

"I've completed **customer behavior analysis** for {{research_topic}}, focusing on customer patterns.

**Key Customer Behavior Findings:**

- Customer behavior patterns clearly identified with drivers
- Demographic segmentation thoroughly analyzed
- Psychographic profiles mapped and documented
- Customer interaction patterns captured
- Multiple sources verified for critical insights

**Ready to proceed to customer pain points?**
[C] Continue - Save this to document and proceed to pain points analysis

### 6. Handle Continue Selection

#### If 'C' (Continue):

- **CONTENT ALREADY WRITTEN TO DOCUMENT**
- Update frontmatter: `stepsCompleted: [1, 2]`
- Load: `{project-root}/_bmad/bmm/workflows/1-analysis/research/market-steps/step-03-customer-pain-points.md`

## APPEND TO DOCUMENT:

Content is already written to document when generated in step 4. No additional append needed.

## SUCCESS METRICS:

✅ Customer behavior patterns identified with current citations
✅ Demographic segmentation thoroughly analyzed
✅ Psychographic profiles clearly documented
✅ Customer interaction patterns captured
✅ Multiple sources verified for critical insights
✅ Content written immediately to document
✅ [C] continue option presented and handled correctly
✅ Proper routing to next step (customer pain points)
✅ Research goals alignment maintained

## FAILURE MODES:

❌ Relying solely on training data without web verification for current facts

❌ Missing critical customer behavior patterns
❌ Incomplete demographic segmentation analysis
❌ Missing psychographic profile documentation
❌ Not writing content immediately to document
❌ Not presenting [C] continue option after content generation
❌ Not routing to customer pain points analysis step
❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor research decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## CUSTOMER BEHAVIOR RESEARCH PROTOCOLS:

- Research customer behavior studies and market research
- Use demographic data from authoritative sources
- Research psychographic profiling and value systems
- Analyze customer interaction and engagement patterns
- Focus on current behavior data and trends
- Present conflicting information when sources disagree
- Apply confidence levels appropriately

## BEHAVIOR ANALYSIS STANDARDS:

- Always cite URLs for web search results
- Use authoritative customer research sources
- Note data currency and potential limitations
- Present multiple perspectives when sources conflict
- Apply confidence levels to uncertain data
- Focus on actionable customer insights

## NEXT STEP:

After user selects 'C', load `{project-root}/_bmad/bmm/workflows/1-analysis/research/market-steps/step-03-customer-pain-points.md` to analyze customer pain points, challenges, and unmet needs for {{research_topic}}.

Remember: Always write research content to document immediately and emphasize current customer data with rigorous source verification!
