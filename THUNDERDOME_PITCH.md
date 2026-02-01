# PR Thunderdome Pitch

## The Pitch (Copy-Paste Ready)

---

**PR**: `web4-governance-complete`

Agents acting autonomously at scale and no way to answer "what did it do and why?"

This adds audit + policy gates using your existing hooks. No core changes.

- `before_tool_call` → log intent, check policy, block if needed
- `after_tool_call` → log result, update chain

You get: searchable audit trail, tamper-evident hash chain, configurable policy presets (permissive/strict/audit-only).

75+ tests passing. Opt-in. Already running on another runtime.

---

## Notes

- ~50 words. Scannable in 10 seconds.
- Focus on general scaling problem, not specific projects
- Shows it uses THEIR hooks (not invasive)
- "Already running" = proven, not theoretical
