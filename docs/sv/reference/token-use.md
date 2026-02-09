---
summary: "Hur OpenClaw bygger promptkontext och rapporterar tokenanvändning + kostnader"
read_when:
  - När du förklarar tokenanvändning, kostnader eller kontextfönster
  - Vid felsökning av kontexttillväxt eller kompakteringsbeteende
title: "Tokenanvändning och kostnader"
---

# Tokenanvändning och kostnader

OpenClaw spår **tokens**, inte tecken. Tokens är modellspecifika, men de flesta
OpenAI-stil modeller genomsnitt ~4 tecken per token för engelsk text.

## Hur systemprompten byggs

OpenClaw sammanställer sin egen systemprompt på varje körning. Den inkluderar:

- Verktygslista + korta beskrivningar
- Skills-lista (endast metadata; instruktioner laddas vid behov med `read`)
- Självuppdateringsinstruktioner
- Arbetsyta + bootstrap filer (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` när ny). Stora filer trunkeras av `agents.defaults.bootstrapMaxChars` (standard: 20000).
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

För en praktisk uppdelning (per injicerad fil, verktyg, färdigheter och systempromptstorlek), använd `/context list` eller `/context detail`. Se [Context](/concepts/context).

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
`cacheWrite`. Om prissättningen saknas, visar OpenClaw endast tokens OAuth tokens
visar aldrig dollarkostnaden.

## Cache-TTL och påverkan av rensning

Leverantörsprompten om cachelagring gäller endast i cachens TTL-fönster. OpenClaw kan
valfritt köra **cache-ttl beskärning**: det beskär sessionen när cachen TTL
har löpt ut, återställer sedan cachefönstret så att efterföljande förfrågningar kan återanvända
nyligen cachade sammanhang istället för att åter cacha hela historiken. Detta håller cache
skriva kostnader lägre när en session går vilande förbi TTL.

Konfigurera detta i [Gateway-konfiguration](/gateway/configuration) och se
beteendedetaljerna i [Session pruning](/concepts/session-pruning).

Heartbeat kan hålla cachen **varm** över tomgångar. Om din modellcache TTL
är `1h`, sätt hjärtslagsintervallet precis under det (e. ., '55m') kan undvika att
cachelagrar om den fulla snabbheten, vilket minskar kostnaderna för cachelagring.

För antropisk API-prissättning är cache-läsningar betydligt billigare än inmatning
-tokens, medan cacheskrivningar faktureras med en högre multiplikator. Se Anthropic’s
prompt caching prissättning för de senaste priserna och TTL-multiplikatorer:
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
