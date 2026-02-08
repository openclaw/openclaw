---
summary: "Hur OpenClaw bygger promptkontext och rapporterar tokenanvändning + kostnader"
read_when:
  - När du förklarar tokenanvändning, kostnader eller kontextfönster
  - Vid felsökning av kontexttillväxt eller kompakteringsbeteende
title: "Tokenanvändning och kostnader"
x-i18n:
  source_path: reference/token-use.md
  source_hash: f8bfadb36b51830c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:33Z
---

# Tokenanvändning och kostnader

OpenClaw spårar **tokens**, inte tecken. Tokens är modellspecifika, men de flesta
OpenAI-liknande modeller ligger i genomsnitt på ~4 tecken per token för engelsk text.

## Hur systemprompten byggs

OpenClaw sammanställer sin egen systemprompt vid varje körning. Den innehåller:

- Verktygslista + korta beskrivningar
- Skills-lista (endast metadata; instruktioner laddas vid behov med `read`)
- Självuppdateringsinstruktioner
- Arbetsyta + bootstrap-filer (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` när nya). Stora filer trunkeras av `agents.defaults.bootstrapMaxChars` (standard: 20000).
- Tid (UTC + användarens tidszon)
- Svarstaggar + heartbeat-beteende
- Körtidsmetadata (värd/OS/modell/tänkande)

Se den fullständiga uppdelningen i [System Prompt](/concepts/system-prompt).

## Vad som räknas i kontextfönstret

Allt som modellen tar emot räknas mot kontextgränsen:

- Systemprompt (alla avsnitt listade ovan)
- Konversationshistorik (användar- + assistentmeddelanden)
- Verktygsanrop och verktygsresultat
- Bilagor/transkript (bilder, ljud, filer)
- Sammanfattningar från kompaktering och artefakter från rensning
- Leverantörsomslag eller säkerhetsrubriker (inte synliga, men räknas ändå)

För en praktisk uppdelning (per injicerad fil, verktyg, skills och systempromptens storlek), använd `/context list` eller `/context detail`. Se [Context](/concepts/context).

## Hur du ser aktuell tokenanvändning

Använd dessa i chatten:

- `/status` → **emoji‑rik statuskort** med sessionsmodell, kontextanvändning,
  senaste svarets in-/ut-token och **uppskattad kostnad** (endast API‑nyckel).
- `/usage off|tokens|full` → lägger till en **användningsfotnot per svar** till varje svar.
  - Består per session (lagras som `responseUsage`).
  - OAuth‑autentisering **döljer kostnad** (endast tokens).
- `/usage cost` → visar en lokal kostnadssammanfattning från OpenClaws sessionsloggar.

Andra gränssnitt:

- **TUI/Web TUI:** `/status` + `/usage` stöds.
- **CLI:** `openclaw status --usage` och `openclaw channels list` visar
  leverantörers kvotfönster (inte kostnader per svar).

## Kostnadsuppskattning (när den visas)

Kostnader uppskattas från din modellprissättningskonfig:

```
models.providers.<provider>.models[].cost
```

Dessa är **USD per 1M tokens** för `input`, `output`, `cacheRead` och
`cacheWrite`. Om prissättning saknas visar OpenClaw endast tokens. OAuth‑tokens
visar aldrig dollarkostnad.

## Cache-TTL och påverkan av rensning

Leverantörens promptcache gäller endast inom cache-TTL‑fönstret. OpenClaw kan
valfritt köra **cache-ttl-rensning**: den rensar sessionen när cache-TTL har löpt ut,
och återställer sedan cachefönstret så att efterföljande förfrågningar kan återanvända
den nyligen cachade kontexten i stället för att cacha om hela historiken. Detta håller
cache-skrivkostnaderna lägre när en session blir inaktiv efter TTL.

Konfigurera detta i [Gateway-konfiguration](/gateway/configuration) och se
beteendedetaljerna i [Session pruning](/concepts/session-pruning).

Heartbeat kan hålla cachen **varm** över inaktiva pauser. Om din modells cache-TTL
är `1h`, kan ett heartbeat‑intervall strax under detta (t.ex. `55m`) undvika
att hela prompten cachas om, vilket minskar cache-skrivkostnader.

För Anthropic API-prissättning är cache-läsningar betydligt billigare än inmatningstokens,
medan cache-skrivningar debiteras med en högre multiplikator. Se Anthropics
prissättning för promptcache för aktuella nivåer och TTL‑multiplikatorer:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Exempel: håll 1 h cache varm med heartbeat

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## Tips för att minska tokenbelastning

- Använd `/compact` för att sammanfatta långa sessioner.
- Trimma stora verktygsutdata i dina arbetsflöden.
- Håll skill‑beskrivningar korta (skill‑listan injiceras i prompten).
- Föredra mindre modeller för utforskande arbete med mycket text.

Se [Skills](/tools/skills) för den exakta formeln för overhead från skill‑listan.
