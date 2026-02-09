---
summary: "Mga tool ng agent session para sa paglista ng mga session, pagkuha ng history, at pagpapadala ng cross-session na mga mensahe"
read_when:
  - Pagdaragdag o pagbabago ng mga session tool
title: "Mga Tool ng Session"
---

# Mga Tool ng Session

Layunin: maliit at mahirap abusuhin na set ng mga tool para makapaglista ang mga agent ng mga session, makakuha ng history, at makapagpadala sa ibang session.

## Mga Pangalan ng Tool

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Modelo ng Key

- Ang pangunahing direct chat bucket ay palaging literal na key na `"main"` (nireresolba sa pangunahing key ng kasalukuyang agent).
- Ang mga group chat ay gumagamit ng `agent:<agentId>:<channel>:group:<id>` o `agent:<agentId>:<channel>:channel:<id>` (ipasa ang buong key).
- Ang mga cron job ay gumagamit ng `cron:<job.id>`.
- Ang mga hook ay gumagamit ng `hook:<uuid>` maliban kung hayagang itinakda.
- Ang mga node session ay gumagamit ng `node-<nodeId>` maliban kung hayagang itinakda.

`global` and `unknown` are reserved values and are never listed. If `session.scope = "global"`, we alias it to `main` for all tools so callers never see `global`.

## sessions_list

Ilista ang mga session bilang array ng mga row.

Mga Parameter:

- `kinds?: string[]` filter: alinman sa `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` max rows (default: server default, clamp e.g. 200)
- `activeMinutes?: number` mga session lang na na-update sa loob ng N minuto
- `messageLimit?: number` 0 = walang mga mensahe (default 0); >0 = isama ang huling N na mga mensahe

Gawi:

- Ang `messageLimit > 0` ay kumukuha ng `chat.history` bawat session at isinasama ang huling N na mga mensahe.
- Ang mga resulta ng tool ay sinasala palabas sa list output; gamitin ang `sessions_history` para sa mga mensahe ng tool.
- Kapag tumatakbo sa isang **sandboxed** na agent session, ang mga session tool ay default sa **spawned-only visibility** (tingnan sa ibaba).

Hugis ng row (JSON):

