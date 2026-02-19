---
summary: "Autonomous enterprise workflows with safety guards and approval gates"
title: Autonomous Enterprise
read_when: "You want to build autonomous business operations with human-in-the-loop controls"
status: active
---

# Autonomous Enterprise

Autonomous Enterprise enables self-managing business workflows with safety guards and human-in-the-loop approval gates.

## Configuration

Enable in `~/.openclaw/openclaw.json`:

```json5
{
  enterprise: {
    enabled: true,
    approvalGates: {
      payments: true,
      userData: true,
      destructive: true,
    },
    safetyGuards: {
      payments: true,
      userData: true,
      destructive: true,
    },
  },
}
```

## See Also

- [News Aggregator documentation](/features/news-aggregator)
- [Content Ranking documentation](/features/content-ranking)
- [Society of Minds documentation](/features/society-of-minds)
