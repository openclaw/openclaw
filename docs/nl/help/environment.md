---
summary: "Waar OpenClaw omgevingsvariabelen laadt en de volgorde van prioriteit"
read_when:
  - Je moet weten welke omgevingsvariabelen worden geladen en in welke volgorde
  - Je bent bezig met het debuggen van ontbrekende API-sleutels in de Gateway
  - Je documenteert provider-authenticatie of deploymentomgevingen
title: "Omgevingsvariabelen"
---

# Omgevingsvariabelen

OpenClaw haalt omgevingsvariabelen uit meerdere bronnen. De regel is **bestaande waarden nooit overschrijven**.

## Prioriteit (hoogste → laagste)

1. **Procesomgeving** (wat het Gateway-proces al heeft van de bovenliggende shell/daemon).
2. **`.env` in de huidige werkdirectory** (dotenv-standaard; overschrijft niet).
3. **Globale `.env`** op `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`; overschrijft niet).
4. **Config `env`-blok** in `~/.openclaw/openclaw.json` (alleen toegepast indien ontbrekend).
5. **Optionele login-shell-import** (`env.shellEnv.enabled` of `OPENCLAW_LOAD_SHELL_ENV=1`), alleen toegepast voor ontbrekende verwachte sleutels.

Als het configbestand volledig ontbreekt, wordt stap 4 overgeslagen; shell-import wordt nog steeds uitgevoerd indien ingeschakeld.

## Config `env`-blok

Twee gelijkwaardige manieren om inline omgevingsvariabelen in te stellen (beide overschrijven niet):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Shell-omgevingsimport

`env.shellEnv` start je login-shell en importeert alleen **ontbrekende** verwachte sleutels:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Env var equivalenten:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Substitutie van omgevingsvariabelen in config

Je kunt omgevingsvariabelen direct refereren in stringwaarden van de config met de syntaxis `${VAR_NAME}`:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

Zie [Configuratie: substitutie van omgevingsvariabelen](/gateway/configuration#env-var-substitution-in-config) voor alle details.

## Gerelateerd

- [Gateway-configuratie](/gateway/configuration)
- [FAQ: omgevingsvariabelen en .env-laden](/help/faq#env-vars-and-env-loading)
- [Overzicht van modellen](/concepts/models)
