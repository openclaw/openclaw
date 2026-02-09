---
summary: "Hurtig fejlfinding på kanalniveau med fejlmønstre og rettelser pr. kanal"
read_when:
  - Kanaltransporten siger forbundet, men svar fejler
  - Du har brug for kanalspecifikke tjek før dybdegående udbyderdokumentation
title: "Kanalfejlfinding"
---

# Kanalfejlfinding

Brug denne side, når en kanal forbinder, men adfærden er forkert.

## Kommandotrin

Kør disse i rækkefølge først:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Sund baseline:

- `Runtime: running`
- `RPC probe: ok`
- Kanalprobe viser forbundet/klar

## WhatsApp

### WhatsApp-fejlmønstre

| Symptom                            | Hurtigste tjek                                       | Løsning                                                                   |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Forbundet, men ingen DM-svar       | `openclaw pairing list whatsapp`                     | Godkend afsender eller skift DM-politik/tilladelsesliste. |
| Gruppemeddelelser ignoreres        | Tjek `requireMention` + nævnemønstre i konfiguration | Nævn botten eller lemp nævnepolitikken for gruppen.       |
| Tilfældige afbryd/indlogningsloops | `openclaw channels status --probe` + logs            | Log ind igen og bekræft, at legitimationsmappen er sund.  |

Fuld fejlfinding: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram-fejlmønstre

| Symptom                               | Hurtigste tjek                              | Løsning                                                                             |
| ------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `/start` men intet brugbart svarflow  | `openclaw pairing list telegram`            | Godkend parring eller ændr DM-politik.                              |
| Bot online, men gruppe forbliver tavs | Bekræft nævnekrav og bot-privatlivstilstand | Deaktivér privatlivstilstand for gruppesynlighed eller nævn botten. |
| Sende-fejl med netværksfejl           | Gennemse logs for Telegram API-kaldfejl     | Ret DNS/IPv6/proxy-routing til `api.telegram.org`.                  |

Fuld fejlfinding: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord-fejlmønstre

| Symptom                          | Hurtigste tjek                             | Løsning                                                                     |
| -------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Bot online, men ingen guild-svar | `openclaw channels status --probe`         | Tillad guild/kanal og verificér intent for message content. |
| Gruppemeddelelser ignoreres      | Kontroller logs for at nævne gating dråber | Nævn botten eller sæt guild/kanal `requireMention: false`.  |
| DM-svar mangler                  | `openclaw pairing list discord`            | Godkend DM-parring eller justér DM-politik.                 |

Fuld fejlfinding: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack-fejlmønstre

| Symptom                                   | Hurtigste tjek                                  | Løsning                                                             |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| Socket-tilstand forbundet, men ingen svar | `openclaw channels status --probe`              | Bekræft app-token + bot-token og nødvendige scopes. |
| DMs blokeret                              | `openclaw pairing list slack`                   | Godkend parring eller lemp DM-politik.              |
| Kanalmeddelelse ignoreres                 | Tjek `groupPolicy` og kanalens tilladelsesliste | Tillad kanalen eller skift politik til `open`.      |

Fuld fejlfinding: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage og BlueBubbles

### iMessage- og BlueBubbles-fejlmønstre

| Symptom                              | Hurtigste tjek                                                             | Løsning                                                               |
| ------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Ingen indgående hændelser            | Bekræft webhook/server-tilgængelighed og app-tilladelser                   | Ret webhook-URL eller BlueBubbles-serverens tilstand. |
| Kan sende, men ikke modtage på macOS | Tjek macOS-privatlivstilladelser for Messages-automatisering               | Giv TCC-tilladelser igen og genstart kanalprocessen.  |
| DM-afsender blokeret                 | `openclaw pairing list imessage` eller `openclaw pairing list bluebubbles` | Godkend parring eller opdatér tilladelseslisten.      |

Fuld fejlfinding:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal-fejlmønstre

| Symptom                            | Hurtigste tjek                                 | Løsning                                                                   |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| Daemon kan nås, men botten er tavs | `openclaw channels status --probe`             | Bekræft `signal-cli` daemon-URL/konto og modtagetilstand. |
| DM blokeret                        | `openclaw pairing list signal`                 | Godkend afsender eller justér DM-politik.                 |
| Gruppesvar udløses ikke            | Tjek gruppens tilladelsesliste og nævnemønstre | Tilføj afsender/gruppe eller lemp gating.                 |

Fuld fejlfinding: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrix-fejlmønstre

| Symptom                                  | Hurtigste tjek                                  | Løsning                                                                               |
| ---------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Logget ind, men ignorerer rummeddelelser | `openclaw channels status --probe`              | Tjek `groupPolicy` og rummets tilladelsesliste.                       |
| DMs behandles ikke                       | `openclaw pairing list matrix`                  | Godkend afsender eller justér DM-politik.                             |
| Krypterede rum fejler                    | Bekræft kryptomodul og krypteringsindstillinger | Aktivér krypteringsunderstøttelse og tilslut/synkronisér rummet igen. |

Fuld fejlfinding: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
