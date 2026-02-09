---
summary: "Referentie: provider-specifieke transcript-sanitatie- en herstelregels"
read_when:
  - Je debugt provider-afwijzingen van requests die samenhangen met de vorm van het transcript
  - Je wijzigt transcript-sanitatie of logica voor het herstellen van tool-calls
  - Je onderzoekt mismatches van tool-call-id’s tussen providers
title: "Transcript-hygiëne"
---

# Transcript-hygiëne (Provider-fixups)

Dit document beschrijft **provider-specifieke fixes** die op transcripts worden toegepast vóór een run
(het opbouwen van modelcontext). Dit zijn **in-memory** aanpassingen die worden gebruikt om te voldoen
aan strikte providervereisten. Deze hygiënestappen herschrijven het opgeslagen JSONL-transcript op
schijf **niet**; een afzonderlijke herstelstap voor sessiebestanden kan echter misvormde JSONL-bestanden
herschrijven door ongeldige regels te verwijderen voordat de sessie wordt geladen. Wanneer een herstel
plaatsvindt, wordt het oorspronkelijke bestand naast het sessiebestand geback-upt.

De scope omvat:

- Sanitatie van tool-call-id’s
- Validatie van tool-call-invoer
- Herstel van koppeling van tool-resultaten
- Turn-validatie / -ordening
- Thought signature cleanup
- Sanitatie van afbeeldingspayloads

Als je details over transcriptopslag nodig hebt, zie:

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Waar dit wordt uitgevoerd

Alle transcript-hygiëne is gecentraliseerd in de embedded runner:

- Beleidsselectie: `src/agents/transcript-policy.ts`
- Toepassing van sanitatie/herstel: `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/google.ts`

Het beleid gebruikt `provider`, `modelApi` en `modelId` om te bepalen wat wordt toegepast.

Los van transcript-hygiëne worden sessiebestanden (indien nodig) hersteld vóór het laden:

- `repairSessionFileIfNeeded` in `src/agents/session-file-repair.ts`
- Aangeroepen vanuit `run/attempt.ts` en `compact.ts` (embedded runner)

---

## Globale regel: afbeeldingssanitatie

Afbeeldingspayloads worden altijd gesaniteerd om afwijzing aan de providerzijde te voorkomen vanwege
groottebeperkingen (verkleinen/hercomprimeren van te grote base64-afbeeldingen).

Implementatie:

- `sanitizeSessionMessagesImages` in `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` in `src/agents/tool-images.ts`

---

## Globale regel: misvormde tool-calls

Assistant-tool-callblokken die zowel `input` als `arguments` missen, worden verwijderd
voordat de modelcontext wordt opgebouwd. Dit voorkomt provider-afwijzingen door gedeeltelijk
persistente tool-calls (bijvoorbeeld na een rate-limit-fout).

Implementatie:

- `sanitizeToolCallInputs` in `src/agents/session-transcript-repair.ts`
- Toegepast in `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/google.ts`

---

## Provider-matrix (huidig gedrag)

**OpenAI / OpenAI Codex**

- Alleen afbeeldingssanitatie.
- Bij het wisselen van model naar OpenAI Responses/Codex: verwijder verweesde reasoning-signatures (losstaande reasoning-items zonder volgend contentblok).
- Geen sanitatie van tool-call-id’s.
- Geen herstel van koppeling van tool-resultaten.
- Geen turn-validatie of -herordening.
- Geen synthetische tool-resultaten.
- Geen thought signature stripping.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Sanitatie van tool-call-id’s: strikt alfanumeriek.
- Herstel van koppeling van tool-resultaten en synthetische tool-resultaten.
- Turn-validatie (Gemini-stijl turn-afwisseling).
- Google turn-ordering-fixup (voeg een minieme user-bootstrap toe als de geschiedenis met assistant begint).
- Antigravity Claude: normaliseer thinking-signatures; verwijder thinking-blokken zonder handtekening.

**Anthropic / Minimax (Anthropic-compatibel)**

- Herstel van koppeling van tool-resultaten en synthetische tool-resultaten.
- Turn-validatie (voeg opeenvolgende user-turns samen om aan strikte afwisseling te voldoen).

**Mistral (inclusief model-id-gebaseerde detectie)**

- Sanitatie van tool-call-id’s: strict9 (alfanumerieke lengte 9).

**OpenRouter Gemini**

- Thought signature cleanup: verwijder niet-base64 `thought_signature`-waarden (behoud base64).

**Alles overige**

- Alleen afbeeldingssanitatie.

---

## Historisch gedrag (pre-2026.1.22)

Vóór de release 2026.1.22 paste OpenClaw meerdere lagen transcript-hygiëne toe:

- Een **transcript-sanitize-extensie** draaide bij elke contextopbouw en kon:
  - Koppeling van tool-gebruik/resultaat herstellen.
  - Tool-call-id’s saneren (inclusief een niet-strikte modus die `_`/`-` behield).
- De runner voerde ook provider-specifieke sanitatie uit, wat werk dupliceerde.
- Extra mutaties vonden plaats buiten het providerbeleid, waaronder:
  - Het verwijderen van `<final>`-tags uit assistant-tekst vóór persistente opslag.
  - Het verwijderen van lege assistant-fout-turns.
  - Het afkappen van assistant-inhoud na tool-calls.

Deze complexiteit veroorzaakte regressies tussen providers (met name `openai-responses`
`call_id|fc_id`-koppeling). De opschoning in 2026.1.22 verwijderde de extensie, centraliseerde
de logica in de runner en maakte OpenAI **no-touch** buiten afbeeldingssanitatie.
