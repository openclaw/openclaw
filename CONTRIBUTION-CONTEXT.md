# OpenClaw Contribution Context

## Goal

Propose security fix for URL/link preview data exfiltration vulnerability.

## Background

- Reviewed PromptArmor article on LLM data exfiltration via URL previews
- WhatsApp lacks `linkPreview` config (unlike Telegram which has it)
- URLs in agent replies could theoretically exfiltrate context via preview fetches

## Research Done

- Searched existing issues/PRs: none found for "linkPreview", "link preview", "whatsapp", "exfiltration", "security"
- Risk assessment: MODERATE (mitigated by allowlist-only access)

## Proposed Fix Options

1. Add `linkPreview: false` support for WhatsApp channel config
2. Sanitize/warn on URLs in agent output that could trigger previews
3. Document the risk in security docs

## Next Steps

1. Examine WhatsApp channel implementation in `src/` or `extensions/`
2. Find where link preview behavior is controlled
3. Implement config option or sanitization
4. Create PR with security context

## Files to Explore

- `src/` - Core source
- `extensions/` - Channel plugins (likely where WhatsApp lives)
- `docs/` - Documentation

---

_Created: 2026-02-10_
