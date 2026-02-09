---
summary: "Snelle probleemoplossing op kanaalniveau met per kanaal faalsignaturen en oplossingen"
read_when:
  - Het kanaaltransport zegt verbonden, maar antwoorden falen
  - Je hebt kanaalspecifieke controles nodig vóór diepe provider-documentatie
title: "Problemen oplossen per kanaal"
---

# Problemen oplossen per kanaal

Gebruik deze pagina wanneer een kanaal verbinding maakt maar het gedrag niet klopt.

## Opdrachtenladder

Voer deze eerst in deze volgorde uit:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Gezonde basislijn:

- `Runtime: running`
- `RPC probe: ok`
- Kanaalprobe toont verbonden/gereed

## WhatsApp

### WhatsApp-faalsignaturen

| Symptoom                               | Snelste controle                                         | Fix                                                                           |
| -------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Verbonden maar geen DM-antwoorden      | `openclaw pairing list whatsapp`                         | Keur afzender goed of wijzig DM-beleid/toegestane lijst.      |
| Groepsberichten genegeerd              | Controleer `requireMention` + mention-patronen in config | Noem de bot of versoepel het mention-beleid voor die groep.   |
| Willekeurige ontkoppeling/login lussen | `openclaw channels status --probe` + logs                | Log opnieuw in en verifieer dat de credentials-map gezond is. |

Volledige probleemoplossing: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram-faalsignaturen

| Symptoom                                    | Snelste controle                               | Fix                                                                               |
| ------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `/start` maar geen bruikbare antwoordstroom | `openclaw pairing list telegram`               | Keur koppeling goed of wijzig DM-beleid.                          |
| Bot online maar groep blijft stil           | Verifieer mention-vereiste en bot-privacymodus | Schakel privacymodus uit voor groepszichtbaarheid of noem de bot. |
| Verzendfouten met netwerkfouten             | Inspecteer logs op Telegram API-aanroepfouten  | Los DNS/IPv6/proxy-routering naar `api.telegram.org` op.          |

Volledige probleemoplossing: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord-faalsignaturen

| Symptoom                              | Snelste controle                             | Fix                                                                          |
| ------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Bot online maar geen guild-antwoorden | `openclaw channels status --probe`           | Sta guild/kanaal toe en verifieer Message Content Intent.    |
| Groepsberichten genegeerd             | Controleer logs op drops door mention-gating | Noem de bot of stel guild/kanaal `requireMention: false` in. |
| DM-antwoorden ontbreken               | `openclaw pairing list discord`              | Keur DM-koppeling goed of pas DM-beleid aan.                 |

Volledige probleemoplossing: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack-faalsignaturen

| Symptoom                                   | Snelste controle                                    | Fix                                                                 |
| ------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------- |
| Socketmodus verbonden maar geen antwoorden | `openclaw channels status --probe`                  | Verifieer app-token + bot-token en vereiste scopes. |
| DM's geblokkeerd                           | `openclaw pairing list slack`                       | Keur koppeling goed of versoepel DM-beleid.         |
| Kanaalbericht genegeerd                    | Controleer `groupPolicy` en kanaal-toegestane lijst | Sta het kanaal toe of schakel beleid naar `open`.   |

Volledige probleemoplossing: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage en BlueBubbles

### iMessage- en BlueBubbles-faalsignaturen

| Symptoom                                   | Snelste controle                                                        | Fix                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Geen inkomende events                      | Verifieer webhook-/serverbereikbaarheid en app-rechten                  | Herstel webhook-URL of BlueBubbles-serverstatus.          |
| Kan verzenden maar niet ontvangen op macOS | Controleer macOS-privacyrechten voor Messages-automatisering            | Verleen TCC-rechten opnieuw en herstart het kanaalproces. |
| DM-afzender geblokkeerd                    | `openclaw pairing list imessage` of `openclaw pairing list bluebubbles` | Toegestane lijst goedkeuren voor koppelen of bijwerken.   |

Volledige probleemoplossing:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal-faalsignaturen

| Symptoom                        | Snelste controle                                      | Fix                                                                        |
| ------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| Daemon bereikbaar maar bot stil | `openclaw channels status --probe`                    | Verifieer `signal-cli` daemon-URL/account en ontvangmodus. |
| DM geblokkeerd                  | `openclaw pairing list signal`                        | Keur afzender goed of pas DM-beleid aan.                   |
| Groepsantwoorden triggeren niet | Controleer groep-toegestane lijst en mention-patronen | Voeg afzender/groep toe of versoepel gating.               |

Volledige probleemoplossing: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrix-faalsignaturen

| Symptoom                             | Snelste controle                                     | Fix                                                                                                 |
| ------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Ingelogd maar negeert kamerberichten | `openclaw channels status --probe`                   | Controleer `groupPolicy` en kamer-toegestane lijst.                                 |
| DM's worden niet verwerkt            | `openclaw pairing list matrix`                       | Keur afzender goed of pas DM-beleid aan.                                            |
| Versleutelde ruimtes mislukken       | Verifieer cryptomodule en versleutelingsinstellingen | Schakel versleutelingsondersteuning in en sluit opnieuw aan/synchroniseer de kamer. |

Volledige probleemoplossing: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
