---
summary: "Stöd för Zalo-personligt konto via zca-cli (QR-inloggning), funktioner och konfiguration"
read_when:
  - Konfigurera Zalo Personal för OpenClaw
  - Felsöka inloggning eller meddelandeflöde för Zalo Personal
title: "Zalo Personal"
---

# Zalo Personal (inofficiell)

Status: experimentell. Denna integration automatiserar ett **personligt Zalo konto** via `zca-cli`.

> **Varning:** Detta är en inofficiell integration och kan resultera i kontoavstängning/avstängning. Använd på egen risk.

## Plugin krävs

Zalo Personal levereras som ett plugin och ingår inte i kärninstallationen.

- Installera via CLI: `openclaw plugins install @openclaw/zalouser`
- Eller från en källkodsklona: `openclaw plugins install ./extensions/zalouser`
- Detaljer: [Plugins](/tools/plugin)

## Förutsättning: zca-cli

Gateway-maskinen måste ha binären `zca` tillgänglig i `PATH`.

- Verifiera: `zca --version`
- Om den saknas, installera zca-cli (se `extensions/zalouser/README.md` eller den uppströms zca-cli-dokumentationen).

## Snabbstart (nybörjare)

1. Installera pluginet (se ovan).
2. Logga in (QR, på Gateway-maskinen):
   - `openclaw channels login --channel zalouser`
   - Skanna QR-koden i terminalen med Zalo-mobilappen.
3. Aktivera kanalen:

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

4. Starta om Gateway (eller slutför introduktionen).
5. DM-åtkomst är som standard parning; godkänn parningskoden vid första kontakten.

## Vad det är

- Använder `zca listen` för att ta emot inkommande meddelanden.
- Använder `zca msg ...` för att skicka svar (text/media/länk).
- Utformad för användningsfall med ”personligt konto” där Zalo Bot API inte är tillgängligt.

## Namngivning

Kanalid är `zalouser` för att göra det explicit detta automatiserar ett **personligt Zalo användarkonto** (inofficiellt). Vi håller `zalo` reserverad för en potentiell framtida officiell Zalo API-integration.

## Hitta ID:n (katalog)

Använd katalog-CLI:t för att upptäcka kontakter/grupper och deras ID:n:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Begränsningar

- Utgående text delas upp i ~2000 tecken (begränsningar i Zalo-klienten).
- Streaming är blockerad som standard.

## Åtkomstkontroll (DM)

`channels.zalouser.dmPolicy` stöder: `parning <unk> allowlist <unk> open <unk> inaktiverad` (standard: `parning`).
`channels.zalouser.allowFrom` accepterar användar-ID eller namn. Guiden löser namn på ID via `zca vän hittar` när den är tillgänglig.

Godkänn via:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Gruppåtkomst (valfritt)

- Standard: `channels.zalouser.groupPolicy = "open"` (grupper tillåtna). Använd `channels.defaults.groupPolicy` för att åsidosätta standard när du inaktiverar.
- Begränsa till en tillåtelselista med:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (nycklar är grupp-ID:n eller namn)
- Blockera alla grupper: `channels.zalouser.groupPolicy = "disabled"`.
- Konfigureringsguiden kan fråga efter tillåtelselistor för grupper.
- Vid uppstart löser OpenClaw grupp-/användarnamn i tillåtelselistor till ID:n och loggar mappningen; olösta poster behålls som de är skrivna.

Exempel:

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

## Flera konton

Konton karta till zca profiler. Exempel:

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

## Felsökning

**`zca` hittades inte:**

- Installera zca-cli och säkerställ att den finns på `PATH` för Gateway-processen.

**Inloggningen fastnar inte:**

- `openclaw channels status --probe`
- Logga in igen: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
