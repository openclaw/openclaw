---
summary: "Ondersteuning voor Zalo-persoonlijke accounts via zca-cli (QR-login), mogelijkheden en configuratie"
read_when:
  - Zalo Personal instellen voor OpenClaw
  - Problemen oplossen bij Zalo Personal-login of berichtstroom
title: "Zalo Personal"
---

# Zalo Personal (onofficieel)

Status: experimenteel. Deze integratie automatiseert een **persoonlijk Zalo-account** via `zca-cli`.

> **Waarschuwing:** Dit is een onofficiële integratie en kan leiden tot schorsing/blokkering van het account. Gebruik op eigen risico.

## Vereiste plugin

Zalo Personal wordt geleverd als plugin en is niet inbegrepen bij de core-installatie.

- Installeren via CLI: `openclaw plugins install @openclaw/zalouser`
- Of vanuit een broncheckout: `openclaw plugins install ./extensions/zalouser`
- Details: [Plugins](/tools/plugin)

## Vereiste: zca-cli

De Gateway-machine moet het `zca`-binary beschikbaar hebben in `PATH`.

- Controleren: `zca --version`
- Indien ontbrekend, installeer zca-cli (zie `extensions/zalouser/README.md` of de upstream zca-cli-documentatie).

## Snelle installatie (beginner)

1. Installeer de plugin (zie hierboven).
2. Inloggen (QR, op de Gateway-machine):
   - `openclaw channels login --channel zalouser`
   - Scan de QR-code in de terminal met de Zalo-mobiele app.
3. Schakel het kanaal in:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Herstart de Gateway (of rond de onboarding af).
5. DM-toegang staat standaard op koppelen; keur de koppelingscode goed bij het eerste contact.

## Wat het is

- Gebruikt `zca listen` om inkomende berichten te ontvangen.
- Gebruikt `zca msg ...` om antwoorden te verzenden (tekst/media/link).
- Ontworpen voor use-cases met een “persoonlijk account” waar de Zalo Bot API niet beschikbaar is.

## Naamgeving

De kanaal-id is `zalouser` om expliciet te maken dat dit een **persoonlijk Zalo-gebruikersaccount** automatiseert (onofficieel). We houden `zalo` gereserveerd voor een mogelijke toekomstige officiële Zalo API-integratie.

## ID’s vinden (directory)

Gebruik de directory-CLI om peers/groepen en hun ID’s te ontdekken:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Beperkingen

- Uitgaande tekst wordt opgeknipt in ~2000 tekens (limieten van de Zalo-client).
- Streaming staat standaard uitgeschakeld.

## Toegangsbeheer (DM’s)

`channels.zalouser.dmPolicy` ondersteunt: `pairing | allowlist | open | disabled` (standaard: `pairing`).
`channels.zalouser.allowFrom` accepteert gebruikers-ID’s of namen. De wizard zet namen om naar ID’s via `zca friend find` wanneer beschikbaar.

Goedkeuren via:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Groepstoegang (optioneel)

- Standaard: `channels.zalouser.groupPolicy = "open"` (groepen toegestaan). Gebruik `channels.defaults.groupPolicy` om de standaard te overschrijven wanneer niet ingesteld.
- Beperk tot een toegestane lijst met:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (sleutels zijn groeps-ID’s of namen)
- Alle groepen blokkeren: `channels.zalouser.groupPolicy = "disabled"`.
- De configuratiewizard kan vragen om groeps-allowlists.
- Bij het opstarten zet OpenClaw groeps-/gebruikersnamen in allowlists om naar ID’s en logt de mapping; niet-opgeloste items blijven zoals ingevoerd.

Voorbeeld:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Meerdere accounts

Accounts worden gekoppeld aan zca-profielen. Voorbeeld:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Problemen oplossen

**`zca` niet gevonden:**

- Installeer zca-cli en zorg dat het zich op `PATH` bevindt voor het Gateway-proces.

**Inloggen blijft niet behouden:**

- `openclaw channels status --probe`
- Opnieuw inloggen: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
