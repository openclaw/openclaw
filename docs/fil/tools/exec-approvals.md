---
summary: "Mga exec approval, allowlist, at mga prompt para sa paglabas ng sandbox"
read_when:
  - Pagko-configure ng exec approvals o mga allowlist
  - Pagpapatupad ng exec approval UX sa macOS app
  - Pagsusuri ng mga sandbox escape prompt at mga implikasyon
title: "Exec Approvals"
x-i18n:
  source_path: tools/exec-approvals.md
  source_hash: 66630b5d79671dd4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:11Z
---

# Exec approvals

Ang exec approvals ay ang **companion app / node host guardrail** para payagan ang isang sandboxed agent na magpatakbo ng
mga command sa isang totoong host (`gateway` o `node`). Isipin ito bilang isang safety interlock:
pinapayagan lang ang mga command kapag nagkakasundo ang policy + allowlist + (opsyonal) pag-apruba ng user.
Ang exec approvals ay **dagdag pa** sa tool policy at elevated gating (maliban kung ang elevated ay nakatakda sa `full`, na nilalaktawan ang approvals).
Ang epektibong policy ay ang **mas mahigpit** sa pagitan ng `tools.exec.*` at mga default ng approvals; kung may approvals field na hindi isinama, gagamitin ang value ng `tools.exec`.

Kung ang companion app UI ay **hindi available**, anumang request na nangangailangan ng prompt ay
nireresolba ng **ask fallback** (default: deny).

## Saan ito naaangkop

Ang exec approvals ay ipinapatupad nang lokal sa execution host:

- **gateway host** → `openclaw` na proseso sa gateway machine
- **node host** → node runner (macOS companion app o headless node host)

macOS split:

- **node host service** → ipinapasa ang `system.run` papunta sa **macOS app** sa pamamagitan ng local IPC.
- **macOS app** → nagpapatupad ng approvals + nagpapatakbo ng command sa UI context.

## Mga setting at storage

Ang approvals ay nakaimbak sa isang lokal na JSON file sa execution host:

`~/.openclaw/exec-approvals.json`

Halimbawang schema:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## Mga policy knob

### Security (`exec.security`)

- **deny**: harangin ang lahat ng host exec request.
- **allowlist**: payagan lamang ang mga command na nasa allowlist.
- **full**: payagan ang lahat (katumbas ng elevated).

### Ask (`exec.ask`)

- **off**: huwag kailanman mag-prompt.
- **on-miss**: mag-prompt lang kapag hindi tumugma ang allowlist.
- **always**: mag-prompt sa bawat command.

### Ask fallback (`askFallback`)

Kung kailangan ang prompt pero walang UI na maaabot, ang fallback ang magpapasya:

- **deny**: harangin.
- **allowlist**: payagan lang kung tumugma ang allowlist.
- **full**: payagan.

## Allowlist (per agent)

Ang mga allowlist ay **per agent**. Kung may maraming agent, lumipat kung aling agent ang ine-edit sa macOS app.
Ang mga pattern ay **case-insensitive na glob matches**.
Dapat mag-resolve ang mga pattern sa **binary paths** (hindi pinapansin ang mga entry na basename-only).
Ang mga legacy `agents.default` na entry ay mina-migrate patungo sa `agents.main` kapag naglo-load.

Mga halimbawa:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Bawat allowlist entry ay nagta-track ng:

- **id** na stable UUID na ginagamit para sa UI identity (opsyonal)
- **last used** na timestamp
- **last used command**
- **last resolved path**

## Auto-allow skill CLIs

Kapag naka-enable ang **Auto-allow skill CLIs**, ang mga executable na tinutukoy ng mga kilalang Skills
ay itinuturing na nasa allowlist sa mga node (macOS node o headless node host). Ginagamit nito ang
`skills.bins` sa Gateway RPC para kunin ang listahan ng skill bin. I-disable ito kung gusto mo ng mahigpit na manual allowlists.

## Safe bins (stdin-only)

Ang `tools.exec.safeBins` ay naglalarawan ng isang maliit na listahan ng mga **stdin-only** na binary (halimbawa `jq`)
na maaaring patakbuhin sa allowlist mode **nang walang** tahasang allowlist entries. Tinatanggihan ng mga safe bin ang
positional file args at mga path-like token, kaya maaari lamang silang gumana sa papasok na stream.
Ang shell chaining at mga redirection ay hindi awtomatikong pinapayagan sa allowlist mode.

