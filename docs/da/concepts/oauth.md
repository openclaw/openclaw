---
summary: "OAuth i OpenClaw: tokenudveksling, lagring og mønstre for flere konti"
read_when:
  - Du vil forstå OpenClaw OAuth fra ende til ende
  - Du støder på problemer med token-ugyldiggørelse / logout
  - Du vil bruge setup-token eller OAuth-godkendelsesflows
  - Du vil have flere konti eller profil-routing
title: "OAuth"
---

# OAuth

OpenClaw understøtter “abonnement auth” via OAuth for udbydere, der tilbyder det (især **OpenAI Codex (ChatGPT OAuth)**). For antropiske abonnementer skal du bruge **setup-token** flowet. Denne side forklarer:

- hvordan OAuth **tokenudveksling** fungerer (PKCE)
- hvor tokens **lagres** (og hvorfor)
- hvordan du håndterer **flere konti** (profiler + overrides pr. session)

OpenClaw understøtter også **udbyder plugins**, der sender deres egne OAuth eller API-key
strømme. Kør dem via:

```bash
openclaw models auth login --provider <id>
```

## Token-sinken (hvorfor den findes)

OAuth udbydere ofte mynte en **ny opdateringstoken** under login/refresh flows. Nogle udbydere (eller OAuth klienter) kan ugyldiggøre ældre opdaterings-tokens når en ny bliver udstedt for den samme bruger/app.

Praktisk symptom:

- du logger ind via OpenClaw _og_ via Claude Code / Codex CLI → en af dem bliver tilfældigt “logget ud” senere

For at reducere dette behandler OpenClaw `auth-profiles.json` som en **token-sink**:

- runtime læser legitimationsoplysninger fra **ét sted**
- vi kan beholde flere profiler og route dem deterministisk

## Lagring (hvor tokens ligger)

Hemmeligheder gemmes **per-agent**:

- Auth-profiler (OAuth + API-nøgler): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Runtime-cache (administreres automatisk; redigér ikke): `~/.openclaw/agents/<agentId>/agent/auth.json`

Legacy import-only-fil (stadig understøttet, men ikke hovedlageret):

- `~/.openclaw/credentials/oauth.json` (importeret til `auth-profiles.json` ved første brug)

Alle ovenstående også respektere `$OPENCLAW_STATE_DIR` (stat dir override). Fuld reference: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (subscription auth)

Kør `claude setup-token` på en vilkårlig maskine, og indsæt det derefter i OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Hvis du genererede tokenet et andet sted, indsæt det manuelt:

```bash
openclaw models auth paste-token --provider anthropic
```

Verificér:

```bash
openclaw models status
```

## OAuth-udveksling (sådan virker login)

OpenClaws interaktive login-flows er implementeret i `@mariozechner/pi-ai` og koblet til guider/kommandoer.

### Anthropic (Claude Pro/Max) setup-token

Flowets form:

1. kør `claude setup-token`
2. indsæt tokenet i OpenClaw
3. gem som en token-auth-profil (ingen refresh)

Guide-stien er `openclaw onboard` → auth-valg `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Flowets form (PKCE):

1. generér PKCE-verifier/challenge + tilfældig `state`
2. åbn `https://auth.openai.com/oauth/authorize?...`
3. forsøg at opfange callback på `http://127.0.0.1:1455/auth/callback`
4. hvis callback ikke kan binde (eller du er remote/headless), indsæt redirect-URL/kode
5. udveksl ved `https://auth.openai.com/oauth/token`
6. udtræk `accountId` fra access-tokenet og gem `{ access, refresh, expires, accountId }`

Guide-stien er `openclaw onboard` → auth-valg `openai-codex`.

## Refresh + udløb

Profiler gemmer et `expires`-tidsstempel.

Ved runtime:

- hvis `expires` er i fremtiden → brug det gemte access-token
- hvis udløbet → refresh (under en fillås) og overskriv de gemte legitimationsoplysninger

Refresh-flowet er automatisk; du behøver som regel ikke at håndtere tokens manuelt.

## Flere konti (profiler) + routing

To mønstre:

### 1. Foretrukken: separate agenter

Hvis du vil have, at “personligt” og “arbejde” aldrig interagerer, så brug isolerede agenter (separate sessioner + legitimationsoplysninger + workspace):

```bash
openclaw agents add work
openclaw agents add personal
```

Konfigurér derefter auth pr. agent (guide) og route chats til den rigtige agent.

### 2. Avanceret: flere profiler i én agent

`auth-profiles.json` understøtter flere profil-id’er for den samme udbyder.

Vælg hvilken profil der bruges:

- globalt via konfigurationsrækkefølge (`auth.order`)
- per-session via `/model ...@<profileId>`

Eksempel (session-override):

- `/model Opus@anthropic:work`

Sådan ser du, hvilke profil-id’er der findes:

- `openclaw channels list --json` (viser `auth[]`)

Relaterede docs:

- [/concepts/model-failover](/concepts/model-failover) (rotation + cooldown-regler)
- [/tools/slash-commands](/tools/slash-commands) (kommandoflade)
