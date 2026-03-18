---
name: blink-figma
description: >
  Access Figma files, components, styles, and comments. Use when asked to list
  design files, read frame details, check components, access design tokens, or
  view comments. Requires a linked Figma connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "figma" } }
---

# Blink Figma

Access the user's linked Figma account. Provider key: `figma`.

## Get my files (recent)
```bash
bash scripts/call.sh /v1/me GET
```

## List team projects
```bash
bash scripts/call.sh /v1/teams/{team_id}/projects GET
```

## List files in a project
```bash
bash scripts/call.sh /v1/projects/{project_id}/files GET
```

## Get a file
```bash
bash scripts/call.sh /v1/files/{file_key} GET
```

## Get file components
```bash
bash scripts/call.sh /v1/files/{file_key}/components GET
```

## Get file styles
```bash
bash scripts/call.sh /v1/files/{file_key}/styles GET
```

## Get comments on a file
```bash
bash scripts/call.sh /v1/files/{file_key}/comments GET
```

## Post a comment
```bash
bash scripts/call.sh /v1/files/{file_key}/comments POST '{"message":"Looks great!","client_meta":{"x":0,"y":0}}'
```

## Common use cases
- "List all design files in our Figma project" → GET /projects/{id}/files
- "What components are in the design system file?" → GET /files/{key}/components
- "Get the color tokens from our styles" → GET /files/{key}/styles
- "Check comments on file X" → GET /files/{key}/comments
- "Add a comment to the login screen design" → POST /files/{key}/comments
