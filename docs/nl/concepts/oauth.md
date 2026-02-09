---
summary: "OAuth in OpenClaw: tokenuitwisseling, opslag en patronen voor meerdere accounts"
read_when:
  - Je wilt OAuth in OpenClaw van begin tot eind begrijpen
  - Je loopt tegen problemen aan met token-invalidatie / uitloggen
  - Je wilt setup-token- of OAuth-authenticatiestromen
  - Je wilt meerdere accounts of profilerouting
title: "OAuth"
---

# OAuth

OpenClaw ondersteunt “subscription auth” via OAuth voor providers die dit aanbieden (met name **OpenAI Codex (ChatGPT OAuth)**). Voor Anthropic-abonnementen gebruik je de **setup-token**-stroom. Deze pagina legt uit:

- hoe de OAuth **tokenuitwisseling** werkt (PKCE)
- waar tokens worden **opgeslagen** (en waarom)
- hoe je **meerdere accounts** afhandelt (profielen + per-sessie overrides)

OpenClaw ondersteunt ook **provider plugins** die hun eigen OAuth- of API‑sleutel-
stromen meeleveren. Start ze via:

```bash
openclaw models auth login --provider <id>
```

## De token sink (waarom die bestaat)

OAuth-providers geven vaak een **nieuwe refresh token** uit tijdens login-/refreshstromen. Sommige providers (of OAuth-clients) kunnen oudere refresh tokens ongeldig maken wanneer er een nieuwe wordt uitgegeven voor dezelfde gebruiker/app.

Praktisch symptoom:

- je logt in via OpenClaw _en_ via Claude Code / Codex CLI → één van beide raakt later willekeurig “uitgelogd”

Om dit te verminderen behandelt OpenClaw `auth-profiles.json` als een **token sink**:

- de runtime leest referenties uit **één plek**
- we kunnen meerdere profielen behouden en ze deterministisch routeren

## Opslag (waar tokens leven)

Secrets worden **per agent** opgeslagen:

- Auth-profielen (OAuth + API-sleutels): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Runtimecache (automatisch beheerd; niet bewerken): `~/.openclaw/agents/<agentId>/agent/auth.json`

Legacy import-only bestand (nog steeds ondersteund, maar niet de hoofdopslag):

- `~/.openclaw/credentials/oauth.json` (geïmporteerd in `auth-profiles.json` bij eerste gebruik)

Al het bovenstaande respecteert ook `$OPENCLAW_STATE_DIR` (override van de state-dir). Volledige referentie: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (subscription auth)

Voer `claude setup-token` uit op een willekeurige machine en plak het daarna in OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Als je de token elders hebt gegenereerd, plak deze dan handmatig:

```bash
openclaw models auth paste-token --provider anthropic
```

Verifiëren:

```bash
openclaw models status
```

## OAuth-uitwisseling (hoe inloggen werkt)

De interactieve loginstromen van OpenClaw zijn geïmplementeerd in `@mariozechner/pi-ai` en gekoppeld aan de wizards/opdrachten.

### Anthropic (Claude Pro/Max) setup-token

Stroom vorm:

1. voer `claude setup-token` uit
2. plak de token in OpenClaw
3. opslaan als een token-authprofiel (geen refresh)

Het wizardpad is `openclaw onboard` → auth-keuze `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Vorm van de stroom (PKCE):

1. genereer PKCE verifier/challenge + willekeurige `state`
2. open `https://auth.openai.com/oauth/authorize?...`
3. probeer de callback te onderscheppen op `http://127.0.0.1:1455/auth/callback`
4. als de callback niet kan binden (of je werkt remote/headless), plak de redirect-URL/code
5. uitwisselen bij `https://auth.openai.com/oauth/token`
6. extraheer `accountId` uit de access token en sla `{ access, refresh, expires, accountId }` op

Het wizardpad is `openclaw onboard` → auth-keuze `openai-codex`.

## Refresh + vervaldatum

Profielen slaan een `expires`-tijdstempel op.

Tijdens runtime:

- als `expires` in de toekomst ligt → gebruik de opgeslagen access token
- als deze is verlopen → refresh (onder een file lock) en overschrijf de opgeslagen referenties

De refresh-stroom is automatisch; je hoeft tokens doorgaans niet handmatig te beheren.

## Meerdere accounts (profielen) + routering

Twee patronen:

### 1. Voorkeur: gescheiden agents

Als je wilt dat “persoonlijk” en “werk” nooit met elkaar interacteren, gebruik geïsoleerde agents (gescheiden sessies + referenties + werkruimte):

```bash
openclaw agents add work
openclaw agents add personal
```

Configureer vervolgens auth per agent (wizard) en routeer chats naar de juiste agent.

### 2. Geavanceerd: meerdere profielen in één agent

`auth-profiles.json` ondersteunt meerdere profiel-ID’s voor dezelfde provider.

Kies welk profiel wordt gebruikt:

- globaal via config-volgorde (`auth.order`)
- per sessie via `/model ...@<profileId>`

Voorbeeld (sessie-override):

- `/model Opus@anthropic:work`

Zo zie je welke profiel-ID’s bestaan:

- `openclaw channels list --json` (toont `auth[]`)

Gerelateerde documentatie:

- [/concepts/model-failover](/concepts/model-failover) (rotatie + cooldown-regels)
- [/tools/slash-commands](/tools/slash-commands) (command surface)
