# Documentation Linking (Mintlify)

Docs hosted at: **docs.molt.bot**

## Internal Links (docs/**/*.md)
- Root-relative paths, no `.md`/`.mdx` extension
- Example: `[Config](/configuration)`

## Section Cross-References
- Use anchors on root-relative paths
- Example: `[Hooks](/configuration#hooks)`

## Headings
- Avoid em dashes and apostrophes in headings (breaks Mintlify anchors)

## External Links (README, replies)
- Use full URLs: `https://docs.molt.bot/...`
- GitHub README needs absolute URLs

## When Answering Questions
- Reply with full `https://docs.molt.bot/...` URLs (not root-relative)
- End replies with URLs you referenced

## Content Guidelines
- Must be generic: no personal device names/hostnames/paths
- Use placeholders: `user@gateway-host`, "gateway host"
