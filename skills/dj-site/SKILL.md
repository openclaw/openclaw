name: dj-site
description: Squarespace site management with draft-first publishing.
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "requires": { "features": ["browser"] },
        "commands":
          [
            { "name": "site draft-post", "description": "Create a new draft post" },
            { "name": "site update-draft", "description": "Update existing draft" },
            { "name": "site publish", "description": "Publish a draft (requires approval)" },
          ],
      },
  }
---

# dj-site

Squarespace site management with draft-first publishing workflow.

## Usage

```
/site draft-post <title> [template=episode|blog]
/site update-draft <draftId> <source>
/site publish <draftId>   # Always requires explicit approval
```

## Design Philosophy

**Draft-First**: Publishing is always approval-gated. You can create and update drafts freely, but going live requires explicit confirmation.

**Notion is Canonical**: Markdown content lives in Notion. Squarespace gets a formatted copy.

## How It Works

1. Create/edit content in Notion (canonical source)
2. Use `/site draft-post` or `/site update-draft` to push to Squarespace
3. Review draft in Squarespace editor
4. Use `/site publish` when ready (requires approval)

## Commands

### /site draft-post

Create a new draft post from a template.

```
/site draft-post "Episode 42: AI in Healthcare" template=episode
/site draft-post "New Blog Post Title" template=blog
```

**Templates**:
- `episode`: Podcast episode format with show notes structure
- `blog`: Standard blog post format

**Workflow**:
1. Navigate to Squarespace editor
2. Create new blog post (draft mode)
3. Apply template structure
4. Fill in title
5. Return draft ID for future reference

### /site update-draft

Update an existing draft with content from Notion.

```
/site update-draft draft-abc123 notion://page/xyz789
/site update-draft draft-abc123 "markdown content here"
```

**Workflow**:
1. Fetch content from Notion (or use provided markdown)
2. Convert to Squarespace-friendly format
3. Navigate to draft in Squarespace
4. Update content
5. Save draft (NOT publish)

### /site publish

Publish a draft to make it live. **Always requires approval.**

```
/site publish draft-abc123
```

**Workflow**:
1. Verify draft exists
2. Show preview summary
3. Request approval
4. On approval: Click publish
5. Confirm publication

## Action Classification

| Action | Class | Auto-Submit |
|--------|-------|-------------|
| Navigate to editor | READ_ONLY | N/A |
| Create draft | DRAFT | N/A |
| Update draft | DRAFT | N/A |
| Save draft | DRAFT | N/A |
| Publish | PUBLISH | ❌ Never |

**Critical**: Publish actions are ALWAYS `PUBLISH` class, which requires hard approval regardless of allowlist.

## Markdown → Squarespace Conversion

Simple, robust conversion:

### Supported Elements
- `# Heading 1` → H1
- `## Heading 2` → H2
- `### Heading 3` → H3
- `- Item` → Bullet list
- `1. Item` → Numbered list
- `[text](url)` → Link
- `**bold**` → Bold
- `*italic*` → Italic
- `> quote` → Blockquote
- ``` code ``` → Code block (if supported)

### Avoided Elements
- Complex HTML (fragile in Squarespace)
- Custom CSS (not portable)
- JavaScript embeds (security risk)

## Notion Integration

### Content Fetch

```typescript
// Fetch from Notion
const page = await notion.pages.retrieve({ page_id: notionPageId });
const blocks = await notion.blocks.children.list({ block_id: notionPageId });

// Convert to markdown
const markdown = convertNotionBlocksToMarkdown(blocks);
```

### Canonical Storage

Notion stores:
- Draft ID (from Squarespace)
- Last sync timestamp
- Publish status
- Original markdown

## Browser Automation

Uses `/web` infrastructure with these specifics:

### Login Handling

Squarespace login is always `AUTH` class (approval required).

```
⏸️ Squarespace login required
This session needs authentication.

To approve: /web approve auth-abc123
```

After login, session persists in browser profile.

### Draft Save Actions

Draft saves are `DRAFT` class, allowed without approval:
- Click "Save" button
- Auto-save triggers
- Draft title updates

### Publish Actions

Publish is `PUBLISH` class, ALWAYS requires approval:
- Click "Publish" button
- Click "Schedule" button
- Any action making content public

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `DJ_SQUARESPACE_SITE_URL` | - | Your Squarespace site URL |
| `DJ_SQUARESPACE_EDITOR_URL` | - | Editor URL (usually `/config/...`) |
| `DJ_NOTION_POSTS_DB` | - | Notion database for posts/episodes |
| `DJ_SITE_DEFAULT_TEMPLATE` | `blog` | Default template |

## Templates

### Episode Template

```markdown
# {title}

**Episode {number}** | **Released: {date}**

## Summary
{summary}

## Show Notes
{notes}

## Timestamps
- 00:00 - Intro
- {timestamps}

## Links & Resources
{links}

## Subscribe
{subscribe_links}
```

### Blog Template

```markdown
# {title}

{content}

---

*Published: {date}*
```

## Examples

### Create Episode Draft
```
/site draft-post "Episode 42: The Future of AI Regulation" template=episode
```
Output:
```
✅ Draft created
Draft ID: draft-ep42-abc123
Edit in Squarespace: https://yoursite.squarespace.com/config/...

Next: Update with content using:
/site update-draft draft-ep42-abc123 notion://page/xyz
```

### Update from Notion
```
/site update-draft draft-ep42-abc123 notion://page/abc123xyz
```
Output:
```
✅ Draft updated
- Fetched content from Notion
- Converted 15 blocks
- Updated Squarespace draft

Preview: https://yoursite.squarespace.com/config/.../draft-ep42-abc123
```

### Publish (with approval)
```
/site publish draft-ep42-abc123
```
Output:
```
⏸️ Approval required for PUBLISH action

Draft: "Episode 42: The Future of AI Regulation"
Status: Ready to publish
Preview: https://...

This will make the post publicly visible.

To approve: /web approve pub-xyz789
To cancel: (approval expires in 5 minutes)
```

After approval:
```
✅ Published!
Live URL: https://yoursite.com/blog/episode-42-ai-regulation
```

## Security Notes

1. **Login sessions**: Stored in browser profile, not in logs
2. **No auto-publish**: PUBLISH class cannot be auto-submitted
3. **Notion canonical**: Squarespace content can be regenerated from Notion
4. **Draft isolation**: Drafts are not publicly visible

## Troubleshooting

### Login Required
```
Error: Squarespace session expired

Fix: Run any /site command, approve login when prompted
```

### Draft Not Found
```
Error: Draft draft-abc123 not found

Fix: Verify draft ID, check if draft was deleted in Squarespace
```

### Publish Failed
```
Error: Publish button not found

Fix:
1. Verify draft is complete (no required fields missing)
2. Check Squarespace for validation errors
3. Try saving draft first
```

### Content Mismatch
```
Warning: Squarespace content differs from Notion

Fix: Run /site update-draft to resync from Notion
```

## Notes

- Browser automation uses existing profile (maintains login)
- All operations logged via `/web` infrastructure
- Publish is never allowed via auto-submit
- Deep mode not required for draft operations
