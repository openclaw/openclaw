---
summary: "Referens: leverantörsspecifika regler för sanering och reparation av transkript"
read_when:
  - Du felsöker avvisningar av leverantörsförfrågningar kopplade till transkriptets form
  - Du ändrar logik för sanering av transkript eller reparation av verktygsanrop
  - Du utreder mismatch av verktygsanrops-id mellan leverantörer
title: "Transkripthygien"
---

# Transkripthygien (leverantörsfixar)

Det här dokumentet beskriver **leverantörsspecifika rättelser** som tillämpas på avskrifter före en körning
(bygger modellkontext). Dessa är **in-memory** justeringar som används för att uppfylla strikta
leverantörskrav. Dessa hygiensteg skriver **inte** om den lagrade JSONL-avskriften
på disken; Dock kan en separat session-fil reparationspass skriva om felaktigt formatterade JSONL-filer
genom att släppa ogiltiga rader innan sessionen laddas. När en reparation sker, säkerhetskopieras den ursprungliga
filen tillsammans med sessionsfilen.

Omfattningen inkluderar:

- Sanering av verktygsanrops‑id
- Validering av indata för verktygsanrop
- Reparation av parning mellan verktygsanrop och verktygsresultat
- Validering/ordning av turer
- Rensning av tankesignaturer
- Sanering av bildpayloads

Om du behöver detaljer om lagring av transkript, se:

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Var detta körs

All transkripthygien är centraliserad i den inbäddade köraren:

- Policyval: `src/agents/transcript-policy.ts`
- Tillämpning av sanering/reparation: `sanitizeSessionHistory` i `src/agents/pi-embedded-runner/google.ts`

Policyn använder `provider`, `modelApi` och `modelId` för att avgöra vad som ska tillämpas.

Separat från transkripthygien repareras sessionsfiler (vid behov) före inläsning:

- `repairSessionFileIfNeeded` i `src/agents/session-file-repair.ts`
- Anropas från `run/attempt.ts` och `compact.ts` (inbäddad körar)

---

## Global regel: bildsanering

Bildpayloads saneras alltid för att förhindra avvisning på leverantörssidan på grund av storleksgränser
(nedskalning/omkomprimering av för stora base64‑bilder).

Implementering:

- `sanitizeSessionMessagesImages` i `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` i `src/agents/tool-images.ts`

---

## Global regel: felaktiga verktygsanrop

Assistant tool-call block som saknar både `input` och `arguments` släpps
innan modellkontext byggs. Detta förhindrar leverantörsavslag från delvis
ihållande verktygssamtal (till exempel efter ett hastighetsfel).

Implementering:

- `sanitizeToolCallInputs` i `src/agents/session-transcript-repair.ts`
- Tillämpas i `sanitizeSessionHistory` i `src/agents/pi-embedded-runner/google.ts`

---

## Leverantörsmatris (nuvarande beteende)

**OpenAI / OpenAI Codex**

- Endast bildsanering.
- Vid modellbyte till OpenAI Responses/Codex: ta bort föräldralösa resonemangssignaturer (fristående resonemangsobjekt utan efterföljande innehållsblock).
- Ingen sanering av verktygsanrops‑id.
- Ingen reparation av parning mellan verktygsresultat.
- Ingen turvalidering eller omordning.
- Inga syntetiska verktygsresultat.
- Ingen borttagning av tankesignaturer.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Sanering av verktygsanrops‑id: strikt alfanumeriskt.
- Reparation av parning mellan verktygsanrop och verktygsresultat samt syntetiska verktygsresultat.
- Turvalidering (Gemini‑stilad turväxling).
- Fix för Googles turordning (lägg till en mycket liten användar‑bootstrap om historiken börjar med assistenten).
- Antigravity Claude: normalisera tankesignaturer; ta bort osignerade tankeblock.

**Anthropic / Minimax (Anthropic‑kompatibel)**

- Reparation av parning mellan verktygsresultat och syntetiska verktygsresultat.
- Turvalidering (slå samman på varandra följande användarturer för att uppfylla strikt alternering).

**Mistral (inklusive detektion baserad på modell‑id)**

- Sanering av verktygsanrops‑id: strict9 (alfanumerisk längd 9).

**OpenRouter Gemini**

- Rensning av tankesignaturer: ta bort icke‑base64‑värden för `thought_signature` (behåll base64).

**Allt annat**

- Endast bildsanering.

---

## Historiskt beteende (före 2026.1.22)

Före version 2026.1.22 tillämpade OpenClaw flera lager av transkripthygien:

- Ett **transcript-sanitize‑tillägg** kördes vid varje kontextbyggnad och kunde:
  - Reparera parning mellan verktygsanvändning och verktygsresultat.
  - Sanera verktygsanrops‑id (inklusive ett icke‑strikt läge som bevarade `_`/`-`).
- Köraren utförde också leverantörsspecifik sanering, vilket duplicerade arbete.
- Ytterligare mutationer skedde utanför leverantörspolicyn, inklusive:
  - Borttagning av `<final>`‑taggar från assistenttext före persistens.
  - Borttagning av tomma assistent‑fel­turer.
  - Trimming av assistentens innehåll efter verktygsanrop.

Denna komplexitet orsakade cross-provider regressioner (särskilt `openai-responses`
`call_id<unk> fc_id` parning). 2026.1.22 rensningen tog bort tillägget, centraliserad
logik i löparen och gjorde OpenAI **no-touch** bortom bildsanering.