Ang shell chaining (`&&`, `||`, `;`) ay pinapayagan kapag ang bawat top-level segment ay tumutugon sa allowlist
(kabilang ang mga safe bin o skill auto-allow). Ang mga redirection ay nananatiling hindi suportado sa allowlist mode.
Ang command substitution (`$()` / backticks) ay tinatanggihan habang nagpa-parse ng allowlist, kabilang ang nasa loob ng
double quotes; gumamit ng single quotes kung kailangan mo ng literal na `$()` na text.

Mga default na safe bin: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Control UI editing

Gamitin ang **Control UI → Nodes → Exec approvals** na card para i-edit ang mga default, per‑agent
na override, at mga allowlist. Pumili ng saklaw (Defaults o isang agent), ayusin ang policy,
magdagdag/magtanggal ng mga allowlist pattern, pagkatapos ay **Save**. Ipinapakita ng UI ang **last used** na metadata
bawat pattern para mapanatiling maayos ang listahan.

Pinipili ng target selector ang **Gateway** (lokal na approvals) o isang **Node**. Ang mga node
ay dapat mag-advertise ng `system.execApprovals.get/set` (macOS app o headless node host).
Kung ang isang node ay hindi pa nag-a-advertise ng exec approvals, i-edit ang lokal nitong
`~/.openclaw/exec-approvals.json` nang direkta.

CLI: Sinusuportahan ng `openclaw approvals` ang pag-edit sa gateway o node (tingnan ang [Approvals CLI](/cli/approvals)).

## Daloy ng approval

Kapag kailangan ang prompt, ang gateway ay nagba-broadcast ng `exec.approval.requested` sa mga operator client.
Nireresolba ito ng Control UI at macOS app sa pamamagitan ng `exec.approval.resolve`, pagkatapos ay ipinapasa ng gateway ang
naaprubahang request sa node host.

Kapag kailangan ang approvals, agad na nagbabalik ang exec tool na may approval id. Gamitin ang id na iyon para
i-correlate ang mga susunod na system event (`Exec finished` / `Exec denied`). Kung walang desisyong dumating bago ang
timeout, ang request ay itinuturing na approval timeout at inilalabas bilang dahilan ng pagtanggi.

Kasama sa confirmation dialog ang:

- command + args
- cwd
- agent id
- resolved executable path
- host + policy metadata

Mga aksyon:

- **Allow once** → patakbuhin ngayon
- **Always allow** → idagdag sa allowlist + patakbuhin
- **Deny** → harangin

## Pag-forward ng approval sa mga chat channel

Maaari mong i-forward ang mga exec approval prompt sa anumang chat channel (kasama ang mga plugin channel) at aprubahan
ang mga ito gamit ang `/approve`. Ginagamit nito ang normal na outbound delivery pipeline.

Config:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

Sumagot sa chat:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS IPC flow

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Mga tala sa seguridad:

- Unix socket mode `0600`, token na nakaimbak sa `exec-approvals.json`.
- Same-UID peer check.
- Challenge/response (nonce + HMAC token + request hash) + maikling TTL.

## Mga system event

Ang exec lifecycle ay inilalantad bilang mga system message:

- `Exec running` (lamang kung lumampas ang command sa running notice threshold)
- `Exec finished`
- `Exec denied`

Ang mga ito ay ipinopost sa session ng agent matapos i-report ng node ang event.
Ang gateway-host exec approvals ay naglalabas ng parehong lifecycle event kapag natapos ang command (at opsyonal kapag mas tumagal kaysa sa threshold).
Ang mga exec na may approval gate ay muling ginagamit ang approval id bilang `runId` sa mga mensaheng ito para sa madaling pag-correlation.

## Mga implikasyon

- **full** ay makapangyarihan; mas mainam ang allowlists kung maaari.
- **ask** ay pinananatili kang kasali habang pinapayagan pa rin ang mabilis na approvals.
- Ang per-agent allowlists ay pumipigil na mag-leak ang approvals ng isang agent papunta sa iba.
- Ang approvals ay nalalapat lamang sa mga host exec request mula sa **authorized senders**. Ang mga hindi awtorisadong sender ay hindi maaaring mag-isyu ng `/exec`.
- Ang `/exec security=full` ay isang session-level na kaginhawaan para sa mga awtorisadong operator at sadyang nilalaktawan ang approvals.
  Para mahigpit na harangin ang host exec, itakda ang approvals security sa `deny` o tanggihan ang `exec` na tool sa pamamagitan ng tool policy.

Kaugnay:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
