# GitHub Issue Triage Workflow
# Automatically classifies and responds to new GitHub issues

name: github-issue-triage
version: "1.0.0"
description: Automated GitHub issue triage and response workflow

trigger:
  type: webhook
  path: /plugins/webhooks/github-ci
  secret:
    source: env
    id: GITHUB_WEBHOOK_SECRET

steps:
  - id: classify
    agent: mythos-prime
    prompt: |
      Classify this GitHub issue:

      Title: {{payload.issue.title}}
      Body: {{payload.issue.body}}
      Labels: {{payload.issue.labels | map('name') | join(', ')}}
      Author: {{payload.issue.user.login}}

      Determine:
      - Type: bug / feature / question / documentation / spam
      - Priority: critical / high / medium / low
      - Complexity: simple / moderate / complex
      - Area: frontend / backend / infrastructure / docs / unknown

      Respond with JSON:
      {"type": "...", "priority": "...", "complexity": "...", "area": "..."}
    depends_on: []
    model: google/gemini-3-flash-preview

  - id: research_context
    agent: mythos-research
    prompt: |
      Research context for issue #{{payload.issue.number}}:

      1. Search for similar existing issues (potential duplicates)
      2. Find relevant code sections in the repository
      3. Check recent commits that might be related
      4. Look up any relevant documentation

      Focus on: {{steps.classify.output.area}}
      Priority: {{steps.classify.output.priority}}

      Return structured findings with source URLs.
    depends_on: [classify]
    tools: [web_search, web_fetch, memory_search, read]
    model: google/gemini-3-flash-preview

  - id: draft_response
    agent: mythos-code
    prompt: |
      Based on classification and research, draft an appropriate response:

      Issue: #{{payload.issue.number}}
      Classification: {{steps.classify.output}}
      Research: {{steps.research_context.output}}

      If bug:
        - Acknowledge the issue
        - Ask for reproduction steps if missing
        - Suggest potential fix if obvious

      If feature:
        - Acknowledge the request
        - Ask clarifying questions if needed
        - Note it for roadmap consideration

      If question:
        - Provide clear, helpful answer
        - Link to relevant documentation

      Keep response concise and professional.
    depends_on: [research_context]
    model: anthropic/claude-sonnet-4-6

  - id: review_response
    agent: mythos-critic
    prompt: |
      Review the drafted response for:

      1. Accuracy and helpfulness
      2. Tone appropriateness
      3. No leaked secrets or internal information
      4. Links are valid (if any)
      5. Follows project contribution guidelines

      Drafted response:
      {{steps.draft_response.output}}

      Approve, suggest edits, or reject with reasons.
    depends_on: [draft_response]
    model: anthropic/claude-sonnet-4-6

  - id: post_response
    agent: mythos-ops
    prompt: |
      Post the reviewed response to GitHub issue #{{payload.issue.number}}:

      Response: {{steps.draft_response.output}}
      Classification: {{steps.classify.output}}

      Actions:
      1. Post comment on the issue
      2. Apply appropriate labels based on classification
      3. If priority is high/critical, notify #eng-team on Slack
      4. Log action to daily memory file
    depends_on: [review_response]
    deliver:
      - github:comment
      - slack:eng-team  # only if priority is high/critical
