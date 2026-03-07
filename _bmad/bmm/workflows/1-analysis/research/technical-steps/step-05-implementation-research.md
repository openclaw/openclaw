# Technical Research Step 5: Implementation Research

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without web search verification

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ Search the web to verify and supplement your knowledge with current facts
- 📋 YOU ARE AN IMPLEMENTATION ENGINEER, not content generator
- 💬 FOCUS on implementation approaches and technology adoption
- 🔍 WEB SEARCH REQUIRED - verify current facts against live sources
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show web search analysis before presenting findings
- ⚠️ Present [C] complete option after implementation research content generation
- 💾 ONLY save when user chooses C (Complete)
- 📖 Update frontmatter `stepsCompleted: [1, 2, 3, 4, 5]` before completing workflow
- 🚫 FORBIDDEN to complete workflow until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from previous steps are available
- Focus on implementation approaches and technology adoption strategies
- Web search capabilities with source verification are enabled
- This step prepares for the final synthesis step

## YOUR TASK:

Conduct comprehensive implementation research with emphasis on practical implementation approaches and technology adoption.

## IMPLEMENTATION RESEARCH SEQUENCE:

### 1. Begin Implementation Research

Start with implementation research approach:
"Now I'll complete our technical research with **implementation approaches and technology adoption** analysis.

**Implementation Research Focus:**

- Technology adoption strategies and migration patterns
- Development workflows and tooling ecosystems
- Testing, deployment, and operational practices
- Team organization and skill requirements
- Cost optimization and resource management

**Let me search for current implementation and adoption strategies.**"

### 2. Web Search for Technology Adoption

Search for current adoption strategies:
Search the web: "technology adoption strategies migration"

**Adoption focus:**

- Technology migration patterns and approaches
- Gradual adoption vs big bang strategies
- Legacy system modernization approaches
- Vendor evaluation and selection criteria

### 3. Web Search for Development Workflows

Search for current development practices:
Search the web: "software development workflows tooling"

**Workflow focus:**

- CI/CD pipelines and automation tools
- Code quality and review processes
- Testing strategies and frameworks
- Collaboration and communication tools

### 4. Web Search for Operational Excellence

Search for current operational practices:
Search the web: "DevOps operations best practices"

**Operations focus:**

- Monitoring and observability practices
- Incident response and disaster recovery
- Infrastructure as code and automation
- Security operations and compliance automation

### 5. Generate Implementation Research Content

Prepare implementation analysis with web search citations:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## Implementation Approaches and Technology Adoption

### Technology Adoption Strategies

[Technology adoption analysis with source citations]
_Source: [URL]_

### Development Workflows and Tooling

[Development workflows analysis with source citations]
_Source: [URL]_

### Testing and Quality Assurance

[Testing approaches analysis with source citations]
_Source: [URL]_

### Deployment and Operations Practices

[Deployment practices analysis with source citations]
_Source: [URL]_

### Team Organization and Skills

[Team organization analysis with source citations]
_Source: [URL]_

### Cost Optimization and Resource Management

[Cost optimization analysis with source citations]
_Source: [URL]_

### Risk Assessment and Mitigation

[Risk mitigation analysis with source citations]
_Source: [URL]_

## Technical Research Recommendations

### Implementation Roadmap

[Implementation roadmap recommendations]

### Technology Stack Recommendations

[Technology stack suggestions]

### Skill Development Requirements

[Skill development recommendations]

### Success Metrics and KPIs

[Success measurement framework]
```

### 6. Present Analysis and Continue Option

Show the generated implementation research and present continue option:
"I've completed the **implementation research and technology adoption** analysis for {{research_topic}}.

**Implementation Highlights:**

- Technology adoption strategies and migration patterns documented
- Development workflows and tooling ecosystems analyzed
- Testing, deployment, and operational practices mapped
- Team organization and skill requirements identified
- Cost optimization and resource management strategies provided

**Technical research phases completed:**

- Step 1: Research scope confirmation
- Step 2: Technology stack analysis
- Step 3: Integration patterns analysis
- Step 4: Architectural patterns analysis
- Step 5: Implementation research (current step)

**Ready to proceed to the final synthesis step?**
[C] Continue - Save this to document and proceed to synthesis

### 7. Handle Continue Selection

#### If 'C' (Continue):

- Append the final content to the research document
- Update frontmatter: `stepsCompleted: [1, 2, 3, 4, 5]`
- Load: `{project-root}/_bmad/bmm/workflows/1-analysis/research/technical-steps/step-06-research-synthesis.md`

## APPEND TO DOCUMENT:

When user selects 'C', append the content directly to the research document using the structure from step 5.

## SUCCESS METRICS:

✅ Technology adoption strategies identified with current citations
✅ Development workflows and tooling thoroughly analyzed
✅ Testing and deployment practices clearly documented
✅ Team organization and skill requirements mapped
✅ Cost optimization and risk mitigation strategies provided
✅ [C] continue option presented and handled correctly
✅ Content properly appended to document when C selected
✅ Proper routing to synthesis step (step-06)

## FAILURE MODES:

❌ Relying solely on training data without web verification for current facts

❌ Missing critical technology adoption strategies
❌ Not providing practical implementation guidance
❌ Incomplete development workflows or operational practices analysis
❌ Not presenting continue option to synthesis step
❌ Appending content without user selecting 'C'
❌ Not routing to step-06-research-synthesis.md

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## IMPLEMENTATION RESEARCH PROTOCOLS:

- Search for implementation case studies and success stories
- Research technology migration patterns and lessons learned
- Identify common implementation challenges and solutions
- Research development tooling ecosystem evaluations
- Analyze operational excellence frameworks and maturity models

## TECHNICAL RESEARCH WORKFLOW COMPLETION:

When 'C' is selected:

- Implementation research step completed
- Content appended to research document with source citations
- Frontmatter updated with stepsCompleted: [1, 2, 3, 4, 5]
- Ready to proceed to final synthesis step

## NEXT STEP:

After user selects 'C', load `{project-root}/_bmad/bmm/workflows/1-analysis/research/technical-steps/step-06-research-synthesis.md` to produce the comprehensive technical research document with narrative introduction, detailed TOC, and executive summary.
