# Technical Research Step 1: Technical Research Scope Confirmation

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user confirmation

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ FOCUS EXCLUSIVELY on confirming technical research scope and approach
- 📋 YOU ARE A TECHNICAL RESEARCH PLANNER, not content generator
- 💬 ACKNOWLEDGE and CONFIRM understanding of technical research goals
- 🔍 This is SCOPE CONFIRMATION ONLY - no web research yet
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- ⚠️ Present [C] continue option after scope confirmation
- 💾 ONLY proceed when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Research type = "technical" is already set
- **Research topic = "{{research_topic}}"** - discovered from initial discussion
- **Research goals = "{{research_goals}}"** - captured from initial discussion
- Focus on technical architecture and implementation research
- Web search is required to verify and supplement your knowledge with current facts

## YOUR TASK:

Confirm technical research scope and approach for **{{research_topic}}** with the user's goals in mind.

## TECHNICAL SCOPE CONFIRMATION:

### 1. Begin Scope Confirmation

Start with technical scope understanding:
"I understand you want to conduct **technical research** for **{{research_topic}}** with these goals: {{research_goals}}

**Technical Research Scope:**

- **Architecture Analysis**: System design patterns, frameworks, and architectural decisions
- **Implementation Approaches**: Development methodologies, coding patterns, and best practices
- **Technology Stack**: Languages, frameworks, tools, and platforms relevant to {{research_topic}}
- **Integration Patterns**: APIs, communication protocols, and system interoperability
- **Performance Considerations**: Scalability, optimization, and performance patterns

**Research Approach:**

- Current web data with rigorous source verification
- Multi-source validation for critical technical claims
- Confidence levels for uncertain technical information
- Comprehensive technical coverage with architecture-specific insights

### 2. Scope Confirmation

Present clear scope confirmation:
"**Technical Research Scope Confirmation:**

For **{{research_topic}}**, I will research:

✅ **Architecture Analysis** - design patterns, frameworks, system architecture
✅ **Implementation Approaches** - development methodologies, coding patterns
✅ **Technology Stack** - languages, frameworks, tools, platforms
✅ **Integration Patterns** - APIs, protocols, interoperability
✅ **Performance Considerations** - scalability, optimization, patterns

**All claims verified against current public sources.**

**Does this technical research scope and approach align with your goals?**
[C] Continue - Begin technical research with this scope

### 3. Handle Continue Selection

#### If 'C' (Continue):

- Document scope confirmation in research file
- Update frontmatter: `stepsCompleted: [1]`
- Load: `{project-root}/_bmad/bmm/workflows/1-analysis/research/technical-steps/step-02-technical-overview.md`

## APPEND TO DOCUMENT:

When user selects 'C', append scope confirmation:

```markdown
## Technical Research Scope Confirmation

**Research Topic:** {{research_topic}}
**Research Goals:** {{research_goals}}

**Technical Research Scope:**

- Architecture Analysis - design patterns, frameworks, system architecture
- Implementation Approaches - development methodologies, coding patterns
- Technology Stack - languages, frameworks, tools, platforms
- Integration Patterns - APIs, protocols, interoperability
- Performance Considerations - scalability, optimization, patterns

**Research Methodology:**

- Current web data with rigorous source verification
- Multi-source validation for critical technical claims
- Confidence level framework for uncertain information
- Comprehensive technical coverage with architecture-specific insights

**Scope Confirmed:** {{date}}
```

## SUCCESS METRICS:

✅ Technical research scope clearly confirmed with user
✅ All technical analysis areas identified and explained
✅ Research methodology emphasized
✅ [C] continue option presented and handled correctly
✅ Scope confirmation documented when user proceeds
✅ Proper routing to next technical research step

## FAILURE MODES:

❌ Not clearly confirming technical research scope with user
❌ Missing critical technical analysis areas
❌ Not explaining that web search is required for current facts
❌ Not presenting [C] continue option
❌ Proceeding without user scope confirmation
❌ Not routing to next technical research step

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## NEXT STEP:

After user selects 'C', load `{project-root}/_bmad/bmm/workflows/1-analysis/research/technical-steps/step-02-technical-overview.md` to begin technology stack analysis.

Remember: This is SCOPE CONFIRMATION ONLY - no actual technical research yet, just confirming the research approach and scope!
