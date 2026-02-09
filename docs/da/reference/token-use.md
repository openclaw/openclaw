---
summary: "Sådan opbygger OpenClaw prompt-kontekst og rapporterer tokenforbrug + omkostninger"
read_when:
  - Forklaring af tokenforbrug, omkostninger eller kontekstvinduer
  - Fejlfinding af kontekstvækst eller komprimeringsadfærd
title: "Tokenforbrug og omkostninger"
---

# Tokenforbrug og omkostninger

OpenClaw spor \*\*tokens \*\*, ikke tegn. Tokens er model-specifikke, men de fleste
OpenAI-stil modeller gennemsnit ~4 tegn pr token for engelsk tekst.

## Sådan opbygges systemprompten

OpenClaw samler sin egen system prompt på hvert løb. Den omfatter:

- Værktøjsliste + korte beskrivelser
- Skills‑liste (kun metadata; instruktioner indlæses efter behov med `read`)
- Instruktioner til selvopdatering
- Arbejdsrum + bootstrap filer (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` når ny). Store filer afkortes af `agents.defaults.bootstrapMaxChars` (standard: 20000).
- Tid (UTC + brugerens tidszone)
- Svartags + heartbeat‑adfærd
- Runtime‑metadata (vært/OS/model/tænkning)

Se den fulde opdeling i [System Prompt](/concepts/system-prompt).

## Hvad tæller i kontekstvinduet

Alt, som modellen modtager, tæller med i kontekstgrænsen:

- Systemprompten (alle afsnit ovenfor)
- Samtalehistorik (bruger‑ og assistentbeskeder)
- Værktøjskald og værktøjsresultater
- Vedhæftninger/transskriptioner (billeder, lyd, filer)
- Komprimeringsresuméer og beskæringsartefakter
- Udbyder‑wrappere eller sikkerhedsheadere (ikke synlige, men tæller stadig)

For en praktisk opdeling (pr. injiceret fil, værktøjer, færdigheder og systemprompt størrelse), brug `/context list` eller `/context detail`. Se [Context](/concepts/context).

## Sådan ser du aktuelt tokenforbrug

Brug disse i chatten:

- `/status` → **emoji‑rig statuskort** med sessionsmodel, kontekstforbrug,
  input-/output‑tokens for seneste svar og **estimeret omkostning** (kun API‑nøgle).
- `/usage off|tokens|full` → tilføjer en **forbrugsfodnote pr. svar** til hvert svar.
  - Bevares pr. session (gemt som `responseUsage`).
  - OAuth‑autentificering **skjuler omkostning** (kun tokens).
- `/usage cost` → viser et lokalt omkostningsresumé fra OpenClaw‑sessionslogs.

Andre overflader:

- **TUI/Web TUI:** `/status` + `/usage` understøttes.
- **CLI:** `openclaw status --usage` og `openclaw channels list` viser
  udbyderens kvotevinduer (ikke omkostninger pr. svar).

## Omkostningsestimering (når vist)

Omkostninger estimeres ud fra din modelpriskonfiguration:

```
models.providers.<provider>.models[].cost
```

Disse er **USD pr. 1M tokens** for `input`, `output`, `cacheRead`, og
`cacheWrite`. Hvis prissætningen mangler, viser OpenClaw kun tokens. OAuth tokens
viser aldrig dollaromkostninger.

## Cache‑TTL og beskæringens betydning

Udbyderprompt caching gælder kun i cache TTL vinduet. OpenClaw kan
eventuelt køre **cache-ttl beskæring**: den beskærer sessionen, når cachen TTL
er udløbet, nulstiller derefter cache-vinduet, så efterfølgende anmodninger kan genbruge
frisk cachet kontekst i stedet for at cachelage den fulde historik. Dette holder cache
skrive omkostninger lavere, når en session går i tomgang forbi TTL.

Konfigurér det i [Gateway‑konfiguration](/gateway/configuration), og se
adfærdsdetaljerne i [Session pruning](/concepts/session-pruning).

Hjertebanken kan holde cachen **varm** på tværs af tomgangsknapper. Hvis din model cache TTL
er `1h`, indstilling af hjerteslag interval lige under den (f. eks. ., `55m`) kan undgå
re-caching den fulde prompt, hvilket reducerer cache-skriveomkostninger.

For Antropiske API-priser er cache-læsninger betydeligt billigere end input
-tokens, mens cache skriver faktureres ved en højere multiplikator. Se Anthropic's
prompt caching priser for de seneste satser og TTL multipliere:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Eksempel: hold 1t cache varm med heartbeat

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

## Tips til at reducere tokenpres

- Brug `/compact` til at opsummere lange sessioner.
- Trim store værktøjsoutputs i dine workflows.
- Hold Skills‑beskrivelser korte (Skills‑listen injiceres i prompten).
- Foretræk mindre modeller til ordrigt, eksplorativt arbejde.

Se [Skills](/tools/skills) for den præcise formel for overhead fra Skills‑listen.
