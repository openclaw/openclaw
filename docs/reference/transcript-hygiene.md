---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Reference: provider-specific transcript sanitization and repair rules"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are debugging provider request rejections tied to transcript shape（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are changing transcript sanitization or tool-call repair logic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are investigating tool-call id mismatches across providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Transcript Hygiene"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Transcript Hygiene (Provider Fixups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document describes **provider-specific fixes** applied to transcripts before a run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(building model context). These are **in-memory** adjustments used to satisfy strict（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
provider requirements. These hygiene steps do **not** rewrite the stored JSONL transcript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
on disk; however, a separate session-file repair pass may rewrite malformed JSONL files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
by dropping invalid lines before the session is loaded. When a repair occurs, the original（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
file is backed up alongside the session file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Scope includes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool call id sanitization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool call input validation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool result pairing repair（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Turn validation / ordering（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Thought signature cleanup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Image payload sanitization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need transcript storage details, see:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/reference/session-management-compaction](/reference/session-management-compaction)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where this runs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All transcript hygiene is centralized in the embedded runner:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Policy selection: `src/agents/transcript-policy.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sanitization/repair application: `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/google.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The policy uses `provider`, `modelApi`, and `modelId` to decide what to apply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Separate from transcript hygiene, session files are repaired (if needed) before load:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `repairSessionFileIfNeeded` in `src/agents/session-file-repair.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Called from `run/attempt.ts` and `compact.ts` (embedded runner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Global rule: image sanitization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Image payloads are always sanitized to prevent provider-side rejection due to size（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
limits (downscale/recompress oversized base64 images).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Implementation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sanitizeSessionMessagesImages` in `src/agents/pi-embedded-helpers/images.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sanitizeContentBlocksImages` in `src/agents/tool-images.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Global rule: malformed tool calls（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Assistant tool-call blocks that are missing both `input` and `arguments` are dropped（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
before model context is built. This prevents provider rejections from partially（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
persisted tool calls (for example, after a rate limit failure).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Implementation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sanitizeToolCallInputs` in `src/agents/session-transcript-repair.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Applied in `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/google.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Provider matrix (current behavior)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**OpenAI / OpenAI Codex**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Image sanitization only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On model switch into OpenAI Responses/Codex, drop orphaned reasoning signatures (standalone reasoning items without a following content block).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No tool call id sanitization.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No tool result pairing repair.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No turn validation or reordering.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No synthetic tool results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No thought signature stripping.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Google (Generative AI / Gemini CLI / Antigravity)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool call id sanitization: strict alphanumeric.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool result pairing repair and synthetic tool results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Turn validation (Gemini-style turn alternation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Google turn ordering fixup (prepend a tiny user bootstrap if history starts with assistant).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Antigravity Claude: normalize thinking signatures; drop unsigned thinking blocks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Anthropic / Minimax (Anthropic-compatible)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool result pairing repair and synthetic tool results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Turn validation (merge consecutive user turns to satisfy strict alternation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Mistral (including model-id based detection)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool call id sanitization: strict9 (alphanumeric length 9).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**OpenRouter Gemini**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Thought signature cleanup: strip non-base64 `thought_signature` values (keep base64).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Everything else**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Image sanitization only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Historical behavior (pre-2026.1.22)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Before the 2026.1.22 release, OpenClaw applied multiple layers of transcript hygiene:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A **transcript-sanitize extension** ran on every context build and could:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Repair tool use/result pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Sanitize tool call ids (including a non-strict mode that preserved `_`/`-`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The runner also performed provider-specific sanitization, which duplicated work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Additional mutations occurred outside the provider policy, including:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Stripping `<final>` tags from assistant text before persistence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Dropping empty assistant error turns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Trimming assistant content after tool calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This complexity caused cross-provider regressions (notably `openai-responses`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`call_id|fc_id` pairing). The 2026.1.22 cleanup removed the extension, centralized（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
logic in the runner, and made OpenAI **no-touch** beyond image sanitization.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
