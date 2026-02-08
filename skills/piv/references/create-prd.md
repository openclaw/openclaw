# Create PRD: Generate Product Requirements Document

## Overview

Generate a comprehensive Product Requirements Document (PRD) based on the current conversation context and requirements discussed. Use the structure and sections defined below to create a thorough, professional PRD.

## Output File

Write the PRD to: `$ARGUMENTS` (default: `PRD.md`)

## PRD Structure

Create a well-structured PRD with the following sections. Adapt depth and detail based on discovery answers and available information:

### Required Sections

**1. Executive Summary**
- Concise product overview (2-3 paragraphs)
- Core value proposition
- MVP goal statement

**2. Mission**
- Product mission statement
- Core principles (3-5 key principles)

**3. Target Users**
- Primary user personas
- Technical comfort level
- Key user needs and pain points

**4. MVP Scope**
- **In Scope:** Core functionality for MVP
- **Out of Scope:** Features deferred to future phases
- Group by categories (Core Functionality, Technical, Integration, Deployment)

**5. User Stories**
- Primary user stories (5-8 stories) in format: "As a [user], I want to [action], so that [benefit]"
- Include concrete examples for each story
- Add technical user stories if relevant

**6. Core Architecture & Patterns**
- High-level architecture approach
- Directory structure (if applicable)
- Key design patterns and principles
- Technology-specific patterns

**7. Tools/Features**
- Detailed feature specifications
- If building an agent: Tool designs with purpose, operations, and key features
- If building an app: Core feature breakdown

**8. Technology Stack**
- Backend/Frontend technologies with versions
- Dependencies and libraries
- Optional dependencies
- Third-party integrations

**9. Security & Configuration**
- Authentication/authorization approach
- Configuration management (environment variables, settings)
- Security scope (in-scope and out-of-scope)
- Deployment considerations

**10. API Specification** (if applicable)
- Endpoint definitions
- Request/response formats
- Authentication requirements
- Example payloads

**11. Success Criteria**
- MVP success definition
- Functional requirements
- Quality indicators
- User experience goals

**12. Implementation Phases**
- Break down into 3-4 phases
- Each phase includes: Goal, Deliverables, Validation criteria
- Realistic timeline estimates

**13. Future Considerations**
- Post-MVP enhancements
- Integration opportunities
- Advanced features for later phases

**14. Risks & Mitigations**
- 3-5 key risks with specific mitigation strategies

**15. Appendix** (if applicable)
- Related documents
- Key dependencies with links
- Repository/project structure

## Discovery Phase (Before Writing)

Before generating the PRD, gather key information through quick discovery questions.
If the user hasn't provided enough context, ask:

### Required Discovery
1. **What are you building?** Quick description of the product/feature.
2. **What model/platform are you using?** (e.g., Kimi K2.5, Claude Opus, OpenAI o3, GPT-5.2, local model)
   - This determines context window limits and sub-agent sizing
3. **What's the target tech stack?** Languages, frameworks, key libraries.
4. **Any existing codebase?** If yes, what's the repo/path?

### Optional Discovery (ask if unclear)
5. **Who are the users?** Target audience description.
6. **What does "done" look like?** 1-3 success criteria.
7. **What's explicitly OUT of scope?** Features to defer.

### Model Context Awareness
Record the model and its context window in the PRD metadata:
- Kimi K2.5: 131K tokens
- Claude Opus/Sonnet: 200K tokens
- OpenAI o3/GPT-5.2: varies
- Local models: check config

This info propagates to PRP generation and sub-agent prompt sizing.

## Instructions

### 1. Extract Requirements
- Review the entire conversation history
- Identify explicit requirements and implicit needs
- Note technical constraints and preferences
- Capture user goals and success criteria

### 2. Synthesize Information
- Organize requirements into appropriate sections
- Fill in reasonable assumptions where details are missing
- Maintain consistency across sections
- Ensure technical feasibility

### 3. Write the PRD
- Use clear, professional language
- Include concrete examples and specifics
- Use markdown formatting (headings, lists, code blocks, checkboxes)
- Add code snippets for technical sections where helpful
- Keep Executive Summary concise but comprehensive

### 4. Quality Checks
- All required sections present
- User stories have clear benefits
- MVP scope is realistic and well-defined
- Technology choices are justified
- Implementation phases are actionable
- Success criteria are measurable
- Consistent terminology throughout

## Style Guidelines

- **Tone:** Professional, clear, action-oriented
- **Format:** Use markdown extensively (headings, lists, code blocks, tables)
- **Specificity:** Prefer concrete examples over abstract descriptions
- **Length:** Comprehensive but scannable

## Output Confirmation

After creating the PRD:
1. Confirm the file path where it was written
2. Provide a brief summary of the PRD contents
3. Highlight any assumptions made due to missing information
4. Suggest next steps (e.g., review, refinement, planning)

## Notes

- Ask discovery questions if the user starts with minimal context — don't assume
- If critical information is missing, ask clarifying questions before generating
- Adapt section depth based on available details
- For highly technical products, emphasize architecture and technical stack
- For user-facing products, emphasize user stories and experience
- This command contains the complete PRD template structure - no external references needed