- `key`: session key (string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (group display label kung available)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (session override kung nakatakda)
- `lastChannel`, `lastTo`
- `deliveryContext` (normalized `{ channel, to, accountId }` kapag available)
- `transcriptPath` (best-effort na path na hinango mula sa store dir + sessionId)
- `messages?` (kapag `messageLimit > 0` lang)

## sessions_history

Kunin ang transcript para sa isang session.

Mga Parameter:

- `sessionKey` (kinakailangan; tumatanggap ng session key o `sessionId` mula sa `sessions_list`)
- `limit?: number` max na mga mensahe (kinaklamp ng server)
- `includeTools?: boolean` (default false)

Gawi:

- Ang `includeTools=false` ay nagsasala ng mga `role: "toolResult"` na mensahe.
- Nagbabalik ng array ng mga mensahe sa raw transcript format.
- Kapag binigyan ng `sessionId`, nireresolba ito ng OpenClaw sa katumbas na session key (error kapag kulang ang mga id).

## sessions_send

Magpadala ng mensahe sa ibang session.

Mga Parameter:

- `sessionKey` (kinakailangan; tumatanggap ng session key o `sessionId` mula sa `sessions_list`)
- `message` (kinakailangan)
- `timeoutSeconds?: number` (default >0; 0 = fire-and-forget)

Gawi:

- `timeoutSeconds = 0`: i-enqueue at ibalik ang `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0`: maghintay ng hanggang N segundo para sa pagkumpleto, pagkatapos ay ibalik ang `{ runId, status: "ok", reply }`.
- If wait times out: `{ runId, status: "timeout", error }`. Run continues; call `sessions_history` later.
- Kung mabigo ang run: `{ runId, status: "error", error }`.
- Inaanunsyo ang delivery runs pagkatapos makumpleto ang primary run at best-effort ito; hindi ginagarantiya ng `status: "ok"` na naihatid ang anunsyo.
- Naghihintay sa pamamagitan ng gateway `agent.wait` (server-side) upang hindi mawala ang paghihintay sa mga reconnect.
- Ini-inject ang agent-to-agent message context para sa primary run.
- Pagkatapos makumpleto ang primary run, nagpapatakbo ang OpenClaw ng **reply-back loop**:
  - Ang Round 2+ ay salitan sa pagitan ng requester at target na mga agent.
  - Tumugon nang eksakto ng `REPLY_SKIP` upang ihinto ang ping‑pong.
  - Ang max na mga turn ay `session.agentToAgent.maxPingPongTurns` (0–5, default 5).
- Kapag natapos ang loop, pinapatakbo ng OpenClaw ang **agent‑to‑agent announce step** (target agent lang):
  - Tumugon nang eksakto ng `ANNOUNCE_SKIP` upang manatiling tahimik.
  - Anumang ibang tugon ay ipinapadala sa target na channel.
  - Kasama sa announce step ang orihinal na request + round‑1 reply + pinakabagong ping‑pong reply.

## Field ng Channel

- Para sa mga grupo, ang `channel` ang channel na naitala sa entry ng session.
- Para sa mga direct chat, ang `channel` ay nagma-map mula sa `lastChannel`.
- Para sa cron/hook/node, ang `channel` ay `internal`.
- Kung wala, ang `channel` ay `unknown`.

## Seguridad / Patakaran sa Pagpapadala

Policy-based na pagharang ayon sa channel/uri ng chat (hindi ayon sa session id).

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

Runtime override (bawat entry ng session):

- `sendPolicy: "allow" | "deny"` (hindi nakatakda = minamana ang config)
- Naise-set sa pamamagitan ng `sessions.patch` o owner-only na `/send on|off|inherit` (standalone na mensahe).

Mga puntong pinaiiral:

- `chat.send` / `agent` (gateway)
- auto-reply delivery logic

## sessions_spawn

Mag-spawn ng sub-agent run sa isang isolated na session at i-announce ang resulta pabalik sa requester chat channel.

Mga Parameter:

- `task` (kinakailangan)
- `label?` (opsyonal; ginagamit para sa logs/UI)
- `agentId?` (opsyonal; mag-spawn sa ilalim ng ibang agent id kung pinapayagan)
- `model?` (opsyonal; ina-override ang sub-agent model; error kapag invalid ang value)
- `runTimeoutSeconds?` (default 0; kapag nakatakda, ina-abort ang sub-agent run pagkalipas ng N segundo)
- `cleanup?` (`delete|keep`, default `keep`)

Allowlist:

- `agents.list[].subagents.allowAgents`: list of agent ids allowed via `agentId` (`["*"]` to allow any). Default: only the requester agent.

Discovery:

- Gamitin ang `agents_list` upang tuklasin kung aling mga agent id ang pinapayagan para sa `sessions_spawn`.

Gawi:

- Nagsisimula ng bagong `agent:<agentId>:subagent:<uuid>` session na may `deliver: false`.
- Ang mga sub-agent ay default sa buong set ng tool **maliban sa mga session tool** (na iko-configure sa pamamagitan ng `tools.subagents.tools`).
- Hindi pinapayagan ang mga sub-agent na tumawag ng `sessions_spawn` (walang sub-agent → sub-agent spawning).
- Laging non-blocking: agad na ibinabalik ang `{ status: "accepted", runId, childSessionKey }`.
- Pagkatapos ng pagkumpleto, pinapatakbo ng OpenClaw ang sub-agent **announce step** at ipinopost ang resulta sa requester chat channel.
- Tumugon nang eksakto ng `ANNOUNCE_SKIP` sa panahon ng announce step upang manatiling tahimik.
- Ang mga announce reply ay nino-normalize sa `Status`/`Result`/`Notes`; ang `Status` ay nagmumula sa runtime outcome (hindi sa model text).
- Ang mga sub-agent session ay awtomatikong ina-archive pagkatapos ng `agents.defaults.subagents.archiveAfterMinutes` (default: 60).
- Kasama sa mga announce reply ang isang stats line (runtime, tokens, sessionKey/sessionId, transcript path, at opsyonal na cost).

## Sandbox na Visibility ng Session

Maaaring gumamit ng mga session tool ang mga sandboxed session, ngunit bilang default ay nakikita lang nila ang mga session na sila mismo ang nag-spawn sa pamamagitan ng `sessions_spawn`.

Config:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
