# Contributing to OpenClaw documentation

Thank you for helping improve OpenClaw's documentation. This guide covers how to contribute effectively.

## Quick start

1. Fork and clone the [openclaw/openclaw](https://github.com/openclaw/openclaw) repository
2. Navigate to the `/docs` directory
3. Make your changes
4. Install the Mintlify CLI: `npm install -g mint`
5. Run `mint dev` to preview your changes locally at `http://localhost:3000`
6. Submit a pull request
7. Resolve any failing CI checks or code review comments

## File formats

OpenClaw docs use both `.md` and `.mdx` files:

- **`.md`** — Standard Markdown for most documentation pages
- **`.mdx`** — MDX format when you need React components or dynamic content

Both formats require YAML frontmatter at the top of each file.

## Page requirements

Every documentation page needs frontmatter:

```yaml
---
title: "Clear, descriptive title"
summary: "Brief summary for search results and navigation"
read_when:
  - List of triggers for agents to read the specific page
  - (Example) You want to run or write .prose workflows
---
```

## Writing guidelines

### Voice and tone

- Use second person ("you") to address the reader directly
- Write in active voice
- Be concise — remove unnecessary words while maintaining clarity
- Avoid marketing language and superlatives

### Structure

- Lead with context — explain what something is before diving into steps
- Put prerequisites at the beginning of procedural content
- Break complex instructions into numbered steps
- Structure content with most commonly needed information first

### Formatting

- Use sentence case for headings ("Getting started", not "Getting Started")
- Add language tags to all code blocks
- Include alt text for images
- Use relative paths for internal links (`/install/docker`, not full URLs)
- Avoid em dashes and apostrophes in headings because they break anchor links

### Code examples

Keep examples simple and practical:

```bash
# Install OpenClaw globally
npm install -g openclaw
```

Always specify the language (`bash`, `javascript`, `json`, etc.).

## Using Mintlify components

MDX files can use [Mintlify components](https://mintlify.com/docs/components) for richer documentation:

````mdx
<Tabs>
  <Tab title="npm">```bash npm install -g openclaw ```</Tab>
  <Tab title="Docker">```bash docker pull openclaw/openclaw ```</Tab>
</Tabs>
````

Common components:

- `<Tabs>` — Show alternative approaches
- `<Steps>` — Sequential instructions
- `<Callout>` — Warnings, tips, and notes
- `<Card>` and `<Columns>` — Link collections

## Adding pages to navigation

After creating a new page, add it to `docs.json` (in this directory) in the appropriate navigation group:

```json
{
  "group": "Get started",
  "pages": ["index", "install/quickstart", "your-new-page"]
}
```

Page paths in `docs.json` omit the file extension.

## Images

Store images in the `/images` directory and reference them with absolute paths:

```markdown
![Descriptive alt text](/images/screenshot.png)
```

## Translations

Files in `zh-CN/` are generated. Only edit English content when contributing — do not modify `zh-CN/` files unless explicitly working on i18n. See `.i18n/README.md` for the translation workflow.

## Before submitting

- [ ] Preview changes locally with `mint dev`
- [ ] Run `mint broken-links` to check for broken internal links
- [ ] Verify code examples work as documented
- [ ] Check that new pages are added to `docs.json` navigation
- [ ] Confirm frontmatter includes title and summary

## Pull request process

1. Create a branch with a descriptive name (`fix/typo-in-quickstart`, `add/discord-setup-guide`)
2. Make focused changes — one topic per PR when possible
3. Write a clear PR description explaining what changed and why

## Quick Links

- **GitHub:** https://github.com/openclaw/openclaw
- **Discord:** https://discord.gg/qkhbAGHRBT
- **X/Twitter:** [@steipete](https://x.com/steipete) / [@openclaw](https://x.com/openclaw)
