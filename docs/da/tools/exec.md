---
summary: "Brug af Exec-værktøjet, stdin-tilstande og TTY-understøttelse"
read_when:
  - Brug eller ændring af exec-værktøjet
  - Fejlfinding af stdin- eller TTY-adfærd
title: "Exec-værktøj"
x-i18n:
  source_path: tools/exec.md
  source_hash: 3b32238dd8dce93d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:59Z
---

# Exec-værktøj

Kør shell-kommandoer i workspace. Understøtter forgrunds- og baggrundskørsel via `process`.
Hvis `process` ikke er tilladt, kører `exec` synkront og ignorerer `yieldMs`/`background`.
Baggrundssessioner er afgrænset pr. agent; `process` ser kun sessioner fra samme agent.

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
- Vigtigt: sandboxing er **slået fra som standard**. Hvis sandboxing er slået fra, kører `host=sandbox` direkte på
  gateway-værten (ingen container) og **kræver ikke godkendelser**. For at kræve godkendelser skal du køre med
  `host=gateway` og konfigurere exec-godkendelser (eller aktivere sandboxing).

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

- `host=gateway`: fletter din login-shells `PATH` ind i exec-miljøet. `env.PATH`-overskrivninger
  afvises for værtsudførelse. Selve dæmonen kører stadig med en minimal `PATH`:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: kører `sh -lc` (login-shell) inde i containeren, så `/etc/profile` kan nulstille `PATH`.
  OpenClaw foranstiller `env.PATH` efter profilindlæsning via en intern env-var (ingen shell-interpolation);
  `tools.exec.pathPrepend` gælder også her.
- `host=node`: kun ikke-blokerede env-overskrivninger, som du angiver, sendes til noden. `env.PATH`-overskrivninger
  afvises for værtsudførelse. Headless node hosts accepterer `PATH` kun, når den foranstiller node-hostens
  PATH (ingen erstatning). macOS-noder dropper `PATH`-overskrivninger helt.

Per-agent node-binding (brug agentlisteindekset i konfigurationen):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Kontrol-UI: Fanen Nodes indeholder et lille panel “Exec node binding” for de samme indstillinger.

## Sessionsoverskrivninger (`/exec`)

Brug `/exec` til at sætte **per-session** standarder for `host`, `security`, `ask` og `node`.
Send `/exec` uden argumenter for at vise de aktuelle værdier.

Eksempel:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Autorisationsmodel

`/exec` honoreres kun for **autoriserede afsendere** (kanal-allowlists/parring plus `commands.useAccessGroups`).
Den opdaterer **kun sessionstilstand** og skriver ikke konfiguration. For at deaktivere exec permanent skal du nægte det via værktøjspolitik
(`tools.deny: ["exec"]` eller pr. agent). Værtsgodkendelser gælder stadig, medmindre du eksplicit sætter
`security=full` og `ask=off`.

## Exec-godkendelser (companion-app / node host)

Sandboxede agents kan kræve godkendelse pr. anmodning, før `exec` kører på gateway- eller node-værten.
Se [Exec approvals](/tools/exec-approvals) for politikken, allowlisten og UI-flowet.

Når godkendelser er påkrævet, returnerer exec-værktøjet straks med
`status: "approval-pending"` og et godkendelses-id. Når der er godkendt (eller afvist / timeout),
udsender Gateway systemhændelser (`Exec finished` / `Exec denied`). Hvis kommandoen stadig
kører efter `tools.exec.approvalRunningNoticeMs`, udsendes én enkelt `Exec running`-meddelelse.

## Allowlist + sikre bins

Allowlist-håndhævelse matcher **kun opløste binære stier** (ingen basename-matches). Når
`security=allowlist`, tillades shell-kommandoer automatisk kun, hvis hvert pipeline-segment er
allowlistet eller et sikkert bin. Kædning (`;`, `&&`, `||`) og omdirigeringer afvises i
allowlist-tilstand.

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

`apply_patch` er et under-værktøj af `exec` til strukturerede redigeringer på tværs af flere filer.
Aktivér det eksplicit:

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
