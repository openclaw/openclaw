---
summary: "Sådan opbygger OpenClaw prompt-kontekst og rapporterer tokenforbrug + omkostninger"
read_when:
  - Forklaring af tokenforbrug, omkostninger eller kontekstvinduer
  - Fejlfinding af kontekstvækst eller komprimeringsadfærd
title: "Tokenforbrug og omkostninger"
x-i18n:
  source_path: reference/token-use.md
  source_hash: f8bfadb36b51830c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:47Z
---

# Tokenforbrug og omkostninger

OpenClaw sporer **tokens**, ikke tegn. Tokens er modelspecifikke, men de fleste
OpenAI‑lignende modeller gennemsnitligt ~4 tegn pr. token for engelsk tekst.

## Sådan opbygges systemprompten

OpenClaw sammensætter sin egen systemprompt ved hver kørsel. Den indeholder:

- Værktøjsliste + korte beskrivelser
- Skills‑liste (kun metadata; instruktioner indlæses efter behov med `read`)
- Instruktioner til selvopdatering
- Workspace‑ og bootstrap‑filer (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` når nye). Store filer afkortes af `agents.defaults.bootstrapMaxChars` (standard: 20000).
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

For en praktisk opdeling (pr. injiceret fil, værktøjer, Skills og systempromptens størrelse), brug `/context list` eller `/context detail`. Se [Context](/concepts/context).

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

Disse er **USD pr. 1M tokens** for `input`, `output`, `cacheRead` og
`cacheWrite`. Hvis prissætning mangler, viser OpenClaw kun tokens. OAuth‑tokens
viser aldrig dollaromkostninger.

## Cache‑TTL og beskæringens betydning

Udbyderens prompt‑caching gælder kun inden for cache‑TTL‑vinduet. OpenClaw kan
valgfrit køre **cache‑ttl‑beskæring**: den beskærer sessionen, når cache‑TTL’en
er udløbet, og nulstiller derefter cache‑vinduet, så efterfølgende anmodninger kan genbruge den
nyligt cachede kontekst i stedet for at gen‑cache hele historikken. Det holder
cache‑skriveomkostningerne lavere, når en session går i tomgang ud over TTL’en.

Konfigurér det i [Gateway‑konfiguration](/gateway/configuration), og se
adfærdsdetaljerne i [Session pruning](/concepts/session-pruning).

Heartbeat kan holde cachen **varm** på tværs af tomgangsperioder. Hvis din models cache‑TTL
er `1h`, kan en indstilling af heartbeat‑intervallet lige under dette (f.eks. `55m`) undgå
gen‑caching af hele prompten og dermed reducere cache‑skriveomkostninger.

For Anthropic API‑prissætning er cache‑læsninger markant billigere end input‑tokens,
mens cache‑skrivninger faktureres med en højere multiplikator. Se Anthropics
prissætning for prompt‑caching for de seneste satser og TTL‑multiplikatorer:
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
