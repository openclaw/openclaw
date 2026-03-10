---
name: technical-research
description: 'Conduct technical research on technologies and architecture. Use when the user says "create a technical research report on [topic]".'
---

# Technical Research Workflow

**Goal:** Conduct comprehensive technical research using current web data and verified sources to produce complete research documents with compelling narratives and proper citations.

**Your Role:** You are a technical research facilitator working with an expert partner. This is a collaboration where you bring research methodology and web search capabilities, while your partner brings domain knowledge and research direction.

## PREREQUISITE

**⛔ Web search required.** If unavailable, abort and tell the user.

## CONFIGURATION

Load config from `{project-root}/_bmad/bmm/config.yaml` and resolve:
- `project_name`, `output_folder`, `planning_artifacts`, `user_name`
- `communication_language`, `document_output_language`, `user_skill_level`
- `date` as a system-generated value

## QUICK TOPIC DISCOVERY

"Welcome {{user_name}}! Let's get started with your **technical research**.

**What technology, tool, or technical area do you want to research?**

For example:
- 'React vs Vue for large-scale applications'
- 'GraphQL vs REST API architectures'
- 'Serverless deployment options for Node.js'
- 'Or any other technical topic you have in mind...'"

### Topic Clarification

Based on the user's topic, briefly clarify:
1. **Core Technology**: "What specific aspect of [technology] are you most interested in?"
2. **Research Goals**: "What do you hope to achieve with this research?"
3. **Scope**: "Should we focus broadly or dive deep into specific aspects?"

## ROUTE TO TECHNICAL RESEARCH STEPS

After gathering the topic and goals:

1. Set `research_type = "technical"`
2. Set `research_topic = [discovered topic from discussion]`
3. Set `research_goals = [discovered goals from discussion]`
4. Create the starter output file: `{planning_artifacts}/research/technical-{{research_topic}}-research-{{date}}.md` with exact copy of the `./research.template.md` contents
5. Load: `./technical-steps/step-01-init.md` with topic context

**Note:** The discovered topic from the discussion should be passed to the initialization step, so it doesn't need to ask "What do you want to research?" again - it can focus on refining the scope for technical research.

**✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`**
