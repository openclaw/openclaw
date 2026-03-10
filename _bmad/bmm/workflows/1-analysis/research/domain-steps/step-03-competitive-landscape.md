# Domain Research Step 3: Competitive Landscape

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without web search verification

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ Search the web to verify and supplement your knowledge with current facts
- 📋 YOU ARE A COMPETITIVE ANALYST, not content generator
- 💬 FOCUS on key players, market share, and competitive dynamics
- 🔍 WEB SEARCH REQUIRED - verify current facts against live sources
- 📝 WRITE CONTENT IMMEDIATELY TO DOCUMENT
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show web search analysis before presenting findings
- ⚠️ Present [C] continue option after competitive analysis content generation
- 📝 WRITE COMPETITIVE ANALYSIS TO DOCUMENT IMMEDIATELY
- 💾 ONLY proceed when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1, 2, 3]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from previous steps are available
- **Research topic = "{{research_topic}}"** - established from initial discussion
- **Research goals = "{{research_goals}}"** - established from initial discussion
- Focus on key players, market share, and competitive dynamics
- Web search capabilities with source verification are enabled

## YOUR TASK:

Conduct competitive landscape analysis focusing on key players, market share, and competitive dynamics. Search the web to verify and supplement current facts.

## COMPETITIVE LANDSCAPE ANALYSIS SEQUENCE:

### 1. Begin Competitive Landscape Analysis

**UTILIZE SUBPROCESSES AND SUBAGENTS**: Use research subagents, subprocesses or parallel processing if available to thoroughly analyze different competitive areas simultaneously and thoroughly.

Start with competitive research approach:
"Now I'll conduct **competitive landscape analysis** for **{{research_topic}}** to understand the competitive ecosystem.

**Competitive Landscape Focus:**

- Key players and market leaders
- Market share and competitive positioning
- Competitive strategies and differentiation
- Business models and value propositions
- Entry barriers and competitive dynamics

**Let me search for current competitive insights.**"

### 2. Parallel Competitive Research Execution

**Execute multiple web searches simultaneously:**

Search the web: "{{research_topic}} key players market leaders"
Search the web: "{{research_topic}} market share competitive landscape"
Search the web: "{{research_topic}} competitive strategies differentiation"
Search the web: "{{research_topic}} entry barriers competitive dynamics"

**Analysis approach:**

- Look for recent competitive intelligence reports and market analyses
- Search for company websites, annual reports, and investor presentations
- Research market share data and competitive positioning
- Analyze competitive strategies and differentiation approaches
- Study entry barriers and competitive dynamics

### 3. Analyze and Aggregate Results

**Collect and analyze findings from all parallel searches:**

"After executing comprehensive parallel web searches, let me analyze and aggregate competitive findings:

**Research Coverage:**

- Key players and market leaders analysis
- Market share and competitive positioning assessment
- Competitive strategies and differentiation mapping
- Entry barriers and competitive dynamics evaluation

**Cross-Competitive Analysis:**
[Identify patterns connecting players, strategies, and market dynamics]

**Quality Assessment:**
[Overall confidence levels and research gaps identified]"

### 4. Generate Competitive Landscape Content

**WRITE IMMEDIATELY TO DOCUMENT**

Prepare competitive landscape analysis with web search citations:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## Competitive Landscape

### Key Players and Market Leaders

[Key players analysis with source citations]
_Market Leaders: [Dominant players and their market positions]_
_Major Competitors: [Significant competitors and their specialties]_
_Emerging Players: [New entrants and innovative companies]_
_Global vs Regional: [Geographic distribution of key players]_
_Source: [URL]_

### Market Share and Competitive Positioning

[Market share analysis with source citations]
_Market Share Distribution: [Current market share breakdown]_
_Competitive Positioning: [How players position themselves in the market]_
_Value Proposition Mapping: [Different value propositions across players]_
_Customer Segments Served: [Different customer bases by competitor]_
_Source: [URL]_

### Competitive Strategies and Differentiation

