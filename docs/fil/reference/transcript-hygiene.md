---
summary: "Sanggunian: mga provider-specific na panuntunan para sa sanitization at pag-ayos ng transcript"
read_when:
  - Ikaw ay nagde-debug ng mga rejection ng provider request na may kaugnayan sa hugis ng transcript
  - Ikaw ay nagbabago ng transcript sanitization o lohika ng pag-ayos ng tool-call
  - Ikaw ay nag-iimbestiga ng mga mismatch ng tool-call id sa iba’t ibang provider
title: "Transcript Hygiene"
---

# Transcript Hygiene (Mga Fixup ng Provider)

Inilalarawan ng dokumentong ito ang **provider-specific fixes** na inilalapat sa mga transcript bago ang isang run
(pagbubuo ng model context). Ito ay mga **in-memory** na pagsasaayos na ginagamit upang matugunan ang mahigpit na
mga kinakailangan ng provider. Ang mga hakbang na ito sa hygiene ay **hindi** muling isinusulat ang naka-store na JSONL transcript
sa disk; gayunpaman, ang isang hiwalay na session-file repair pass ay maaaring muling magsulat ng mga malformed JSONL file
sa pamamagitan ng pag-drop ng mga invalid na linya bago i-load ang session. Kapag may naganap na repair, ang orihinal
na file ay bina-back up katabi ng session file.

Kasama sa saklaw ang:

- Sanitization ng tool call id
- Pagpapatunay ng input ng tool call
- Pag-ayos ng pagpapares ng tool result
- Pagpapatunay / pag-aayos ng pagkakasunod-sunod ng turn
- Paglilinis ng thought signature
- Sanitization ng image payload

Kung kailangan mo ng mga detalye tungkol sa pag-iimbak ng transcript, tingnan ang:

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Saan ito tumatakbo

Ang lahat ng transcript hygiene ay naka-sentro sa embedded runner:

- Pagpili ng policy: `src/agents/transcript-policy.ts`
- Paglalapat ng sanitization/repair: `sanitizeSessionHistory` sa `src/agents/pi-embedded-runner/google.ts`

Ginagamit ng policy ang `provider`, `modelApi`, at `modelId` para magpasya kung ano ang ilalapat.

Hiwalay sa transcript hygiene, inaayos ang mga session file (kung kinakailangan) bago i-load:

- `repairSessionFileIfNeeded` sa `src/agents/session-file-repair.ts`
- Tinatawag mula sa `run/attempt.ts` at `compact.ts` (embedded runner)

---

## Pandaigdigang panuntunan: sanitization ng image

Ang mga image payload ay palaging sini-sanitize para maiwasan ang provider-side rejection dahil sa mga limitasyon
sa laki (downscale/recompress ng sobrang laking base64 images).

Implementasyon:

- `sanitizeSessionMessagesImages` sa `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` sa `src/agents/tool-images.ts`

---

## Pandaigdigang panuntunan: malformed na tool calls

Ang mga assistant tool-call block na nawawala ang parehong `input` at `arguments` ay inaalis
bago buuin ang model context. Pinipigilan nito ang mga provider rejection mula sa bahagyang
na-persist na tool call (halimbawa, pagkatapos ng rate limit failure).

Implementasyon:

- `sanitizeToolCallInputs` sa `src/agents/session-transcript-repair.ts`
- Inilalapat sa `sanitizeSessionHistory` sa `src/agents/pi-embedded-runner/google.ts`

---

## Provider matrix (kasalukuyang gawi)

**OpenAI / OpenAI Codex**

- Image sanitization lamang.
- Kapag nag-switch ng model papunta sa OpenAI Responses/Codex, i-drop ang mga orphaned reasoning signature (mga standalone reasoning item na walang kasunod na content block).
- Walang sanitization ng tool call id.
- Walang pag-ayos ng pagpapares ng tool result.
- Walang pagpapatunay o reordering ng turn.
- Walang synthetic tool results.
- Walang pag-strip ng thought signature.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Sanitization ng tool call id: mahigpit na alphanumeric.
- Pag-ayos ng pagpapares ng tool result at mga synthetic tool results.
- Pagpapatunay ng turn (Gemini-style na alternation ng turn).
- Google turn ordering fixup (mag-prepend ng maliit na user bootstrap kung nagsisimula ang history sa assistant).
- Antigravity Claude: i-normalize ang thinking signatures; i-drop ang mga unsigned thinking block.

**Anthropic / Minimax (Anthropic-compatible)**

- Pag-ayos ng pagpapares ng tool result at mga synthetic tool results.
- Pagpapatunay ng turn (pagsamahin ang magkakasunod na user turn para matugunan ang mahigpit na alternation).

**Mistral (kasama ang model-id based detection)**

- Sanitization ng tool call id: strict9 (alphanumeric na haba na 9).

**OpenRouter Gemini**

- Paglilinis ng thought signature: i-strip ang mga non-base64 na halaga ng `thought_signature` (panatilihin ang base64).

**Lahat ng iba pa**

- Image sanitization lamang.

---

## Historikal na gawi (bago ang 2026.1.22)

Bago ang release na 2026.1.22, nag-apply ang OpenClaw ng maraming layer ng transcript hygiene:

- Isang **transcript-sanitize extension** ang tumatakbo sa bawat pagbuo ng context at maaaring:
  - Ayusin ang pagpapares ng tool use/result.
  - I-sanitize ang mga tool call id (kasama ang isang non-strict mode na nagpapanatili ng `_`/`-`).
- Ang runner ay nagsagawa rin ng provider-specific na sanitization, na nagdodoble ng trabaho.
- May mga karagdagang mutation na naganap sa labas ng provider policy, kabilang ang:
  - Pag-strip ng mga `<final>` tag mula sa assistant text bago i-persist.
  - Pag-drop ng mga empty assistant error turn.
  - Pag-trim ng assistant content pagkatapos ng mga tool call.

Ang komplikasyong ito ay nagdulot ng cross-provider regressions (lalo na ang `openai-responses`
`call_id|fc_id` pairing). Inalis ng 2026.1.22 cleanup ang extension, isinentro ang
logic sa runner, at ginawang **no-touch** ang OpenAI lampas sa image sanitization.
