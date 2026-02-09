---
summary: "Understøttelse af Zalo-personlig konto via zca-cli (QR-login), funktioner og konfiguration"
read_when:
  - Opsætning af Zalo Personal til OpenClaw
  - Fejlfinding af Zalo Personal-login eller meddelelsesflow
title: "Zalo Personal"
---

# Zalo Personal (uofficiel)

Status: eksperimentel. Denne integration automatiserer en **personlig Zalo konto** via `zca-cli`.

> **Advarsel:** Dette er en uofficiel integration og kan resultere i kontosuspension/forbud. Brug på egen risiko.

## Krævet plugin

Zalo Personal leveres som et plugin og er ikke inkluderet i kerneinstallationen.

- Installér via CLI: `openclaw plugins install @openclaw/zalouser`
- Eller fra et kildekode-checkout: `openclaw plugins install ./extensions/zalouser`
- Detaljer: [Plugins](/tools/plugin)

## Forudsætning: zca-cli

Gateway-maskinen skal have `zca`-binæren tilgængelig i `PATH`.

- Verificér: `zca --version`
- Hvis den mangler, installér zca-cli (se `extensions/zalouser/README.md` eller de officielle zca-cli-dokumenter).

## Hurtig opsætning (begynder)

1. Installér plugin’et (se ovenfor).
2. Log ind (QR, på Gateway-maskinen):
   - `openclaw channels login --channel zalouser`
   - Scan QR-koden i terminalen med Zalo-mobilappen.
3. Aktivér kanalen:

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

4. Genstart Gateway (eller afslut introduktionen).
5. DM-adgang er som standard parring; godkend parringskoden ved første kontakt.

## Hvad det er

- Bruger `zca listen` til at modtage indgående beskeder.
- Bruger `zca msg ...` til at sende svar (tekst/medier/link).
- Designet til brugsscenarier med “personlig konto”, hvor Zalo Bot API ikke er tilgængeligt.

## Navngivning

Kanal-id er 'zalouser' for at gøre det eksplicit denne automatiserer en **personlig Zalo brugerkonto** (uofficiel). Vi holder `zalo` forbeholdt en potentiel fremtidig officiel Zalo API integration.

## Find ID’er (katalog)

Brug katalog-CLI’en til at finde kontakter/grupper og deres ID’er:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Begrænsninger

- Udgående tekst opdeles i bidder på ~2000 tegn (Zalo-klientens begrænsninger).
- Streaming er blokeret som standard.

## Adgangskontrol (DM’er)

`channels.zalouser.dmPolicy` understøtter: `parring Johanneshette open ¤ disabled` (standard: `parring`).
`channels.zalouser.allowFrom` accepterer bruger-id'er eller navne. Guiden løser navne til id'er via `zca ven find` når det er tilgængeligt.

Godkend via:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Gruppeadgang (valgfrit)

- Standard: `channels.zalouser.groupPolicy = "open"` (grupper tilladt). Brug `channels.defaults.groupPolicy` for at tilsidesætte standarden, når den ikke er angivet.
- Begræns til en tilladelsesliste med:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (nøgler er gruppe-ID’er eller navne)
- Blokér alle grupper: `channels.zalouser.groupPolicy = "disabled"`.
- Opsætningsguiden kan spørge efter tilladelseslister for grupper.
- Ved opstart opløser OpenClaw gruppe-/brugernavne i tilladelseslister til ID’er og logger mappingen; uløste poster bevares som indtastet.

Eksempel:

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

## Multi-konto

Konti kort til zca profiler. Eksempel:

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

## Fejlfinding

**`zca` ikke fundet:**

- Installér zca-cli og sørg for, at den er på `PATH` for Gateway-processen.

**Login hænger ikke ved:**

- `openclaw channels status --probe`
- Log ind igen: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
