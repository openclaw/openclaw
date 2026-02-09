---
summary: "Logga in på GitHub Copilot från OpenClaw med hjälp av enhetsflödet"
read_when:
  - Du vill använda GitHub Copilot som modellleverantör
  - Du behöver flödet `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
---

# GitHub Copilot

## Vad är GitHub Copilot?

GitHub Copilot is GitHub's AI coding assistant. Det ger tillgång till Copilot
modeller för ditt GitHub-konto och plan. OpenClaw kan använda Copilot som modell
leverantör på två olika sätt.

## Två sätt att använda Copilot i OpenClaw

### 1. Inbyggd GitHub Copilot‑leverantör (`github-copilot`)

Använd det inbyggda enhets-inloggningsflödet för att få en GitHub token, och byt sedan ut den mot
Copilot API-tokens när OpenClaw körs. Detta är **standard** och enklaste sökvägen
eftersom det inte kräver VS-kod.

### 2. Copilot Proxy‑plugin (`copilot-proxy`)

Använd **Copilot Proxy** VS-kod-tillägget som en lokal brygga. OpenClaw talar med
proxyns `/v1`-slutpunkt och använder modelllistan du konfigurerar där. Välj
detta när du redan kör Copilot Proxy i VS-koden eller måste dirigera igenom den.
Du måste aktivera plugin och hålla VS Code förlängning igång.

Använd GitHub Copilot som modellleverantör (`github-copilot`). Login-kommandot kör
GitHub enhetsflödet, sparar en auth profil och uppdaterar din konfiguration för att använda den
profilen.

## CLI‑konfigurering

```bash
openclaw models auth login-github-copilot
```

Du blir ombedd att besöka en URL och ange en engångskod. Håll terminalen
öppen tills den är klar.

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
