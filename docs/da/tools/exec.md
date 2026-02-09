---
summary: "Brug af Exec-værktøjet, stdin-tilstande og TTY-understøttelse"
read_when:
  - Brug eller ændring af exec-værktøjet
  - Fejlfinding af stdin- eller TTY-adfærd
title: "Exec-værktøj"
---

# Exec-værktøj

Kør shell-kommandoer i arbejdsområdet. Understøtter forgrund + baggrundsudførelse via `proces`.
Hvis `process` ikke er tilladt, kører `exec` synkront og ignorerer `yieldMs`/`background`.
Baggrundssessioner er omfattet pr. agent; `process` ser kun sessioner fra samme agent.

## Parametre

- `command` (påkrævet)
- `workdir` (standard er cwd)
- `env` (key/value-overskrivninger)
- `yieldMs` (standard 10000): auto-baggrund efter forsinkelse
- `background` (bool): baggrund med det samme
- `timeout` (sekunder, standard 1800): dræb ved udløb
- `pty` (bool): kør i en pseudo-terminal når tilgængelig (TTY-only CLI’er, coding agents, terminal-UI’er)
- `host` (`sandbox | gateway | node`): hvor der skal eksekveres
- `security` (`deny | allowlist | full`): håndhævelsestilstand for `gateway`/`node`
- `ask` (`off | on-miss | always`): godkendelsesprompter for `gateway`/`node`
- `node` (string): node-id/navn for `host=node`
- `elevated` (bool): anmod om forhøjet tilstand (gateway-vært); `security=full` gennemtvinges kun, når forhøjet løses til `full`

Noter:

- `host` er som standard `sandbox`.
- `elevated` ignoreres, når sandboxing er slået fra (exec kører allerede på værten).
- `gateway`/`node`-godkendelser styres af `~/.openclaw/exec-approvals.json`.
- `node` kræver en parret node (companion-app eller headless node host).
- Hvis flere noder er tilgængelige, så angiv `exec.node` eller `tools.exec.node` for at vælge én.
- På ikke-Windows-værter bruger exec `SHELL`, når den er sat; hvis `SHELL` er `fish`, foretrækkes `bash` (eller `sh`)
  fra `PATH` for at undgå fish-inkompatible scripts, og der faldes tilbage til `SHELL`, hvis ingen af dem findes.
- Værtsudførelse (`gateway`/`node`) afviser `env.PATH` og loader-overskrivninger (`LD_*`/`DYLD_*`) for
  at forhindre binær kapring eller injiceret kode.
- Vigtigt: sandboxing er **deaktiveret som standard**. Hvis sandboxing er slukket, 'host=sandbox' kører direkte på
  gatewayens vært (ingen container) og **kræver ikke godkendelser**. For at kræve godkendelse, skal du køre med
  `host=gateway` og konfigurere exec godkendelser (eller aktivere sandboxing).

## Konfiguration

- `tools.exec.notifyOnExit` (standard: true): når true, sætter exec-sessioner i baggrunden en systemhændelse i kø og anmoder om et heartbeat ved afslutning.
- `tools.exec.approvalRunningNoticeMs` (standard: 10000): udsender en enkelt “running”-meddelelse, når en godkendelsesstyret exec kører længere end dette (0 deaktiverer).
- `tools.exec.host` (standard: `sandbox`)
- `tools.exec.security` (standard: `deny` for sandbox, `allowlist` for gateway + node når ikke sat)
- `tools.exec.ask` (standard: `on-miss`)
- `tools.exec.node` (standard: ikke sat)
- `tools.exec.pathPrepend`: liste over mapper, der skal foranstilles til `PATH` for exec-kørsler.
- `tools.exec.safeBins`: stdin-only sikre binære filer, der kan køre uden eksplicitte allowlist-poster.

Eksempel:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH-håndtering

- `host=gateway`: fletter dit login-shell `PATH` ind i exec miljøet. `env.PATH` tilsidesættelser er
  afvist for udførelse af værten. Dæmonen selv kører stadig med en minimal `PATH`:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: kører `sh -lc` (login shell) inde i beholderen, så `/etc/profile` kan nulstille `PATH`.
  OpenClaw forbereder `env.PATH` efter profil sourcing via en intern env var (ingen shell interpolation);
  `tools.exec.pathPrepend` gælder også her.
- `host=node`: kun ikke-blokerede env tilsidesætter du passerer er sendt til noden. `env.PATH` tilsidesættelser er
  afvist for udførelse af værten. Hovedløse node værter accepterer kun `PATH` når det forbereder node vært
  PATH (ingen erstatning). macOS noder drop `PATH` tilsidesætter helt.

Per-agent node-binding (brug agentlisteindekset i konfigurationen):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Kontrol-UI: Fanen Nodes indeholder et lille panel “Exec node binding” for de samme indstillinger.

## Sessionsoverskrivninger (`/exec`)

Brug `/exec` for at angive **per-session** standardindstillinger for `host`, `security`, `ask`, og `node`.
Send `/exec` uden argumenter til at vise de aktuelle værdier.

Eksempel:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Autorisationsmodel

`/exec` er kun hædret for **autoriserede afsendere** (kanal allowlists/parring plus `commands.useAccessGroups`).
Det opdaterer **sessionstilstand kun** og skriver ikke konfiguration. For at deaktivere eksekvering, benægte den via værktøj
policy (`tools.deny: ["exec"]` eller per-agent). Værtsgodkendelser gælder stadig, medmindre du udtrykkeligt angiver
`security=full` og `ask=off`.

## Exec-godkendelser (companion-app / node host)

Sandboxed agents can require per-request approval before `exec` runs on the gateway or node host. (Automatic Copy)
Se [Exec godkendelser](/tools/exec-approvals) for politik, tilladsliste og UI flow.

Når godkendelser er påkrævet, returnerer exec værktøjet straks med
`status: "Godkendelsesafventende "` og et godkendelsesid. Når først godkendt (eller nægtet / timet ud),
Gateway udsender systembegivenheder (`Exec færdiggjort` / `Exec nægtet`). Hvis kommandoen stadig er
, der kører efter `tools.exec.approvalRunningNoticeMs`, udsendes en enkelt `Exec running` meddelelse.

## Allowlist + sikre bins

Tillads håndhævelse matcher kun **løst binære stier** (ingen basename matches). Når
`security=allowlist`, er skalkommandoer kun automatisk tilladt, hvis hvert pipeline-segment er
tilladt, eller en sikker bin. Kædemål (`;`, `&`, `~~`) og omdirigeringer afvises i tilstanden
tilladsliste.

## Eksempler

Forgrund:

```json
{ "tool": "exec", "command": "ls -la" }
```

Baggrund + polling:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Send taster (tmux-stil):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Indsend (send kun CR):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Indsæt (som standard indrammet):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (eksperimentel)

`apply_patch` er et underværktøj til `exec` for strukturerede multi-fil redigeringer.
Aktiver det udtrykkeligt:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Noter:

- Kun tilgængelig for OpenAI/OpenAI Codex-modeller.
- Værktøjspolitik gælder stadig; `allow: ["exec"]` tillader implicit `apply_patch`.
- Konfigurationen ligger under `tools.exec.applyPatch`.
