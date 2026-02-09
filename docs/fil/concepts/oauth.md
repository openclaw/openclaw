---
summary: "OAuth sa OpenClaw: palitan ng token, pag-iimbak, at mga pattern para sa maraming account"
read_when:
  - Gusto mong maunawaan ang OAuth sa OpenClaw mula simula hanggang dulo
  - Nakaranas ka ng mga isyu sa invalidation ng token / pag-logout
  - Gusto mo ang setup-token o mga OAuth auth flow
  - Gusto mo ng maraming account o routing batay sa profile
title: "OAuth"
---

# OAuth

OpenClaw supports “subscription auth” via OAuth for providers that offer it (notably **OpenAI Codex (ChatGPT OAuth)**). For Anthropic subscriptions, use the **setup-token** flow. This page explains:

- kung paano gumagana ang OAuth **token exchange** (PKCE)
- kung saan **iniimbak** ang mga token (at kung bakit)
- kung paano pangasiwaan ang **maraming account** (mga profile + per-session na override)

OpenClaw also supports **provider plugins** that ship their own OAuth or API‑key
flows. Run them via:

```bash
openclaw models auth login --provider <id>
```

## Ang token sink (bakit ito umiiral)

OAuth providers commonly mint a **new refresh token** during login/refresh flows. Some providers (or OAuth clients) can invalidate older refresh tokens when a new one is issued for the same user/app.

Praktikal na sintomas:

- nag-login ka sa OpenClaw _at_ sa Claude Code / Codex CLI → isa sa mga ito ay biglang “nalo-log out” kalaunan

Upang mabawasan ito, tinatrato ng OpenClaw ang `auth-profiles.json` bilang **token sink**:

- binabasa ng runtime ang mga kredensyal mula sa **iisang lugar**
- maaari naming panatilihin ang maraming profile at iruta ang mga ito nang deterministiko

## Storage (kung saan nakatira ang mga token)

Ang mga sikreto ay iniimbak **per-agent**:

- Mga auth profile (OAuth + API keys): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Runtime cache (awtomatikong pinamamahalaan; huwag i-edit): `~/.openclaw/agents/<agentId>/agent/auth.json`

Legacy na import-only file (suportado pa rin, ngunit hindi ang pangunahing store):

- `~/.openclaw/credentials/oauth.json` (ini-import sa `auth-profiles.json` sa unang gamit)

All of the above also respect `$OPENCLAW_STATE_DIR` (state dir override). Full reference: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (subscription auth)

Patakbuhin ang `claude setup-token` sa anumang makina, pagkatapos ay i-paste ito sa OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Kung nabuo mo ang token sa ibang lugar, i-paste ito nang manu-mano:

```bash
openclaw models auth paste-token --provider anthropic
```

I-verify:

```bash
openclaw models status
```

## OAuth exchange (kung paano gumagana ang login)

Ang mga interactive login flow ng OpenClaw ay ipinatutupad sa `@mariozechner/pi-ai` at ikinokonekta sa mga wizard/command.

### Anthropic (Claude Pro/Max) setup-token

Hugis ng flow:

1. patakbuhin ang `claude setup-token`
2. i-paste ang token sa OpenClaw
3. i-store bilang token auth profile (walang refresh)

Ang wizard path ay `openclaw onboard` → auth choice `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Hugis ng flow (PKCE):

1. bumuo ng PKCE verifier/challenge + random `state`
2. buksan ang `https://auth.openai.com/oauth/authorize?...`
3. subukang kunin ang callback sa `http://127.0.0.1:1455/auth/callback`
4. kung hindi makapag-bind ang callback (o remote/headless ka), i-paste ang redirect URL/code
5. mag-exchange sa `https://auth.openai.com/oauth/token`
6. kunin ang `accountId` mula sa access token at i-store ang `{ access, refresh, expires, accountId }`

Ang wizard path ay `openclaw onboard` → auth choice `openai-codex`.

## Refresh + expiry

Ang mga profile ay nag-iimbak ng `expires` timestamp.

Sa runtime:

- kung ang `expires` ay nasa hinaharap → gamitin ang nakaimbak na access token
- kung expired → mag-refresh (sa ilalim ng file lock) at i-overwrite ang nakaimbak na mga kredensyal

Awtomatiko ang refresh flow; karaniwan ay hindi mo kailangang pamahalaan ang mga token nang manu-mano.

## Maraming account (mga profile) + routing

Dalawang pattern:

### 1. Inirerekomenda: hiwalay na mga agent

Kung gusto mong hindi kailanman magkahalo ang “personal” at “work,” gumamit ng mga isolated agent (hiwalay na mga session + kredensyal + workspace):

```bash
openclaw agents add work
openclaw agents add personal
```

Pagkatapos ay i-configure ang auth per-agent (wizard) at iruta ang mga chat sa tamang agent.

### 2. Advanced: maraming profile sa iisang agent

Sinusuportahan ng `auth-profiles.json` ang maraming profile ID para sa parehong provider.

Piliin kung aling profile ang gagamitin:

- global sa pamamagitan ng pag-aayos ng config (`auth.order`)
- per-session sa pamamagitan ng `/model ...@<profileId>`

Halimbawa (session override):

- `/model Opus@anthropic:work`

Paano makita kung anong mga profile ID ang umiiral:

- `openclaw channels list --json` (ipinapakita ang `auth[]`)

Kaugnay na docs:

- [/concepts/model-failover](/concepts/model-failover) (mga patakaran sa rotation + cooldown)
- [/tools/slash-commands](/tools/slash-commands) (command surface)
