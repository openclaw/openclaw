---
name: blink-figma
description: >
  Access Figma files, components, styles, dev resources, and comments. Use when
  asked to list design files, read frame details, check components, access design
  tokens, view comments, or read dev resources. Requires a linked Figma connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "figma" } }
---

# Blink Figma

Access the user's linked Figma account. Provider key: `figma`.

## Get my profile
```bash
blink connector exec figma me GET
```

## List team projects
```bash
blink connector exec figma teams/{team_id}/projects GET
```

## List files in a project
```bash
blink connector exec figma projects/{project_id}/files GET
```

## Get a file
```bash
blink connector exec figma files/{file_key} GET
```

## Get specific nodes from a file
```bash
blink connector exec figma "files/{file_key}/nodes?ids=1-2,3-4" GET
```

## Get file components
```bash
blink connector exec figma files/{file_key}/components GET
```

## Get file styles
```bash
blink connector exec figma files/{file_key}/styles GET
```

## Get file versions
```bash
blink connector exec figma files/{file_key}/versions GET
```

## Get comments on a file
```bash
blink connector exec figma files/{file_key}/comments GET
```

## Post a comment
```bash
blink connector exec figma files/{file_key}/comments POST '{"message":"Looks great!","client_meta":{"x":0,"y":0}}'
```

## Get dev resources on a file
```bash
blink connector exec figma files/{file_key}/dev_resources GET
```

## Get team component sets (design system)
```bash
blink connector exec figma teams/{team_id}/component_sets GET
```

## Get team styles
```bash
blink connector exec figma teams/{team_id}/styles GET
```

## Extracting a file key from a Figma URL
Given `https://www.figma.com/design/w9IEE8D9hn5loihyDJo1Zp/File-Name?node-id=1-2`:
- File key: `w9IEE8D9hn5loihyDJo1Zp`
- Node ID: `1-2`

## Common use cases
- "List all design files in our Figma project" → GET projects/{id}/files
- "What components are in the design system file?" → GET files/{key}/components
- "Get the color tokens from our styles" → GET files/{key}/styles
- "Check comments on file X" → GET files/{key}/comments
- "Add a comment to the login screen design" → POST files/{key}/comments
- "Show me a specific frame" → GET files/{key}/nodes?ids={node-id}
- "What dev resources are attached?" → GET files/{key}/dev_resources
