---
summary: "Doctor-opdracht: healthchecks, config-migraties en reparatiestappen"
read_when:
  - Het toevoegen of wijzigen van doctor-migraties
  - Het introduceren van ingrijpende configwijzigingen
title: "Doctor"
---

# Doctor

`openclaw doctor` is het reparatie- en migratiehulpmiddel voor OpenClaw. Het verhelpt verouderde
config/status, controleert de gezondheid en biedt uitvoerbare reparatiestappen.

## Snelle start

```bash
openclaw doctor
```

### Headless / automatisering

```bash
openclaw doctor --yes
```

Accepteer standaardwaarden zonder prompts (inclusief herstart/service/sandbox-reparatiestappen indien van toepassing).

```bash
openclaw doctor --repair
```

Pas aanbevolen reparaties toe zonder prompts (reparaties + herstarts waar veilig).

```bash
openclaw doctor --repair --force
```

Pas ook agressieve reparaties toe (overschrijft aangepaste supervisor-configs).

```bash
openclaw doctor --non-interactive
```

Voer uit zonder prompts en pas alleen veilige migraties toe (config-normalisatie + verplaatsingen van on-disk status). Slaat herstart/service/sandbox-acties over die menselijke bevestiging vereisen.
Legacy statusmigraties worden automatisch uitgevoerd wanneer gedetecteerd.

```bash
openclaw doctor --deep
```

Scan systeemservices op extra gateway-installaties (launchd/systemd/schtasks).

Als je wijzigingen wilt beoordelen voordat ze worden weggeschreven, open dan eerst het configbestand:

```bash
cat ~/.openclaw/openclaw.json
```

## Wat het doet (samenvatting)

- Optionele pre-flight update voor git-installaties (alleen interactief).
- UI-protocol-versheidscontrole (bouwt de Control UI opnieuw wanneer het protocolschema nieuwer is).
- Gezondheidscontrole + herstartprompt.
- Skills-statusoverzicht (geschikt/ontbrekend/geblokkeerd).
- Config-normalisatie voor legacy waarden.
- OpenCode Zen provider override-waarschuwingen (`models.providers.opencode`).
- Legacy on-disk statusmigratie (sessies/agentmap/WhatsApp-auth).
- Statusintegriteit- en permissiecontroles (sessies, transcripties, statusmap).
- Bestandspermissiecontroles voor config (chmod 600) bij lokaal uitvoeren.
- Model-auth gezondheid: controleert OAuth-verval, kan bijna verlopen tokens vernieuwen en rapporteert auth-profiel cooldown/uitgeschakelde staten.
- Detectie van extra werkruimtemappen (`~/openclaw`).
- Sandbox-imageherstel wanneer sandboxing is ingeschakeld.
- Legacy servicemigratie en detectie van extra gateways.
- Gateway-runtimecontroles (service geïnstalleerd maar niet actief; gecachte launchd-label).
- Kanaalstatuswaarschuwingen (geprobeerd vanaf de draaiende gateway).
- Supervisor-configaudit (launchd/systemd/schtasks) met optionele reparatie.
- Gateway-runtime best-practicecontroles (Node vs Bun, version-managerpaden).
- Diagnostiek voor gateway-poortconflicten (standaard `18789`).
- Beveiligingswaarschuwingen voor open DM-beleid.
- Gateway-authwaarschuwingen wanneer geen `gateway.auth.token` is ingesteld (lokale modus; biedt tokengeneratie aan).
- systemd linger-controle op Linux.
- Broninstallatiecontroles (pnpm-werkruimtemismatch, ontbrekende UI-assets, ontbrekende tsx-binary).
- Schrijft bijgewerkte config + wizard-metadata.

## Gedetailleerd gedrag en onderbouwing

### 0. Optionele update (git-installaties)

Als dit een git-checkout is en doctor interactief draait, biedt het aan om
te updaten (fetch/rebase/build) voordat doctor wordt uitgevoerd.

### 1. Config-normalisatie

Als de config legacy waardevormen bevat (bijvoorbeeld `messages.ackReaction`
zonder een kanaalspecifieke override), normaliseert doctor deze naar het huidige
schema.

### 2. Migraties van legacy config-sleutels

Wanneer de config verouderde sleutels bevat, weigeren andere opdrachten te draaien en vragen
je om `openclaw doctor` uit te voeren.

Doctor zal:

