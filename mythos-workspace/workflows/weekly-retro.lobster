# Weekly Retrospective Workflow
# Generate weekly summary, lessons learned, and priorities

name: weekly-retrospective
version: "1.0.0"
description: Weekly retrospective and planning workflow

trigger:
  type: cron
  schedule: "0 18 * * 5"  # Friday 6:00 PM
  timezone: UTC

steps:
  - id: gather_week_activity
    agent: mythos-research
    prompt: |
      Gather all activity from this week:

      1. GitHub: PRs merged, issues closed, new issues opened
      2. Memory: Review daily logs from this week
      3. Calendar: Meetings attended, decisions made
      4. Communications: Key messages, discussions
      5. Deployments: What was deployed, any incidents

      Return comprehensive activity summary with metrics.
    depends_on: []
    tools: [web_search, web_fetch, memory_search, read]
    model: google/gemini-3-flash-preview

  - id: analyze_achievements
    agent: mythos-prime
    prompt: |
      Analyze this week's achievements:

      Activity: {{steps.gather_week_activity.output}}

      Identify:
      1. Major milestones completed
      2. Goals achieved
      3. Positive outcomes
      4. Team wins and contributions

      Quantify where possible (PRs merged, issues resolved, etc.)
    depends_on: [gather_week_activity]
    model: anthropic/claude-sonnet-4-6

  - id: analyze_challenges
    agent: mythos-prime
    prompt: |
      Analyze this week's challenges and blockers:

      Activity: {{steps.gather_week_activity.output}}

      Identify:
      1. Tasks that took longer than expected
      2. Blockers encountered
      3. Recurring issues or patterns
      4. Technical debt accumulated
      5. Process inefficiencies

      Be honest and constructive.
    depends_on: [gather_week_activity]
    model: anthropic/claude-sonnet-4-6

  - id: extract_lessons
    agent: mythos-prime
    prompt: |
      Extract lessons learned from this week:

      Achievements: {{steps.analyze_achievements.output}}
      Challenges: {{steps.analyze_challenges.output}}

      For each significant event:
      1. What happened?
      2. What went well?
      3. What could be improved?
      4. What will we do differently next time?

      Focus on actionable insights, not blame.
    depends_on: [analyze_achievements, analyze_challenges]
    model: anthropic/claude-opus-4-7

  - id: plan_next_week
    agent: mythos-prime
    prompt: |
      Plan priorities for next week:

      This Week: {{steps.gather_week_activity.output}}
      Lessons: {{steps.extract_lessons.output}}

      Identify:
      1. Carry-over tasks (incomplete from this week)
      2. New priorities (from recent decisions/requests)
      3. blockers to resolve
      4. Meetings/deadlines to prepare for
      5. Process improvements to implement

      Rank by priority and estimated effort.
    depends_on: [extract_lessons]
    model: anthropic/claude-opus-4-7

  - id: compile_retrospective
    agent: mythos-prime
    prompt: |
      Compile the weekly retrospective report:

      Activity: {{steps.gather_week_activity.output}}
      Achievements: {{steps.analyze_achievements.output}}
      Challenges: {{steps.analyze_challenges.output}}
      Lessons: {{steps.extract_lessons.output}}
      Next Week: {{steps.plan_next_week.output}}

      Format as:

      ## 📊 Weekly Retrospective — Week of {{date}}

      ### 🎯 Key Metrics
      [Quantitative summary: PRs, issues, deployments, etc.]

      ### ✅ Achievements
      [Major wins and completed work]

      ### ⚠️ Challenges
      [Blockers and difficulties encountered]

      ### 💡 Lessons Learned
      [Actionable insights for improvement]

      ### 📅 Next Week Priorities
      1. [Priority 1] — [Brief description]
      2. [Priority 2] — [Brief description]
      3. [Priority 3] — [Brief description]

      ### 🔄 Process Improvements
      [Changes to implement next week]

      Make it concise, scannable, and actionable.
    depends_on: [compile_retrospective]
    model: anthropic/claude-sonnet-4-6

  - id: deliver_retrospective
    agent: mythos-ops
    prompt: |
      Deliver the weekly retrospective:

      Report: {{steps.compile_retrospective.output}}

      Deliver to:
      - Telegram (main session)
      - Slack (#team)
      - Discord (#retrospectives)

      Also save to:
      - memory/weekly-retros/{{week}}.md
      - shared/wiki/retrospectives/{{week}}.md
    depends_on: [compile_retrospective]
    deliver:
      - telegram:prime
      - slack:team
      - discord:retrospectives
