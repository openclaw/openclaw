---
name: blink-vercel
description: >
  Access Vercel deployments, projects, and domains. Use when asked to check
  deployment status, list projects, view build logs, or manage domains. Requires
  a linked Vercel connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "vercel" } }
---

# Blink Vercel

Access the user's linked Vercel account. Provider key: `vercel`.

## List projects
```bash
bash scripts/call.sh vercel /v9/projects GET '{"limit":20}'
```

## Get a project
```bash
bash scripts/call.sh vercel /v9/projects/{projectId} GET
```

## List deployments
```bash
bash scripts/call.sh vercel /v6/deployments GET '{"limit":10}'
```

## Get a specific deployment
```bash
bash scripts/call.sh vercel /v13/deployments/{id} GET
```

## Get deployment logs
```bash
bash scripts/call.sh vercel /v2/deployments/{id}/events GET
```

## List domains
```bash
bash scripts/call.sh vercel /v5/domains GET
```

## Get project domains
```bash
bash scripts/call.sh vercel /v9/projects/{projectId}/domains GET
```

## Get environment variables for a project
```bash
bash scripts/call.sh vercel /v9/projects/{projectId}/env GET
```

## Common use cases
- "What's the status of my latest deployment?" → GET /v6/deployments?limit=1
- "List all my Vercel projects" → GET /v9/projects
- "Check build logs for deployment X" → GET /v2/deployments/{id}/events
- "What domains are connected to project Y?" → GET /v9/projects/{id}/domains
- "Did the last deployment succeed?" → GET /v6/deployments, check readyState
