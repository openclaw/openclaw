# Cron one-minute ping

```yaml qa-scenario
id: cron-one-minute-ping
title: Cron one-minute ping
surface: cron
objective: Verify the agent can schedule a cron reminder one minute in the future and receive the follow-up in the QA channel.
successCriteria:
  - Agent schedules a cron reminder roughly one minute ahead.
  - Reminder returns through qa-channel.
  - Agent recognizes the reminder as part of the original task.
docsRefs:
  - docs/help/testing.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-lab/src/bus-server.ts
  - extensions/qa-lab/src/self-check.ts
execution:
  kind: custom
  handler: cron-one-minute-ping
  summary: Verify the agent can schedule a cron reminder one minute in the future and receive the follow-up in the QA channel.
  config:
    channelId: qa-room
    channelTitle: QA Room
    reminderPromptTemplate: "A QA cron just fired. Send a one-line ping back to the room containing this exact marker: {{marker}}"
```
