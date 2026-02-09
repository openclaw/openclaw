---
summary: "Meld je aan bij GitHub Copilot vanuit OpenClaw met behulp van de apparaatstroom"
read_when:
  - Je wilt GitHub Copilot gebruiken als modelprovider
  - Je hebt de `openclaw models auth login-github-copilot`-flow nodig
title: "GitHub Copilot"
---

# GitHub Copilot

## Wat is GitHub Copilot?

GitHub Copilot is de AI-codeerassistent van GitHub. Het biedt toegang tot Copilot‑
modellen voor je GitHub‑account en -abonnement. OpenClaw kan Copilot op twee
verschillende manieren gebruiken als modelprovider.

## Twee manieren om Copilot in OpenClaw te gebruiken

### 1. Ingebouwde GitHub Copilot-provider (`github-copilot`)

Gebruik de native apparaat-aanmeldflow om een GitHub-token te verkrijgen en wissel
dit vervolgens om voor Copilot API-tokens wanneer OpenClaw wordt uitgevoerd. Dit
is het **standaard** en eenvoudigste pad, omdat het geen VS Code vereist.

### 2. Copilot Proxy-plugin (`copilot-proxy`)

Gebruik de **Copilot Proxy** VS Code-extensie als lokale brug. OpenClaw communiceert
met het `/v1`-eindpunt van de proxy en gebruikt de modellijst die je daar
configureert. Kies dit wanneer je Copilot Proxy al in VS Code gebruikt of er via
wilt routeren.
Je moet de plugin inschakelen en de VS Code-extensie actief houden.

Gebruik GitHub Copilot als modelprovider (`github-copilot`). De aanmeldopdracht
start de GitHub-apparaatstroom, slaat een authenticatieprofiel op en werkt je
config bij om dat profiel te gebruiken.

## CLI-installatie

```bash
openclaw models auth login-github-copilot
```

Je wordt gevraagd een URL te bezoeken en een eenmalige code in te voeren. Houd de
terminal open totdat het proces is voltooid.

### Optionele flags

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Stel een standaardmodel in

```bash
openclaw models set github-copilot/gpt-4o
```

### Config-fragment

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Notities

- Vereist een interactieve TTY; voer dit direct uit in een terminal.
- Beschikbaarheid van Copilot-modellen hangt af van je abonnement; als een model
  wordt geweigerd, probeer een andere ID (bijvoorbeeld `github-copilot/gpt-4.1`).
- De aanmelding slaat een GitHub-token op in de opslag voor authenticatieprofielen
  en wisselt dit om voor een Copilot API-token wanneer OpenClaw wordt uitgevoerd.
