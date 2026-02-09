---
summary: "Djupgående felsökningsrunbook för gateway, kanaler, automation, noder och webbläsare"
read_when:
  - Felsökningshubben pekade dig hit för djupare diagnos
  - Du behöver stabila, symtombaserade runbook-avsnitt med exakta kommandon
title: "Felsökning"
---

# Gateway-felsökning

Denna sida är den djupa runboken.
Börja på [/help/troubleshooting](/help/troubleshooting) om du vill ha det snabba triage-flödet först.

## Kommandostege

Kör dessa först, i den här ordningen:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Förväntade friska signaler:

- `openclaw gateway status` visar `Runtime: running` och `RPC probe: ok`.
- `openclaw doctor` rapporterar inga blockerande konfig-/tjänstproblem.
- `openclaw channels status --probe` visar anslutna/redo-kanaler.

## Inga svar

Om kanalerna är uppe men inget svarar, kontrollera routning och policy innan du återansluter något.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

Leta efter:

- Parkoppling väntar för DM-avsändare.
- Gruppomnämningsspärr (`requireMention`, `mentionPatterns`).
- Missmatchar i kanal-/grupptillåtelselista.

Vanliga signaturer:

- `drop guild message (mention required` → gruppmeddelande ignoreras tills omnämning.
- `pairing request` → avsändaren behöver godkännande.
- `blocked` / `allowlist` → avsändare/kanal filtrerades av policy.

Relaterat:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Anslutning till dashboard-/control UI

När dashboard/control UI inte ansluter, validera URL, autentiseringsläge och antaganden om säker kontext.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Leta efter:

- Korrekt probe-URL och dashboard-URL.
- Missmatch i autentiseringsläge/token mellan klient och gateway.
- HTTP-användning där enhetsidentitet krävs.

Vanliga signaturer:

- `device identity required` → osäker kontext eller saknad enhetsautentisering.
- `unauthorized` / återanslutningsloop → token-/lösenordsmissmatch.
- `gateway connect failed:` → fel värd/port/url-mål.

Relaterat:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway-tjänsten körs inte

Använd detta när tjänsten är installerad men processen inte håller sig uppe.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Leta efter:

- `Runtime: stopped` med utgångstips.
- Tjänstekonfigurationsmissmatch (`Config (cli)` vs `Config (service)`).
- Port-/lyssnarkonflikter.

Vanliga signaturer:

- `Gateway start blocked: set gateway.mode=local` → lokalt gateway-läge är inte aktiverat.
- `vägrar att binda gateway ... utan auth` → non-loopback binda utan token/lösenord.
- `another gateway instance is already listening` / `EADDRINUSE` → portkonflikt.

Relaterat:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Kanal ansluten men meddelanden flödar inte

Om kanalstatus är ansluten men meddelandeflödet är dött, fokusera på policy, behörigheter och kanalspecifika leveransregler.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Leta efter:

- DM-policy (`pairing`, `allowlist`, `open`, `disabled`).
- Gruppernas tillåtelselista och krav på omnämning.
- Saknade kanal-API-behörigheter/scopes.

Vanliga signaturer:

- `mention required` → meddelande ignoreras av gruppomnämningspolicy.
- `pairing` / spår för väntande godkännande → avsändaren är inte godkänd.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → problem med kanalautentisering/behörigheter.

Relaterat:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Leverans av cron och heartbeat

Om cron eller heartbeat inte kördes eller inte levererade, verifiera först schemaläggarens tillstånd och därefter leveransmålet.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Leta efter:

- Cron aktiverad och nästa väckning finns.
- Jobbkörningshistorikens status (`ok`, `skipped`, `error`).
- Skäl till att heartbeat hoppades över (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Vanliga signaturer:

- `cron: scheduler disabled; jobs will not run automatically` → cron inaktiverad.
- `cron: timer tick failed` → schemaläggartick misslyckades; kontrollera fil-/logg-/runtime-fel.
- `heartbeat skipped` med `reason=quiet-hours` → utanför fönstret för aktiva timmar.
- `heartbeat: unknown accountId` → ogiltigt konto-id för leveransmål för heartbeat.

Relaterat:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Parkopplad nod: verktyg misslyckas

Om en nod är parkopplad men verktyg misslyckas, isolera förgrund, behörigheter och godkännandestatus.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Leta efter:

- Noden online med förväntade förmågor.
- OS-behörigheter för kamera/mikrofon/plats/skärm.
- Exec-godkännanden och tillåtelselista.

Vanliga signaturer:

- `NODE_BACKGROUND_UNAVAILABLE` → nodappen måste vara i förgrunden.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → saknad OS-behörighet.
- `SYSTEM_RUN_DENIED: approval required` → exec-godkännande väntar.
- `SYSTEM_RUN_DENIED: allowlist miss` → kommando blockerat av tillåtelselista.

Relaterat:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Webbläsarverktyg misslyckas

Använd detta när åtgärder i webbläsarverktyget misslyckas trots att gatewayen i sig är frisk.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Leta efter:

- Giltig sökväg till webbläsarens körbara fil.
- Nåbarhet till CDP-profil.
- Biläggning av tilläggsreläflik för `profile="chrome"`.

Vanliga signaturer:

- `Failed to start Chrome CDP on port` → webbläsarprocessen kunde inte startas.
- `browser.executablePath not found` → den konfigurerade sökvägen är ogiltig.
- `Chrome extension relay is running, but no tab is connected` → tilläggsrelä inte anslutet.
- `Browser attachOnly är aktiverad... ej nåbar` → bifogad profil har inget nåbart mål.

Relaterat:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## Om du uppgraderade och något plötsligt gick sönder

De flesta problem efter uppgradering beror på konfigdrift eller striktare standarder som nu tillämpas.

### 1. Autentisering och URL-överskrivningsbeteende har ändrats

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

Vad du ska kontrollera:

- Om `gateway.mode=remote` kan CLI-anrop peka mot fjärrmål medan din lokala tjänst är okej.
- Explicita `--url`-anrop faller inte tillbaka till lagrade autentiseringsuppgifter.

Vanliga signaturer:

- `gateway connect failed:` → fel URL-mål.
- `unauthorized` → slutpunkt nåbar men fel autentisering.

### 2. Bindning och autentiseringsskydd är striktare

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

Vad du ska kontrollera:

- Bindningar utanför loopback (`lan`, `tailnet`, `custom`) kräver konfigurerad autentisering.
- Gamla nycklar som `gateway.token` ersätter inte `gateway.auth.token`.

Vanliga signaturer:

- `vägrar att binda gateway ... utan auth` → bind+auth matchar inte.
- `RPC probe: failed` medan runtime kör → gatewayen lever men är otillgänglig med aktuell auth/url.

### 3. Parkoppling och enhetsidentitet har ändrats

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

Vad du ska kontrollera:

- Väntande enhetsgodkännanden för dashboard/noder.
- Väntande DM-parkopplingsgodkännanden efter policy- eller identitetsändringar.

Vanliga signaturer:

- `device identity required` → enhetsautentisering inte uppfylld.
- `pairing required` → avsändare/enhet måste godkännas.

Om tjänstekonfigurationen och runtime fortfarande inte stämmer överens efter kontrollerna, installera om tjänstmetadata från samma profil-/tillståndskatalog:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Relaterat:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