[Competitive strategies analysis with source citations]
_Cost Leadership Strategies: [Players competing on price and efficiency]_
_Differentiation Strategies: [Players competing on unique value]_
_Focus/Niche Strategies: [Players targeting specific segments]_
_Innovation Approaches: [How different players innovate]_
_Source: [URL]_

### Business Models and Value Propositions

[Business models analysis with source citations]
_Primary Business Models: [How competitors make money]_
_Revenue Streams: [Different approaches to monetization]_
_Value Chain Integration: [Vertical integration vs partnership models]_
_Customer Relationship Models: [How competitors build customer loyalty]_
_Source: [URL]_

### Competitive Dynamics and Entry Barriers

[Competitive dynamics analysis with source citations]
_Barriers to Entry: [Obstacles facing new market entrants]_
_Competitive Intensity: [Level of rivalry and competitive pressure]_
_Market Consolidation Trends: [M&A activity and market concentration]_
_Switching Costs: [Costs for customers to switch between providers]_
_Source: [URL]_

### Ecosystem and Partnership Analysis

[Ecosystem analysis with source citations]
_Supplier Relationships: [Key supplier partnerships and dependencies]_
_Distribution Channels: [How competitors reach customers]_
_Technology Partnerships: [Strategic technology alliances]_
_Ecosystem Control: [Who controls key parts of the value chain]_
_Source: [URL]_
```

### 5. Present Analysis and Continue Option

**Show analysis and present continue option:**

"I've completed **competitive landscape analysis** for {{research_topic}}.

**Key Competitive Findings:**

- Key players and market leaders thoroughly identified
- Market share and competitive positioning clearly mapped
- Competitive strategies and differentiation analyzed
- Business models and value propositions documented
- Competitive dynamics and entry barriers evaluated

**Ready to proceed to regulatory focus analysis?**
[C] Continue - Save this to document and proceed to regulatory focus

### 6. Handle Continue Selection

#### If 'C' (Continue):

- **CONTENT ALREADY WRITTEN TO DOCUMENT**
- Update frontmatter: `stepsCompleted: [1, 2, 3]`
- Load: `{project-root}/_bmad/bmm/workflows/1-analysis/research/domain-steps/step-04-regulatory-focus.md`

## APPEND TO DOCUMENT:

Content is already written to document when generated in step 4. No additional append needed.

## SUCCESS METRICS:

✅ Key players and market leaders thoroughly identified
✅ Market share and competitive positioning clearly mapped
✅ Competitive strategies and differentiation analyzed
✅ Business models and value propositions documented
✅ Competitive dynamics and entry barriers evaluated
✅ Content written immediately to document
✅ [C] continue option presented and handled correctly
✅ Proper routing to next step (regulatory focus)
✅ Research goals alignment maintained

## FAILURE MODES:

❌ Relying on training data instead of web search for current facts
❌ Missing critical key players or market leaders
❌ Incomplete market share or positioning analysis
❌ Not identifying competitive strategies
❌ Not writing content immediately to document
❌ Not presenting [C] continue option after content generation
❌ Not routing to regulatory focus step

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## COMPETITIVE RESEARCH PROTOCOLS:

- Research competitive intelligence reports and market analyses
- Use company websites, annual reports, and investor presentations
- Analyze market share data and competitive positioning
- Study competitive strategies and differentiation approaches
- Search the web to verify facts
- Present conflicting information when sources disagree
- Apply confidence levels appropriately

## COMPETITIVE ANALYSIS STANDARDS:

- Always cite URLs for web search results
- Use authoritative competitive intelligence sources
- Note data currency and potential limitations
- Present multiple perspectives when sources conflict
- Apply confidence levels to uncertain data
- Focus on actionable competitive insights

## NEXT STEP:

After user selects 'C', load `{project-root}/_bmad/bmm/workflows/1-analysis/research/domain-steps/step-04-regulatory-focus.md` to analyze regulatory requirements, compliance frameworks, and legal considerations for {{research_topic}}.

Remember: Always write research content to document immediately and search the web to verify facts!
