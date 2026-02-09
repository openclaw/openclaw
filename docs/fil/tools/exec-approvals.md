---
summary: "Mga exec approval, allowlist, at mga prompt para sa paglabas ng sandbox"
read_when:
  - Pagko-configure ng exec approvals o mga allowlist
  - Pagpapatupad ng exec approval UX sa macOS app
  - Pagsusuri ng mga sandbox escape prompt at mga implikasyon
title: "Exec Approvals"
---

# Exec approvals

Exec approvals are the **companion app / node host guardrail** for letting a sandboxed agent run
commands on a real host (`gateway` or `node`). Think of it like a safety interlock:
commands are allowed only when policy + allowlist + (optional) user approval all agree.
48. Ang mga pag-apruba sa exec ay **dagdag pa** sa tool policy at elevated gating (maliban kung ang elevated ay nakatakda sa `full`, na nilalaktawan ang mga pag-apruba).
Effective policy is the **stricter** of `tools.exec.*` and approvals defaults; if an approvals field is omitted, the `tools.exec` value is used.

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

49. Ang mga allowlist ay **per agent**. 50. Kung mayroong maraming agent, palitan kung aling agent ang iyong
    ine-edit sa macOS app. 1. Ang mga pattern ay **case-insensitive glob matches**.
50. Ang mga pattern ay dapat mag-resolve sa **binary paths** (binabalewala ang mga entry na basename-only).
    Legacy `agents.default` entries are migrated to `agents.main` on load.

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

3. Kapag naka-enable ang **Auto-allow skill CLIs**, ang mga executable na tinutukoy ng mga kilalang skill ay itinuturing na nasa allowlist sa mga node (macOS node o headless node host). This uses
   `skills.bins` over the Gateway RPC to fetch the skill bin list. 4. I-disable ito kung gusto mo ng mahigpit na manual allowlists.

## Safe bins (stdin-only)

5. Tinutukoy ng `tools.exec.safeBins` ang isang maliit na listahan ng mga **stdin-only** na binary (halimbawa `jq`) na maaaring tumakbo sa allowlist mode **nang walang** tahasang allowlist entry. Safe bins reject
   positional file args and path-like tokens, so they can only operate on the incoming stream.
6. Ang shell chaining at mga redirection ay hindi awtomatikong pinapahintulutan sa allowlist mode.

7. Pinapayagan ang shell chaining (`&&`, `||`, `;`) kapag ang bawat top-level na segment ay tumutupad sa allowlist (kabilang ang safe bins o skill auto-allow). Redirections remain unsupported in allowlist mode.
   Ang command substitution (`$()` / backticks) ay tinatanggihan habang pinoproseso ang allowlist, kabilang ang nasa loob ng
   double quotes; gumamit ng single quotes kung kailangan mo ng literal na `$()` na teksto.

Mga default na safe bin: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Control UI editing

Gamitin ang **Control UI → Nodes → Exec approvals** card para i-edit ang mga default, mga override per‑agent, at mga allowlist. Pumili ng scope (Defaults o isang agent), ayusin ang policy,
dagdagan/alisin ang mga pattern sa allowlist, pagkatapos ay **Save**. Ipinapakita ng UI ang **last used** na metadata
kada pattern para manatiling maayos ang listahan.

Pinipili ng target selector ang **Gateway** (local approvals) o isang **Node**. Ang mga node
ay dapat mag-advertise ng `system.execApprovals.get/set` (macOS app o headless node host).
Kung ang isang node ay hindi pa nag-a-advertise ng exec approvals, i-edit ang lokal nitong
`~/.openclaw/exec-approvals.json` nang direkta.

CLI: Sinusuportahan ng `openclaw approvals` ang pag-edit sa gateway o node (tingnan ang [Approvals CLI](/cli/approvals)).

## Daloy ng approval

Kapag kailangan ng prompt, bino-broadcast ng gateway ang `exec.approval.requested` sa mga operator client.
Nire-resolve ito ng Control UI at macOS app sa pamamagitan ng `exec.approval.resolve`, pagkatapos ay ipinapasa ng gateway ang
naaprubahang request sa node host.

Kapag kailangan ng approvals, agad na nagbabalik ang exec tool ng isang approval id. Gamitin ang id na iyon para
maiugnay ang mga susunod na system event (`Exec finished` / `Exec denied`). Kung walang desisyon na dumating bago ang
timeout, itinuturing ang request bilang approval timeout at ipinapakita bilang dahilan ng pagtanggi.

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

Maaari mong i-forward ang mga exec approval prompt sa anumang chat channel (kabilang ang mga plugin channel) at aprubahan
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

Ipinopost ang mga ito sa session ng agent matapos i-report ng node ang event.
Ang mga exec approval na naka-host sa gateway ay naglalabas ng parehong lifecycle events kapag natapos ang command (at opsyonal kapag tumatakbo nang mas matagal kaysa sa threshold).
Ang mga exec na may approval gate ay muling ginagamit ang approval id bilang `runId` sa mga mensaheng ito para sa madaling pag-uugnay.

## Mga implikasyon

- **full** ay makapangyarihan; mas mainam ang allowlists kung maaari.
- **ask** ay pinananatili kang kasali habang pinapayagan pa rin ang mabilis na approvals.
- Ang per-agent allowlists ay pumipigil na mag-leak ang approvals ng isang agent papunta sa iba.
- Ang mga approval ay nalalapat lamang sa mga host exec request mula sa **authorized senders**. Hindi maaaring mag-issue ng `/exec` ang mga hindi awtorisadong sender.
- `/exec security=full` ay isang session-level na convenience para sa mga awtorisadong operator at sadyang nilalaktawan ang approvals.
  Para tuluyang i-block ang host exec, itakda ang approvals security sa `deny` o tanggihan ang `exec` tool sa pamamagitan ng tool policy.

Kaugnay:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
