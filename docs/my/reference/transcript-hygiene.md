---
summary: "ကိုးကားချက်: ပံ့ပိုးသူအလိုက် transcript သန့်စင်ခြင်းနှင့် ပြုပြင်ခြင်း စည်းမျဉ်းများ"
read_when:
  - Transcript ပုံသဏ္ဍာန်နှင့် ဆက်စပ်သော ပံ့ပိုးသူ၏ တောင်းဆိုချက် ငြင်းပယ်မှုများကို ချွတ်ယွင်းချက်ရှာဖွေနေစဉ်
  - Transcript သန့်စင်ခြင်း သို့မဟုတ် tool-call ပြုပြင်ရေး လိုဂျစ်ကို ပြောင်းလဲနေစဉ်
  - ပံ့ပိုးသူများအကြား tool-call id မကိုက်ညီမှုများကို စုံစမ်းနေစဉ်
title: "Transcript Hygiene"
---

# Transcript Hygiene (Provider Fixups)

This document describes **provider-specific fixes** applied to transcripts before a run
(building model context). These are **in-memory** adjustments used to satisfy strict
provider requirements. These hygiene steps do **not** rewrite the stored JSONL transcript
on disk; however, a separate session-file repair pass may rewrite malformed JSONL files
by dropping invalid lines before the session is loaded. When a repair occurs, the original
file is backed up alongside the session file.

အကျယ်အဝန်းတွင် ပါဝင်သည့်အရာများမှာ—

- Tool call id သန့်စင်ခြင်း
- Tool call input အတည်ပြုခြင်း
- Tool result ချိတ်ဆက်မှု ပြုပြင်ခြင်း
- Turn အတည်ပြုခြင်း / အစဉ်လိုက်စီစဉ်ခြင်း
- Thought signature သန့်ရှင်းရေး
- Image payload သန့်စင်ခြင်း

Transcript သိမ်းဆည်းမှု အသေးစိတ်များ လိုအပ်ပါက—

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Where this runs

All transcript hygiene is centralized in the embedded runner:

- Policy selection: `src/agents/transcript-policy.ts`
- Sanitization/repair application: `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/google.ts`

The policy uses `provider`, `modelApi`, and `modelId` to decide what to apply.

Policy သည် ဘာတွေကို အသုံးချမလဲ ဆုံးဖြတ်ရန် `provider`, `modelApi`, နှင့် `modelId` ကို အသုံးပြုသည်။

- `repairSessionFileIfNeeded` in `src/agents/session-file-repair.ts`
- Called from `run/attempt.ts` and `compact.ts` (embedded runner)

---

## Global rule: image sanitization

Image payloads are always sanitized to prevent provider-side rejection due to size
limits (downscale/recompress oversized base64 images).

Implementation:

- `sanitizeSessionMessagesImages` in `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` in `src/agents/tool-images.ts`

---

## Global rule: malformed tool calls

Assistant tool-call blocks that are missing both `input` and `arguments` are dropped
before model context is built. This prevents provider rejections from partially
persisted tool calls (for example, after a rate limit failure).

Implementation:

- `sanitizeToolCallInputs` in `src/agents/session-transcript-repair.ts`
- Applied in `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/google.ts`

---

## Provider matrix (current behavior)

**OpenAI / OpenAI Codex**

- Image sanitization only.
- On model switch into OpenAI Responses/Codex, drop orphaned reasoning signatures (standalone reasoning items without a following content block).
- No tool call id sanitization.
- No tool result pairing repair.
- No turn validation or reordering.
- No synthetic tool results.
- No thought signature stripping.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Tool call id sanitization: strict alphanumeric.
- Tool result pairing repair and synthetic tool results.
- Turn validation (Gemini-style turn alternation).
- Google turn ordering fixup (prepend a tiny user bootstrap if history starts with assistant).
- Antigravity Claude: normalize thinking signatures; drop unsigned thinking blocks.

**Anthropic / Minimax (Anthropic-compatible)**

- Tool result pairing repair and synthetic tool results.
- Turn validation (merge consecutive user turns to satisfy strict alternation).

**Mistral (including model-id based detection)**

- Tool call id sanitization: strict9 (alphanumeric length 9).

**OpenRouter Gemini**

- Thought signature cleanup: strip non-base64 `thought_signature` values (keep base64).

**Everything else**

- Image sanitization only.

---

## Historical behavior (pre-2026.1.22)

Before the 2026.1.22 release, OpenClaw applied multiple layers of transcript hygiene:

- A **transcript-sanitize extension** ran on every context build and could:
  - Repair tool use/result pairing.
  - Sanitize tool call ids (including a non-strict mode that preserved `_`/`-`).
- The runner also performed provider-specific sanitization, which duplicated work.
- Additional mutations occurred outside the provider policy, including:
  - Stripping `<final>` tags from assistant text before persistence.
  - Dropping empty assistant error turns.
  - Trimming assistant content after tool calls.

This complexity caused cross-provider regressions (notably `openai-responses`
`call_id|fc_id` pairing). 2026.1.22 cleanup တွင် extension ကို ဖယ်ရှားပြီး logic ကို runner တွင် စုစည်းကာ OpenAI ကို image sanitization အပြင် **no-touch** ဖြစ်စေခဲ့သည်။
