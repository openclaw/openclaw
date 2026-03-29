---
name: canva
version: 1.0.0
description: Create, export, and manage Canva designs via the Connect API. Generate social posts, carousels, and graphics programmatically.
homepage: https://github.com/abgohel/canva-skill
metadata:
  {
    "clawdbot":
      {
        "emoji": "🎨",
        "category": "design",
        "requires": { "env": ["CANVA_CLIENT_ID", "CANVA_CLIENT_SECRET"] },
      },
  }
---

# Canva Skill

Create, export, and manage Canva designs via the Connect API.

## When to Use

- "Create an Instagram post about [topic]"
- "Export my Canva design as PNG"
- "List my recent designs"
- "Create a carousel from these points"
- "Upload this image to Canva"

## Prerequisites

1. **Create a Canva Integration:**
   - Go to https://www.canva.com/developers/
   - Create a new integration
   - Get your Client ID and Client Secret

2. **Set Environment Variables:**

   ```bash
   export CANVA_CLIENT_ID="your_client_id"
   export CANVA_CLIENT_SECRET="your_client_secret"
   ```

3. **Authenticate (first time):**
   Run the auth flow to get access tokens (stored in `~/.canva/tokens.json`)

## API Base URL

```
https://api.canva.com/rest/v1
```

## Authentication

Canva uses OAuth 2.0. The skill handles token refresh automatically.

```bash
# Get access token (stored in ~/.canva/tokens.json)
ACCESS_TOKEN=$(cat ~/.canva/tokens.json | jq -r '.access_token')
```

## Core Operations

### List Designs

```bash
curl -s "https://api.canva.com/rest/v1/designs" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

### Get Design Details

```bash
curl -s "https://api.canva.com/rest/v1/designs/{designId}" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

### Create Design from Template

```bash
curl -X POST "https://api.canva.com/rest/v1/autofills" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "brand_template_id": "TEMPLATE_ID",
    "data": {
      "title": {"type": "text", "text": "Your Title"},
      "body": {"type": "text", "text": "Your body text"}
    }
  }'
```

### Export Design

```bash
# Start export job
curl -X POST "https://api.canva.com/rest/v1/exports" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "design_id": "DESIGN_ID",
    "format": {"type": "png", "width": 1080, "height": 1080}
  }'

# Check export status
curl -s "https://api.canva.com/rest/v1/exports/{jobId}" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

### Upload Asset

```bash
curl -X POST "https://api.canva.com/rest/v1/asset-uploads" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  -H 'Asset-Upload-Metadata: {"name": "my-image.png"}' \
  --data-binary @image.png
```

### List Brand Templates

```bash
curl -s "https://api.canva.com/rest/v1/brand-templates" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

## Export Formats

| Format | Options                        |
| ------ | ------------------------------ |
| PNG    | width, height, lossless        |
| JPG    | width, height, quality (1-100) |
| PDF    | standard, print                |
| MP4    | (for video designs)            |
| GIF    | (for animated designs)         |

## Common Workflows

### Create Instagram Post

1. List brand templates: `GET /brand-templates`
2. Find Instagram post template
3. Autofill with content: `POST /autofills`
4. Export as PNG 1080x1080: `POST /exports`
5. Download the exported file

### Create Carousel

1. Create multiple designs using autofill
2. Export each as PNG
3. Combine for posting

### Batch Export

1. List designs: `GET /designs`
2. Loop through and export each
3. Download all files

## Rate Limits

- Most endpoints: 100 requests/minute
- Upload/Export: 30 requests/minute

## Error Handling

Common errors:

- `401` - Token expired, refresh needed
- `403` - Missing required scope
- `429` - Rate limit exceeded
- `404` - Design/template not found

## Scopes Required

- `design:content:read` - Read designs
- `design:content:write` - Create/modify designs
- `asset:read` - Read assets
- `asset:write` - Upload assets
- `brandtemplate:content:read` - Read brand templates

## Tips

1. **Use Brand Templates** - Pre-designed templates are faster than creating from scratch
2. **Batch Operations** - Group exports to avoid rate limits
3. **Cache Template IDs** - Store commonly used template IDs locally
4. **Check Job Status** - Exports are async; poll until complete

## Resources

- [Canva Connect API Docs](https://www.canva.dev/docs/connect/)
- [OpenAPI Spec](https://www.canva.dev/sources/connect/api/latest/api.yml)
- [Starter Kit](https://github.com/canva-sdks/canva-connect-api-starter-kit)

---

Built by **Meow 😼** for the Moltbook community 🦞
