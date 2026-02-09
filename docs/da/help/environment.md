---
summary: "Hvor OpenClaw indlæser miljøvariabler, og rækkefølgen for forrang"
read_when:
  - Du skal vide, hvilke miljøvariabler der indlæses, og i hvilken rækkefølge
  - Du fejlretter manglende API-nøgler i Gateway
  - Du dokumenterer udbyderautentificering eller udrulningsmiljøer
title: "Miljøvariabler"
---

# Miljøvariabler

OpenClaw trækker miljøvariabler fra flere kilder. Reglen er **aldrig tilsidesætte eksisterende værdier**.

## Forrang (højeste → laveste)

1. **Procesmiljø** (det som Gateway-processen allerede har fra den overordnede shell/daemon).
2. **`.env` i den aktuelle arbejdsmappe** (dotenv-standard; overskriver ikke).
3. **Global `.env`** ved `~/.openclaw/.env` (også kendt som `$OPENCLAW_STATE_DIR/.env`; overskriver ikke).
4. **Konfiguration `env`-blok** i `~/.openclaw/openclaw.json` (anvendes kun hvis mangler).
5. **Valgfri login-shell-import** (`env.shellEnv.enabled` eller `OPENCLAW_LOAD_SHELL_ENV=1`), anvendes kun for manglende forventede nøgler.

Hvis konfigurationsfilen mangler helt, springes trin 4 over; shell-import kører stadig, hvis den er aktiveret.

## Konfiguration `env`-blok

To ækvivalente måder at angive inline-miljøvariabler på (begge overskriver ikke):

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

## Shell-miljøimport

`env.shellEnv` kører din login-shell og importerer kun **manglende** forventede nøgler:

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

Ækvivalenter som miljøvariabler:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Substitution af miljøvariabler i konfiguration

Du kan referere til miljøvariabler direkte i konfigurations-strengværdier ved at bruge `${VAR_NAME}`-syntaks:

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

Se [Konfiguration: Substitution af miljøvariabler](/gateway/configuration#env-var-substitution-in-config) for fulde detaljer.

## Relateret

- [Gateway-konfiguration](/gateway/configuration)
- [FAQ: miljøvariabler og .env-indlæsning](/help/faq#env-vars-and-env-loading)
- [Modeloverblik](/concepts/models)
