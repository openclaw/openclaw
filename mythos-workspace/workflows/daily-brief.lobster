# Daily Intelligence Briefing Workflow
# Compiles and delivers daily intelligence report

name: daily-intelligence-briefing
version: "1.0.0"
description: Daily intelligence briefing from multiple sources

trigger:
  type: cron
  schedule: "0 7 * * *"  # 7:00 AM daily
  timezone: UTC

steps:
  - id: gather_technology_news
    agent: mythos-research
    prompt: |
      Gather today's technology news relevant to our projects:

      1. AI/ML developments (new models, papers, releases)
      2. Open source project updates (OpenClaw, related tools)
      3. Security advisories for our dependencies
      4. Industry trends and announcements

      Focus on actionable intelligence, not just headlines.
      Include source URLs for verification.
    depends_on: []
    tools: [web_search, web_fetch]
    model: google/gemini-3-flash-preview

  - id: gather_project_activity
    agent: mythos-research
    prompt: |
      Gather GitHub activity from the last 24 hours:

      1. New issues opened (count and summary)
      2. PRs merged (list with brief descriptions)
      3. PRs awaiting review (list with age)
      4. New releases published
      5. Notable community contributions

      Return structured summary with links.
    depends_on: []
    tools: [web_search, web_fetch]
    model: google/gemini-3-flash-preview

  - id: gather_calendar_events
    agent: mythos-research
    prompt: |
      List today's calendar events and meetings:

      1. Event name and time
      2. Attendees
      3. Purpose/agenda (if available)
      4. Preparation needed

      Flag any conflicts or tight scheduling.
    depends_on: []
    tools: [web_search]
    model: google/gemini-3-flash-preview

  - id: gather_messages
    agent: mythos-research
    prompt: |
      Check for important messages from the last 24 hours:

      1. Unread emails marked important or from key contacts
      2. Slack messages requiring attention
      3. Discord messages in #general or #announcements

      Summarize key messages that need response or action.
    depends_on: []
    tools: [web_search, web_fetch]
    model: google/gemini-3-flash-preview

  - id: compile_briefing
    agent: mythos-prime
    prompt: |
      Compile a concise daily intelligence briefing from all gathered information:

      Technology News: {{steps.gather_technology_news.output}}
      Project Activity: {{steps.gather_project_activity.output}}
      Calendar: {{steps.gather_calendar_events.output}}
      Messages: {{steps.gather_messages.output}}

      Format as:

      ## 🌅 Daily Brief — {{date}}

      ### 🔥 Priority Items
      [Top 3-5 most important items requiring attention]

      ### 📊 Project Status
      [Brief summary of project activity]

      ### 📅 Today's Calendar
      [List of today's events]

      ### 📧 Key Messages
      [Important messages requiring response]

      ### 🔒 Security Notes
      [Any security advisories or concerns]

      ### 💡 Recommendations
      [Actionable next steps for today]

      Keep it concise and scannable.
    depends_on: [gather_technology_news, gather_project_activity, gather_calendar_events, gather_messages]
    model: anthropic/claude-sonnet-4-6

  - id: deliver_briefing
    agent: mythos-ops
    prompt: |
      Deliver the daily briefing to all configured channels:

      Briefing: {{steps.compile_briefing.output}}

      Deliver to:
      - Telegram (main session)
      - Slack (#general)
      - Discord (#briefings)

      Format appropriately for each platform.
      Log delivery to daily memory file.
    depends_on: [compile_briefing]
    deliver:
      - telegram:prime
      - slack:general
      - discord:briefings