- Uitleggen welke legacy sleutels zijn gevonden.
- De toegepaste migratie tonen.
- `~/.openclaw/openclaw.json` herschrijven met het bijgewerkte schema.

De Gateway voert doctor-migraties ook automatisch uit bij het opstarten wanneer een
legacy configformaat wordt gedetecteerd, zodat verouderde configs zonder handmatige interventie worden hersteld.

Huidige migraties:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → top-level `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen provider overrides

Als je `models.providers.opencode` (of `opencode-zen`) handmatig hebt toegevoegd, overschrijft dit
de ingebouwde OpenCode Zen-catalogus uit `@mariozechner/pi-ai`. Dat kan
elk model dwingen naar één enkele API of kosten op nul zetten. Doctor waarschuwt zodat je
de override kunt verwijderen en per-model API-routering + kosten kunt herstellen.

### 3. Legacy statusmigraties (schijfindeling)

Doctor kan oudere on-disk indelingen migreren naar de huidige structuur:

- Sessiesopslag + transcripties:
  - van `~/.openclaw/sessions/` naar `~/.openclaw/agents/<agentId>/sessions/`
- Agentmap:
  - van `~/.openclaw/agent/` naar `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp-authstatus (Baileys):
  - van legacy `~/.openclaw/credentials/*.json` (behalve `oauth.json`)
  - naar `~/.openclaw/credentials/whatsapp/<accountId>/...` (standaard account-id: `default`)

Deze migraties zijn best-effort en idempotent; doctor geeft waarschuwingen wanneer
het legacy mappen als back-ups achterlaat. De Gateway/CLI migreert ook automatisch
de legacy sessies + agentmap bij het opstarten zodat geschiedenis/auth/modellen in het
per-agentpad terechtkomen zonder een handmatige doctor-run. WhatsApp-auth wordt
opzettelijk alleen gemigreerd via `openclaw doctor`.

### 4. Controles op statusintegriteit (sessiepersistentie, routering en veiligheid)

De statusmap is het operationele zenuwcentrum. Als deze verdwijnt, verlies je
sessies, referenties, logs en config (tenzij je elders back-ups hebt).

Doctor controleert:

- **Statusmap ontbreekt**: waarschuwt voor catastrofaal statusverlies, vraagt om
  de map opnieuw aan te maken en herinnert eraan dat ontbrekende data niet kan worden hersteld.
- **Statusmappermissies**: verifieert schrijfbaarheid; biedt aan permissies te herstellen
  (en geeft een `chown`-hint bij een eigenaar/groep-mismatch).
- **Sessiemappen ontbreken**: `sessions/` en de sessiesopslagmap zijn vereist
  om geschiedenis te behouden en `ENOENT`-crashes te voorkomen.
- **Transcript-mismatch**: waarschuwt wanneer recente sessie-items ontbrekende
  transcriptbestanden hebben.
- **Hoofdsessie “1-regel JSONL”**: markeert wanneer het hoofdtranscript slechts één
  regel heeft (geschiedenis stapelt niet op).
- **Meerdere statusmappen**: waarschuwt wanneer meerdere `~/.openclaw`-mappen bestaan
  over home directories of wanneer `OPENCLAW_STATE_DIR` ergens anders naartoe wijst
  (geschiedenis kan zich splitsen tussen installaties).
- **Herinnering aan remote-modus**: als `gateway.mode=remote`, herinnert doctor je eraan
  het op de remote host uit te voeren (de status leeft daar).
- **Configbestandspermissies**: waarschuwt als `~/.openclaw/openclaw.json`
  leesbaar is voor groep/wereld en biedt aan dit te verscherpen naar `600`.

### 5. Model-auth gezondheid (OAuth-verval)

Doctor inspecteert OAuth-profielen in de auth-opslag, waarschuwt wanneer tokens
bijna verlopen/verlopen zijn en kan ze vernieuwen wanneer veilig. Als het Anthropic Claude Code-
profiel verouderd is, stelt het voor `claude setup-token` uit te voeren (of een setup-token te plakken).
Vernieuwingsprompts verschijnen alleen bij interactief draaien (TTY); `--non-interactive`
slaat vernieuwingspogingen over.

Doctor rapporteert ook auth-profielen die tijdelijk onbruikbaar zijn door:

- korte cooldowns (rate limits/time-outs/auth-fouten)
- langere uitschakelingen (facturatie-/kredietfouten)

### 6. Hooks-modelvalidatie

