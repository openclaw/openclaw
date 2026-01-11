---
name: vercel
description: Manage Vercel deployments, projects, and domains via CLI and API.
---

# Vercel

Control Vercel deployments, projects, domains, and environment variables.

## Setup
- **VERCEL_TOKEN**: API token (saved in clawdis.json)
- CLI: `npm install -g vercel` (optional, for local deploys)

## API Endpoints

Base URL: `https://api.vercel.com`

### Projects
```bash
# List projects
curl -s "https://api.vercel.com/v9/projects" \
  -H "Authorization: Bearer $VERCEL_TOKEN"

# Get project
curl -s "https://api.vercel.com/v9/projects/{projectId}" \
  -H "Authorization: Bearer $VERCEL_TOKEN"
```

### Deployments
```bash
# List deployments
curl -s "https://api.vercel.com/v6/deployments" \
  -H "Authorization: Bearer $VERCEL_TOKEN"

# Get deployment
curl -s "https://api.vercel.com/v13/deployments/{deploymentId}" \
  -H "Authorization: Bearer $VERCEL_TOKEN"

# Cancel deployment
curl -s -X PATCH "https://api.vercel.com/v12/deployments/{deploymentId}/cancel" \
  -H "Authorization: Bearer $VERCEL_TOKEN"
```

### Domains
```bash
# List domains
curl -s "https://api.vercel.com/v5/domains" \
  -H "Authorization: Bearer $VERCEL_TOKEN"
```

### Environment Variables
```bash
# List env vars for project
curl -s "https://api.vercel.com/v9/projects/{projectId}/env" \
  -H "Authorization: Bearer $VERCEL_TOKEN"

# Create env var
curl -s -X POST "https://api.vercel.com/v10/projects/{projectId}/env" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key": "VAR_NAME", "value": "value", "target": ["production", "preview"]}'
```

### Logs
```bash
# Get deployment logs
curl -s "https://api.vercel.com/v2/deployments/{deploymentId}/events" \
  -H "Authorization: Bearer $VERCEL_TOKEN"
```

## Common Tasks

- List all projects and their status
- Check recent deployments
- Redeploy a project
- Check deployment logs for errors
- Manage environment variables
