---
summary: "Logga in på GitHub Copilot från OpenClaw med hjälp av enhetsflödet"
read_when:
  - Du vill använda GitHub Copilot som modellleverantör
  - Du behöver flödet `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
x-i18n:
  source_path: providers/github-copilot.md
  source_hash: 503e0496d92c921e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:09Z
---

# GitHub Copilot

## Vad är GitHub Copilot?

GitHub Copilot är GitHubs AI‑assistent för kodning. Den ger tillgång till Copilot‑
modeller för ditt GitHub‑konto och din plan. OpenClaw kan använda Copilot som
modellleverantör på två olika sätt.

## Två sätt att använda Copilot i OpenClaw

### 1) Inbyggd GitHub Copilot‑leverantör (`github-copilot`)

Använd det inbyggda enhetsinloggningsflödet för att hämta en GitHub‑token och byt
sedan ut den mot Copilot API‑token när OpenClaw körs. Detta är **standard** och den
enklaste vägen eftersom den inte kräver VS Code.

### 2) Copilot Proxy‑plugin (`copilot-proxy`)

Använd VS Code‑tillägget **Copilot Proxy** som en lokal brygga. OpenClaw pratar med
proxyns `/v1`‑endpoint och använder den modellista som du konfigurerar
där. Välj detta när du redan kör Copilot Proxy i VS Code eller behöver routa via
den. Du måste aktivera pluginet och hålla VS Code‑tillägget igång.

Använd GitHub Copilot som modellleverantör (`github-copilot`). Inloggningskommandot
kör GitHubs enhetsflöde, sparar en autentiseringsprofil och uppdaterar din konfig
att använda den profilen.

## CLI‑konfigurering

```bash
openclaw models auth login-github-copilot
```

Du blir ombedd att besöka en URL och ange en engångskod. Håll terminalen öppen
tills processen är klar.

### Valfria flaggor

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Ställ in en standardmodell

```bash
openclaw models set github-copilot/gpt-4o
```

### Konfigutdrag

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Noteringar

- Kräver en interaktiv TTY; kör det direkt i en terminal.
- Tillgänglighet för Copilot‑modeller beror på din plan; om en modell avvisas,
  prova ett annat ID (till exempel `github-copilot/gpt-4.1`).
- Inloggningen lagrar en GitHub‑token i autentiseringsprofilens lagring och byter
  ut den mot en Copilot API‑token när OpenClaw körs.
