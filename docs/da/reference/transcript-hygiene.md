---
summary: "Reference: udbyderspecifik sanitering og reparationsregler for transskripter"
read_when:
  - Du fejlretter udbyderafvisninger af forespørgsler, der er knyttet til transskriptets form
  - Du ændrer sanitering af transskripter eller logik for reparation af tool-calls
  - Du undersøger mismatches af tool-call-id’er på tværs af udbydere
title: "Transskript-hygiejne"
---

# Transskript-hygiejne (Udbyderrettelser)

Dette dokument beskriver **udbyderspecifikke rettelser** anvendt på transkripter før en køre
(bygningsmodel kontekst). Disse er **in-memory** justeringer bruges til at opfylde strenge
udbyder krav. Disse hygiejnetrin gør **ikke** omskriv den gemte JSONL afskrift
på disk; Men en separat session-fil reparation pass kan omskrive misdannede JSONL filer
ved at droppe ugyldige linjer, før sessionen indlæses. Når en reparation sker, er den oprindelige
fil sikkerhedskopieret sammen med sessionsfilen.

Omfanget omfatter:

- Sanitering af tool-call-id’er
- Validering af tool-call-input
- Reparation af parring af tool-resultater
- Turvalidering / rækkefølge
- Oprydning af tanke-signaturer
- Sanitering af billedpayloads

Hvis du har brug for detaljer om lagring af transskripter, se:

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Hvor dette kører

Al transskript-hygiejne er centraliseret i den indlejrede runner:

- Politikvalg: `src/agents/transcript-policy.ts`
- Anvendelse af sanitering/reparation: `sanitizeSessionHistory` i `src/agents/pi-embedded-runner/google.ts`

Politikken bruger `provider`, `modelApi` og `modelId` til at afgøre, hvad der anvendes.

Adskilt fra transskript-hygiejne repareres sessionsfiler (om nødvendigt) før indlæsning:

- `repairSessionFileIfNeeded` i `src/agents/session-file-repair.ts`
- Kaldt fra `run/attempt.ts` og `compact.ts` (indlejret runner)

---

## Global regel: sanitering af billeder

Billednyttelast er altid desinficeret for at forhindre udbyder-side afvisning på grund af størrelse
grænser (downscale/genkomprimere overdimensionerede base64 billeder).

Implementering:

- `sanitizeSessionMessagesImages` i `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` i `src/agents/tool-images.ts`

---

## Global regel: fejldannede tool-calls

Assistent tool-call blokke, der mangler både `input` og `argumenter` er droppet
før model kontekst er bygget. Dette forhindrer udbyderafvisninger fra delvist
fortsatte værktøj opkald (for eksempel efter en sats grænse fejl).

Implementering:

- `sanitizeToolCallInputs` i `src/agents/session-transcript-repair.ts`
- Anvendt i `sanitizeSessionHistory` i `src/agents/pi-embedded-runner/google.ts`

---

## Udbydermatrix (aktuel adfærd)

**OpenAI / OpenAI Codex**

- Kun billedsanitering.
- Ved modelswitch til OpenAI Responses/Codex droppes forældreløse ræsonnement-signaturer (stående ræsonnement-elementer uden efterfølgende indholdsblok).
- Ingen sanitering af tool-call-id’er.
- Ingen reparation af parring af tool-resultater.
- Ingen turvalidering eller omrokering.
- Ingen syntetiske tool-resultater.
- Ingen stripping af tanke-signaturer.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Sanitering af tool-call-id’er: strengt alfanumerisk.
- Reparation af parring af tool-resultater og syntetiske tool-resultater.
- Turvalidering (Gemini-stil tur-alternation).
- Google-rækkefølgefix for ture (foranstil en minimal user-bootstrap, hvis historikken starter med assistant).
- Antigravity Claude: normaliser tanke-signaturer; drop usignerede tanke-blokke.

**Anthropic / Minimax (Anthropic-kompatibel)**

- Reparation af parring af tool-resultater og syntetiske tool-resultater.
- Turvalidering (flet på hinanden følgende user-ture for at opfylde streng alternation).

**Mistral (inklusive model-id-baseret detektion)**

- Sanitering af tool-call-id’er: strict9 (alfanumerisk længde 9).

**OpenRouter Gemini**

- Oprydning af tanke-signaturer: strip ikke-base64 `thought_signature`-værdier (behold base64).

**Alt andet**

- Kun billedsanitering.

---

## Historisk adfærd (før 2026.1.22)

Før udgivelsen 2026.1.22 anvendte OpenClaw flere lag af transskript-hygiejne:

- En **transcript-sanitize extension** kørte ved hver kontekstopbygning og kunne:
  - Reparere parring af tool-brug/-resultater.
  - Sanitere tool-call-id’er (inklusive en ikke-streng tilstand, der bevarede `_`/`-`).
- Runneren udførte også udbyderspecifik sanitering, hvilket duplikerede arbejde.
- Yderligere mutationer fandt sted uden for udbyderpolitikken, herunder:
  - Fjernelse af `<final>`-tags fra assistant-tekst før persistens.
  - Drop af tomme assistant-fejl-ture.
  - Trimning af assistant-indhold efter tool-calls.

Denne kompleksitet forårsagede regressioner på tværs af udbydere (især `openai-responses`
`call_idřfc_id` parring). Oprydningen af 2026.1.22 fjernede udvidelsen, centraliseret
logik i løberen, og gjorde OpenAI **no-touch** ud over billeddesinficering.
