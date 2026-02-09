---
summary: "Manuella inloggningar för webbläsarautomatisering + publicering på X/Twitter"
read_when:
  - Du behöver logga in på webbplatser för webbläsarautomatisering
  - Du vill publicera uppdateringar på X/Twitter
title: "Webbläsarinloggning"
---

# Webbläsarinloggning + publicering på X/Twitter

## Manuell inloggning (rekommenderas)

När en webbplats kräver inloggning, **logga in manuellt** i **värd**‑webbläsarprofilen (OpenClaw‑webbläsaren).

Ge **inte** modellen dina uppgifter. Automatiserade inloggningar utlöser ofta antibot försvar och kan låsa kontot.

Tillbaka till huvud­dokumentationen för webbläsaren: [Browser](/tools/browser).

## Vilken Chrome‑profil används?

OpenClaw kontrollerar en **dedikerad Chrome-profil** (namngiven `openclaw`, orangefärgad UI). Detta är separat från din dagliga webbläsarprofil.

Två enkla sätt att komma åt den:

1. **Be agenten att öppna webbläsaren** och logga sedan in själv.
2. **Öppna den via CLI**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

Om du har flera profiler, skicka `--browser-profile <name>` (standard är `openclaw`).

## X/Twitter: rekommenderat flöde

- **Läsa/söka/trådar:** använd **värd**‑webbläsaren (manuell inloggning).
- **Publicera uppdateringar:** använd **värd**‑webbläsaren (manuell inloggning).

## Sandboxing + åtkomst till värd‑webbläsaren

Sandboxade webbläsarsessioner är **troligare** för att utlösa bot upptäckt. För X/Twitter (och andra strikta webbplatser) föredrar webbläsaren **värd**.

Om agenten är sandlåda, är webbläsarverktyget standard för sandlådan. För att tillåta värdkontroll:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Rikta sedan mot värd‑webbläsaren:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

Eller inaktivera sandboxing för den agent som publicerar uppdateringar.
