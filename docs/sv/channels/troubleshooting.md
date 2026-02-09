---
summary: "Snabb felsökning på kanalnivå med per-kanal-felsignaturer och åtgärder"
read_when:
  - Kanaltransporten säger ansluten men svar misslyckas
  - Du behöver kanalspecifika kontroller innan djupare leverantörsdokumentation
title: "Kanalfelsökning"
---

# Kanalfelsökning

Använd den här sidan när en kanal ansluter men beteendet är felaktigt.

## Kommandostege

Kör dessa i ordning först:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Hälsosam baslinje:

- `Runtime: running`
- `RPC probe: ok`
- Kanalprobe visar ansluten/redo

## WhatsApp

### WhatsApp-felsignaturer

| Symptom                                       | Snabbaste kontrollen                                      | Åtgärd                                                                                          |
| --------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Ansluten men inga DM-svar                     | `openclaw pairing list whatsapp`                          | Godkänn avsändare eller byt DM-policy/tillåtelselista.                          |
| Gruppmeddelanden ignoreras                    | Kontrollera `requireMention` + omnämnandemönster i konfig | Nämn boten eller lätta på omnämnandepolicyn för gruppen.                        |
| Slumpmässiga frånkopplingar/omloggningsloopar | `openclaw channels status --probe` + loggar               | Logga in igen och verifiera att katalogen för autentiseringsuppgifter är frisk. |

Fullständig felsökning: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram-felsignaturer

| Symptom                                  | Snabbaste kontrollen                              | Åtgärd                                                                        |
| ---------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `/start` men inget användbart svarsflöde | `openclaw pairing list telegram`                  | Godkänn parkoppling eller ändra DM-policy.                    |
| Bot online men gruppen förblir tyst      | Verifiera omnämnandekrav och botens sekretessläge | Inaktivera sekretessläge för gruppsynlighet eller nämn boten. |
| Sändningsfel med nätverksfel             | Inspektera loggar för Telegram API-anropsfel      | Åtgärda DNS/IPv6/proxy-routing till `api.telegram.org`.       |

Fullständig felsökning: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord-felsignaturer

| Symptom                         | Snabbaste kontrollen                              | Åtgärd                                                                           |
| ------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Bot online men inga server-svar | `openclaw channels status --probe`                | Tillåt server/kanal och verifiera intent för meddelandeinnehåll. |
| Gruppmeddelanden ignoreras      | Kontrollera loggar för droppade omnämnandespärrar | Nämn boten eller sätt server/kanal `requireMention: false`.      |
| DM-svar saknas                  | `openclaw pairing list discord`                   | Godkänn DM-parkoppling eller justera DM-policy.                  |

Fullständig felsökning: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack-felsignaturer

| Symptom                            | Snabbaste kontrollen                                   | Åtgärd                                                                 |
| ---------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Socket-läge anslutet men inga svar | `openclaw channels status --probe`                     | Verifiera app-token + bot-token och nödvändiga scopes. |
| DM blockerade                      | `openclaw pairing list slack`                          | Godkänn parkoppling eller lätta på DM-policy.          |
| Kanalmeddelande ignoreras          | Kontrollera `groupPolicy` och kanalens tillåtelselista | Tillåt kanalen eller byt policy till `open`.           |

Fullständig felsökning: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage och BlueBubbles

### iMessage- och BlueBubbles-felsignaturer

| Symptom                              | Snabbaste kontrollen                                                       | Åtgärd                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Inga inkommande händelser            | Verifiera webhook/server-åtkomlighet och appbehörigheter                   | Åtgärda webhook-URL eller BlueBubbles-serverns tillstånd.  |
| Kan skicka men inte ta emot på macOS | Kontrollera macOS integritetsbehörigheter för Meddelanden-automation       | Återbevilja TCC-behörigheter och starta om kanalprocessen. |
| DM-avsändare blockerad               | `openclaw pairing list imessage` eller `openclaw pairing list bluebubbles` | Godkänn parkoppling eller uppdatera tillåtelselistan.      |

Fullständig felsökning:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal-felsignaturer

| Symptom                     | Snabbaste kontrollen                                       | Åtgärd                                                                       |
| --------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Daemon nåbar men boten tyst | `openclaw channels status --probe`                         | Verifiera `signal-cli` daemon-URL/konto och mottagningsläge. |
| DM blockerad                | `openclaw pairing list signal`                             | Godkänn avsändare eller justera DM-policy.                   |
| Grupp-svar triggas inte     | Kontrollera gruppens tillåtelselista och omnämnandemönster | Lägg till avsändare/grupp eller lätta på spärrar.            |

Fullständig felsökning: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrix-felsignaturer

| Symptom                                | Snabbaste kontrollen                               | Åtgärd                                                                 |
| -------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| Inloggad men ignorerar rumsmeddelanden | `openclaw channels status --probe`                 | Kontrollera `groupPolicy` och rummets tillåtelselista. |
| DM behandlas inte                      | `openclaw pairing list matrix`                     | Godkänn avsändare eller justera DM-policy.             |
| Krypterade rum misslyckas              | Verifiera kryptomodul och krypteringsinställningar | Aktivera krypteringsstöd och gå med/synka rummet igen. |

Fullständig felsökning: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