Als `hooks.gmail.model` is ingesteld, valideert doctor de modelverwijzing tegen de
catalogus en toegestane lijst en waarschuwt wanneer deze niet kan worden opgelost of is uitgesloten.

### 7. Sandbox-imageherstel

Wanneer sandboxing is ingeschakeld, controleert doctor Docker-images en biedt aan
te bouwen of over te schakelen naar legacy namen als het huidige image ontbreekt.

### 8. Gateway-servicemigraties en opschoontips

Doctor detecteert legacy gateway-services (launchd/systemd/schtasks) en
biedt aan deze te verwijderen en de OpenClaw-service te installeren met de huidige gateway-
poort. Het kan ook scannen op extra gateway-achtige services en opschoontips afdrukken.
Profiel-genaamde OpenClaw gateway-services worden als eersteklas beschouwd en
niet gemarkeerd als "extra".

### 9. Beveiligingswaarschuwingen

Doctor geeft waarschuwingen wanneer een provider openstaat voor DM's zonder
toegestane lijst, of wanneer een beleid gevaarlijk is geconfigureerd.

### 10. systemd linger (Linux)

Bij draaien als systemd user service zorgt doctor ervoor dat lingering is ingeschakeld
zodat de gateway actief blijft na uitloggen.

### 11. Skills-status

Doctor print een snel overzicht van geschikte/ontbrekende/geblokkeerde skills voor de huidige
werkruimte.

### 12. Gateway-authcontroles (lokaal token)

Doctor waarschuwt wanneer `gateway.auth` ontbreekt op een lokale gateway en
biedt aan een token te genereren. Gebruik `openclaw doctor --generate-gateway-token` om
tokencreatie in automatisering af te dwingen.

### 13. Gateway-gezondheidscontrole + herstart

Doctor voert een gezondheidscontrole uit en biedt aan de gateway te herstarten wanneer
deze er ongezond uitziet.

### 14. Kanaalstatuswaarschuwingen

Als de gateway gezond is, voert doctor een kanaalstatusprobe uit en rapporteert
waarschuwingen met voorgestelde oplossingen.

### 15. Supervisor-configaudit + reparatie

Doctor controleert de geïnstalleerde supervisor-config (launchd/systemd/schtasks) op
ontbrekende of verouderde standaardwaarden (bijv. systemd network-online afhankelijkheden en
herstartvertraging). Bij een mismatch beveelt het een update aan en kan
het servicebestand/de taak herschrijven naar de huidige standaardwaarden.

Notities:

- `openclaw doctor` vraagt om bevestiging voordat de supervisor-config wordt herschreven.
- `openclaw doctor --yes` accepteert de standaard reparatieprompts.
- `openclaw doctor --repair` past aanbevolen fixes toe zonder prompts.
- `openclaw doctor --repair --force` overschrijft aangepaste supervisor-configs.
- Je kunt altijd een volledige herschrijving afdwingen via `openclaw gateway install --force`.

### 16. Gateway-runtime- en poortdiagnostiek

Doctor inspecteert de service-runtime (PID, laatste exitstatus) en waarschuwt wanneer de
service is geïnstalleerd maar niet daadwerkelijk draait. Het controleert ook op poortconflicten
op de gateway-poort (standaard `18789`) en rapporteert waarschijnlijke oorzaken (gateway draait al,
SSH-tunnel).

### 17. Gateway-runtime best practices

Doctor waarschuwt wanneer de gateway-service draait op Bun of een version-managed Node-pad
(`nvm`, `fnm`, `volta`, `asdf`, enz.). WhatsApp- en Telegram-kanalen vereisen Node,
en version-managerpaden kunnen breken na upgrades omdat de service je shell-init niet laadt. Doctor biedt aan te migreren naar een systeem-Node-installatie wanneer beschikbaar
(Homebrew/apt/choco).

### 18. Config-wegschrijven + wizard-metadata

Doctor slaat eventuele configwijzigingen op en stempelt wizard-metadata om de
doctor-run vast te leggen.

### 19. Werkruimtetips (back-up + geheugensysteem)

Doctor stelt een werkruimte-geheugensysteem voor wanneer dit ontbreekt en print een back-uptip
als de werkruimte nog niet onder git staat.

Zie [/concepts/agent-workspace](/concepts/agent-workspace) voor een volledige gids over
werkruimtestructuur en git-back-up (aanbevolen: privé GitHub of GitLab).
