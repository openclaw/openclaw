---
name: skillstore-plugin-publisher
description: "Publish plugins to SkillStore marketplace. Use when: (1) publishing a new plugin, (2) updating existing plugin, (3) generating cover images, (4) approving plugins for listing."
metadata: { "openclaw": { "emoji": "📦", "requires": { "bins": ["gh", "curl"] }, "install": [] } }
---

# SkillStore Plugin Publisher

Complete workflow for publishing plugins to SkillStore marketplace.

## When to Use

✅ **USE this skill when:**

- Publishing a new plugin to SkillStore
- Updating an existing plugin
- Generating cover images for plugins
- Approving plugins for public listing

## Workflow

### 1. Prepare Plugin

Ensure plugin has:

- Unique slug (e.g., `my-awesome-plugin`)
- Clear name and description
- At least 3 skills bundled
- Proper folder structure in marketplace repo

### 2. Generate Cover Image

**Using Gemini to generate cover image:**

1. Open Gemini: https://gemini.google.com/app
2. Request image generation with prompt describing plugin purpose
3. Use "Save image as" to download, or find actual image URL
4. Download to local: `curl -o cover.jpg <image_url>`

**Image requirements:**

- List view: 320×180 thumbnail
- Detail view: Original size (will be resized)
- Format: JPG or PNG

### 3. Upload Cover Image

```bash
# Upload to Supabase Storage or use skillstore API
# Update plugin record with coverImageUrl
```

### 4. Approve Plugin

```bash
# Via skillstore CLI or API
# Set review_status from 'pending_review' to 'approved'
```

### 5. Verify Publishing

```bash
# Check plugin appears in list
curl "https://skillstore.io/api/plugins?limit=20"

# Check plugin detail
curl "https://skillstore.io/api/plugins/<slug>"
```

## Key Commands

```bash
# Install skillstore CLI
npx -y skillstore plugin install <slug>

# Check plugin status
curl "https://skillstore.io/api/plugins/<slug>"

# List all plugins
curl "https://skillstore.io/api/plugins?type=top&limit=50"
```

## Troubleshooting

- **404 on plugin page**: Check if `review_status` is `approved`
- **Image distorted**: Use 320×180 for list, original for detail
- **Missing from list**: Ensure `visibility: public` and `review_status: approved`

## References

- SkillStore: https://skillstore.io
- Marketplace Repo: https://github.com/aiskillstore/marketplace
- Plugin Docs: https://docs.skillstore.io
