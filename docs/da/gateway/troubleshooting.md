---
summary: "Dybtgående fejlfinding-runbook for gateway, kanaler, automatisering, noder og browser"
read_when:
  - Fejlfindingshubben har henvist dig hertil for dybere diagnose
  - Du har brug for stabile, symptombaserede runbook-sektioner med præcise kommandoer
title: "Fejlfinding"
---

# Gateway-fejlfinding

Denne side er den dybe runbook.
Start ved [/help/troubleshooting](/help/troubleshooting) hvis du ønsker det hurtige triage flow først.

## Kommandotrin

Kør disse først, i denne rækkefølge:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Forventede sunde signaler:

- `openclaw gateway status` viser `Runtime: running` og `RPC probe: ok`.
- `openclaw doctor` rapporterer ingen blokerende konfigurations-/serviceproblemer.
- `openclaw channels status --probe` viser forbundne/klar-kanaler.

## Ingen svar

Hvis kanalerne er oppe, men intet svarer, så tjek routing og politik, før du genforbinder noget.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

Se efter:

- Paring afventer for DM-afsendere.
- Gruppe-mention-gating (`requireMention`, `mentionPatterns`).
- Uoverensstemmelser i kanal-/gruppe-tilladelsesliste.

Almindelige signaturer:

- `drop guild message (mention required` → gruppemeddelelse ignoreres indtil mention.
- `pairing request` → afsender skal godkendes.
- `blocked` / `allowlist` → afsender/kanal blev filtreret af politik.

Relateret:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Dashboard-/kontrol-UI-forbindelse

Når dashboard-/kontrol-UI ikke vil forbinde, så valider URL, autentificeringstilstand og antagelser om sikker kontekst.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Se efter:

- Korrekt probe-URL og dashboard-URL.
- Uoverensstemmelse i auth-tilstand/token mellem klient og gateway.
- Brug af HTTP, hvor enhedsidentitet er påkrævet.

Almindelige signaturer:

- `device identity required` → usikker kontekst eller manglende enhedsautentificering.
- `unauthorized` / genforbindelsesloop → token-/adgangskodeuoverensstemmelse.
- `gateway connect failed:` → forkert host/port/URL-mål.

Relateret:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway-tjenesten kører ikke

Brug dette, når tjenesten er installeret, men processen ikke bliver kørende.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Se efter:

- `Runtime: stopped` med exit-hints.
- Uoverensstemmelse i servicekonfiguration (`Config (cli)` vs `Config (service)`).
- Port-/listener-konflikter.

Almindelige signaturer:

- `Gateway start blocked: set gateway.mode=local` → lokal gateway-tilstand er ikke aktiveret.
- `nægter at binde gateway... uden auth` → ikke-loopback bind uden token/password.
- `another gateway instance is already listening` / `EADDRINUSE` → portkonflikt.

Relateret:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Kanal forbundet, men beskeder flyder ikke

Hvis kanaltilstanden er forbundet, men beskedflowet er dødt, så fokuser på politik, rettigheder og kanalspecifikke leveringsregler.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Se efter:

- DM-politik (`pairing`, `allowlist`, `open`, `disabled`).
- Gruppe-tilladelsesliste og mention-krav.
- Manglende kanal-API-rettigheder/scopes.

Almindelige signaturer:

- `mention required` → besked ignoreret af gruppe-mention-politik.
- `pairing` / spor for afventende godkendelse → afsender er ikke godkendt.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → kanal-auth/rettighedsproblem.

Relateret:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron- og heartbeat-levering

Hvis cron eller heartbeat ikke kørte eller ikke leverede, så verificér først scheduler-tilstand og derefter leveringsmålet.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Se efter:

- Cron er aktiveret, og næste wake er til stede.
- Jobkørsels-historikstatus (`ok`, `skipped`, `error`).
- Årsager til heartbeat-skip (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Almindelige signaturer:

- `cron: scheduler disabled; jobs will not run automatically` → cron deaktiveret.
- `cron: timer tick failed` → scheduler-tick fejlede; tjek fil-/log-/runtime-fejl.
- `heartbeat skipped` med `reason=quiet-hours` → uden for vinduet for aktive timer.
- `heartbeat: unknown accountId` → ugyldigt konto-id for heartbeat-leveringsmål.

Relateret:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Parret node-værktøj fejler

Hvis en node er parret, men værktøjer fejler, så isolér forgrund, tilladelser og godkendelsestilstand.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Se efter:

- Node online med forventede kapabiliteter.
- OS-tilladelser givet for kamera/mikrofon/placering/skærm.
- Exec-godkendelser og tilladelsesliste-tilstand.

Almindelige signaturer:

- `NODE_BACKGROUND_UNAVAILABLE` → node-appen skal være i forgrunden.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → manglende OS-tilladelse.
- `SYSTEM_RUN_DENIED: approval required` → exec-godkendelse afventer.
- `SYSTEM_RUN_DENIED: allowlist miss` → kommando blokeret af tilladelsesliste.

Relateret:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Browser-værktøj fejler

Brug dette, når handlinger i browser-værktøjet fejler, selvom selve gatewayen er sund.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Se efter:

- Gyldig sti til browser-eksekverbar.
- CDP-profilens tilgængelighed.
- Extension-relay-fanebinding for `profile="chrome"`.

Almindelige signaturer:

- `Failed to start Chrome CDP on port` → browserprocessen kunne ikke starte.
- `browser.executablePath not found` → den konfigurerede sti er ugyldig.
- `Chrome extension relay is running, but no tab is connected` → extension relay er ikke tilkoblet.
- `Browser vedhæftet fil er kun aktiveret... ikke tilgængelig` → attach-only profil har intet nås mål.

Relateret:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## Hvis du opgraderede, og noget pludselig gik i stykker

De fleste fejl efter opgradering skyldes konfigurationsdrift eller strengere standarder, som nu håndhæves.

### 1. Autentificering og URL-override-adfærd ændret

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

Hvad du skal tjekke:

- Hvis `gateway.mode=remote`, kan CLI-kald målrette remote, mens din lokale service er fin.
- Eksplicitte `--url`-kald falder ikke tilbage til gemte legitimationsoplysninger.

Almindelige signaturer:

- `gateway connect failed:` → forkert URL-mål.
- `unauthorized` → endpoint er tilgængeligt, men forkert auth.

### 2. Bind- og auth-guardrails er strengere

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

Hvad du skal tjekke:

- Ikke-loopback binds (`lan`, `tailnet`, `custom`) kræver konfigureret auth.
- Gamle nøgler som `gateway.token` erstatter ikke `gateway.auth.token`.

Almindelige signaturer:

- `nægter at binde gateway... uden auth` → bind+auth mismatch.
- `RPC probe: failed` mens runtime kører → gateway er i live, men utilgængelig med nuværende auth/URL.

### 3. Paring og enhedsidentitetstilstand ændret

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

Hvad du skal tjekke:

- Afventende enhedsgodkendelser for dashboard/noder.
- Afventende DM-paringsgodkendelser efter politik- eller identitetsændringer.

Almindelige signaturer:

- `device identity required` → enhedsautentificering er ikke opfyldt.
- `pairing required` → afsender/enhed skal godkendes.

Hvis servicekonfigurationen og runtime stadig er uenige efter tjek, så geninstaller servicemetadata fra den samme profil-/state-mappe:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Relateret:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
