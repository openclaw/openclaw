# Domain Research Step 4: Regulatory Focus

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without web search verification

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ Search the web to verify and supplement your knowledge with current facts
- 📋 YOU ARE A REGULATORY ANALYST, not content generator
- 💬 FOCUS on compliance requirements and regulatory landscape
- 🔍 WEB SEARCH REQUIRED - verify current facts against live sources
- 📝 WRITE CONTENT IMMEDIATELY TO DOCUMENT
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show web search analysis before presenting findings
- ⚠️ Present [C] continue option after regulatory content generation
- 📝 WRITE REGULATORY ANALYSIS TO DOCUMENT IMMEDIATELY
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1, 2, 3, 4]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from previous steps are available
- **Research topic = "{{research_topic}}"** - established from initial discussion
- **Research goals = "{{research_goals}}"** - established from initial discussion
- Focus on regulatory and compliance requirements for the domain
- Web search capabilities with source verification are enabled

## YOUR TASK:

Conduct focused regulatory and compliance analysis with emphasis on requirements that impact {{research_topic}}. Search the web to verify and supplement current facts.

## REGULATORY FOCUS SEQUENCE:

### 1. Begin Regulatory Analysis

Start with regulatory research approach:
"Now I'll focus on **regulatory and compliance requirements** that impact **{{research_topic}}**.

**Regulatory Focus Areas:**

- Specific regulations and compliance frameworks
- Industry standards and best practices
- Licensing and certification requirements
- Data protection and privacy regulations
- Environmental and safety requirements

**Let me search for current regulatory requirements.**"

### 2. Web Search for Specific Regulations

Search for current regulatory information:
Search the web: "{{research_topic}} regulations compliance requirements"

**Regulatory focus:**

- Specific regulations applicable to the domain
- Compliance frameworks and standards
- Recent regulatory changes or updates
- Enforcement agencies and oversight bodies

### 3. Web Search for Industry Standards

Search for current industry standards:
Search the web: "{{research_topic}} standards best practices"

**Standards focus:**

- Industry-specific technical standards
- Best practices and guidelines
- Certification requirements
- Quality assurance frameworks

### 4. Web Search for Data Privacy Requirements

Search for current privacy regulations:
Search the web: "data privacy regulations {{research_topic}}"

**Privacy focus:**

- GDPR, CCPA, and other data protection laws
- Industry-specific privacy requirements
- Data governance and security standards
- User consent and data handling requirements

### 5. Generate Regulatory Analysis Content

Prepare regulatory content with source citations:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## Regulatory Requirements

### Applicable Regulations

[Specific regulations analysis with source citations]
_Source: [URL]_

### Industry Standards and Best Practices

[Industry standards analysis with source citations]
_Source: [URL]_

### Compliance Frameworks

[Compliance frameworks analysis with source citations]
_Source: [URL]_

### Data Protection and Privacy

[Privacy requirements analysis with source citations]
_Source: [URL]_

### Licensing and Certification

[Licensing requirements analysis with source citations]
_Source: [URL]_

### Implementation Considerations

[Practical implementation considerations with source citations]
_Source: [URL]_

### Risk Assessment

[Regulatory and compliance risk assessment]
```

### 6. Present Analysis and Continue Option

Show the generated regulatory analysis and present continue option:
"I've completed **regulatory requirements analysis** for {{research_topic}}.

**Key Regulatory Findings:**

- Specific regulations and frameworks identified
- Industry standards and best practices mapped
- Compliance requirements clearly documented
- Implementation considerations provided
- Risk assessment completed

**Ready to proceed to technical trends?**
[C] Continue - Save this to the document and move to technical trends

### 7. Handle Continue Selection

#### If 'C' (Continue):

- **CONTENT ALREADY WRITTEN TO DOCUMENT**
- Update frontmatter: `stepsCompleted: [1, 2, 3, 4]`
- Load: `{project-root}/_bmad/bmm/workflows/1-analysis/research/domain-steps/step-05-technical-trends.md`

## APPEND TO DOCUMENT:

Content is already written to document when generated in step 5. No additional append needed.

## SUCCESS METRICS:

✅ Applicable regulations identified with current citations
✅ Industry standards and best practices documented
✅ Compliance frameworks clearly mapped
✅ Data protection requirements analyzed
✅ Implementation considerations provided
✅ [C] continue option presented and handled correctly
✅ Content properly appended to document when C selected

## FAILURE MODES:

❌ Relying on training data instead of web search for current facts
❌ Missing critical regulatory requirements for the domain
❌ Not providing implementation considerations for compliance
❌ Not completing risk assessment for regulatory compliance
❌ Not presenting [C] continue option after content generation
❌ Appending content without user selecting 'C'

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## REGULATORY RESEARCH PROTOCOLS:

- Search for specific regulations by name and number
- Identify regulatory bodies and enforcement agencies
- Research recent regulatory changes and updates
- Map industry standards to regulatory requirements
- Consider regional and jurisdictional differences

## SOURCE VERIFICATION:

- Always cite regulatory agency websites
- Use official government and industry association sources
- Note effective dates and implementation timelines
- Present compliance requirement levels and obligations

## NEXT STEP:

After user selects 'C' and content is saved to document, load `{project-root}/_bmad/bmm/workflows/1-analysis/research/domain-steps/step-05-technical-trends.md` to analyze technical trends and innovations in the domain.

Remember: Search the web to verify regulatory facts and provide practical implementation considerations!
