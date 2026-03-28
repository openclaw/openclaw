# Jira Cloud (plugin)

Adds a Jira Cloud skill bundle for issue triage, planning, and release follow-up.

## Install

```bash
openclaw plugins install @kansodata/jira-cloud
```

## Enable

```json
{
  "plugins": {
    "entries": {
      "jira-cloud": { "enabled": true }
    }
  }
}
```

Restart the gateway after enabling.

## What you get

- `jira-cloud` skill available to the agent
- Practical playbook for:
  - issue triage from raw bug reports
  - sprint planning from backlog state
  - release follow-up and verification checklist generation
