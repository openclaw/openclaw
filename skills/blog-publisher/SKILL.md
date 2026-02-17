---
name: blog-publisher
description: Publish blog posts automatically to static site generators (Hugo, Jekyll, Astro, Next.js, Ghost, WordPress). Use when the user wants to write, format, and publish a blog post, create a new article, or push content to a blog platform. Also triggers for "publish this as a blog post", "write a blog about X", or "post this to my blog".
metadata:
  {
    "openclaw":
      { "emoji": "📝", "requires": { "anyBins": ["hugo", "jekyll", "npx", "gh", "curl"] } },
  }
---

# Blog Publisher

Automate blog post creation and publishing across static site generators and CMS platforms.

## Supported Platforms

| Platform      | Detection                      | Publish Method           |
| ------------- | ------------------------------ | ------------------------ |
| **Hugo**      | `hugo.toml` / `config.toml`    | `hugo new` + git push    |
| **Jekyll**    | `_config.yml` + `_posts/`      | Create in `_posts/`      |
| **Astro**     | `astro.config.*`               | Create in `src/content/` |
| **Next.js**   | `next.config.*` + content dir  | Create in content dir    |
| **Ghost**     | Ghost Admin API URL configured | REST API publish         |
| **WordPress** | WP REST API URL configured     | REST API publish         |

## Workflow

### 1. Detect blog platform

```bash
# Auto-detect from project files
ls hugo.toml config.toml _config.yml astro.config.* next.config.* 2>/dev/null
```

### 2. Generate post content

Create frontmatter appropriate for the platform:

**Hugo/Jekyll/Astro:**

```yaml
---
title: "Post Title"
date: 2026-02-17T12:00:00Z
description: "Brief summary"
tags: ["tag1", "tag2"]
draft: false
---
```

**Ghost/WordPress (API):**

```json
{
  "posts": [
    {
      "title": "Post Title",
      "html": "<p>Content here</p>",
      "status": "published",
      "tags": [{ "name": "tag1" }]
    }
  ]
}
```

### 3. Publish

**Static site (Hugo/Jekyll/Astro/Next.js):**

```bash
# Create the post file in the correct directory
# Hugo: content/posts/YYYY-MM-DD-slug.md
# Jekyll: _posts/YYYY-MM-DD-slug.md
# Astro: src/content/blog/slug.md

# Build to verify
hugo build  # or jekyll build, npx astro build

# Deploy via git
git add . && git commit -m "blog: add post - <title>" && git push
```

**Ghost API:**

```bash
# Requires GHOST_API_URL and GHOST_ADMIN_API_KEY
scripts/publish-ghost.sh --title "Title" --content "content.md" --tags "tag1,tag2"
```

**WordPress REST API:**

```bash
# Requires WP_API_URL and WP_APP_PASSWORD
scripts/publish-wp.sh --title "Title" --content "content.md" --status "publish"
```

### 4. Verify

```bash
# Check deployment status
git log --oneline -1
# Or check API response for CMS platforms
```

## Scripts

- `scripts/publish.sh` - Universal blog publisher with auto-detection
- `scripts/publish-ghost.sh` - Publish to Ghost via Admin API
- `scripts/publish-wp.sh` - Publish to WordPress via REST API

### Universal Publish Script

```bash
# Auto-detect platform and publish
scripts/publish.sh --title "My Post" --content content.md

# With tags and custom slug
scripts/publish.sh --title "My Post" --content content.md --tags "ai,agents" --slug "my-custom-slug"

# Publish as draft
scripts/publish.sh --title "My Post" --content content.md --draft

# Specify blog directory
scripts/publish.sh --title "My Post" --content content.md --dir ~/my-blog
```

The script auto-detects Hugo, Jekyll, Astro, Next.js, Ghost, and WordPress. For static sites, it creates the post file, builds, commits, and pushes.

## Tips

- Always build locally before pushing to catch frontmatter errors
- Use `draft: true` first if unsure, then flip to `false` and republish
- For Ghost/WordPress, store API keys in environment variables, never in post content
- When the user says "blog about X", generate the content AND publish it
- Support images by placing them in the platform's static/assets directory
