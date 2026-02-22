---
summary: "OpenClaw sandboxing အလုပ်လုပ်ပုံ—မုဒ်များ၊ အကျယ်အဝန်းများ၊ workspace ဝင်ရောက်ခွင့်နှင့် image များ"
title: Sandboxing
read_when: "Sandboxing ကို သီးသန့်ရှင်းလင်းချက်လိုအပ်သည့်အခါ သို့မဟုတ် agents.defaults.sandbox ကို ချိန်ညှိရန် လိုအပ်သည့်အခါ"
status: active
---

# Sandboxing

OpenClaw can run **tools inside Docker containers** to reduce blast radius.
This is **optional** and controlled by configuration (`agents.defaults.sandbox` or
`agents.list[].sandbox`). If sandboxing is off, tools run on the host.
The Gateway stays on the host; tool execution runs in an isolated sandbox
when enabled.

ဤအရာသည် ပြည့်စုံသော လုံခြုံရေးအကန့်အသတ် မဟုတ်သော်လည်း model က အမှားလုပ်ဆောင်သည့်အခါ
filesystem နှင့် process ဝင်ရောက်ခွင့်ကို အရေးပါစွာ ကန့်သတ်ပေးနိုင်သည်။

## What gets sandboxed

- Tool execution (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, စသည်တို့)။
- Optional sandboxed browser (`agents.defaults.sandbox.browser`)။
  - By default, the sandbox browser auto-starts (ensures CDP is reachable) when the browser tool needs it.
    Configure via `agents.defaults.sandbox.browser.autoStart` and `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` သည် sandboxed session များကို host browser သို့ တိတိကျကျ ညွှန်ပြနိုင်စေသည်။
  - Optional allowlists များသည် `target: "custom"` ကို gate လုပ်ပေးသည် —
    `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`။

Sandbox မလုပ်သည့်အရာများ—

- Gateway process ကိုယ်တိုင်။
- Host ပေါ်တွင် 실행 လုပ်ရန် အထူးခွင့်ပြုထားသော tool များ (ဥပမာ `tools.elevated`)။
  - **Elevated exec သည် host ပေါ်တွင် 실행 လုပ်ပြီး sandboxing ကို ကျော်လွန်သည်။**
  - If sandboxing is off, `tools.elevated` does not change execution (already on host). အသေးစိတ်ကို [Elevated Mode](/tools/elevated) မှာ ကြည့်ပါ။

## Modes

`agents.defaults.sandbox.mode` သည် sandboxing ကို **ဘယ်အချိန်မှာ** အသုံးပြုမည်ကို ထိန်းချုပ်သည်—

- `"off"`: sandboxing မလုပ်ပါ။
- `"non-main"`: **non-main** sessions များအတွက်သာ sandbox (host ပေါ်တွင် ပုံမှန် chat များကို လိုလားပါက default)။
- `"all"`: every session runs in a sandbox.
  Note: `"non-main"` is based on `session.mainKey` (default `"main"`), not agent id.
  Group/channel sessions use their own keys, so they count as non-main and will be sandboxed.

## Scope

`agents.defaults.sandbox.scope` သည် **container အရေအတွက်** ကို ထိန်းချုပ်သည်—

- `"session"` (default): session တစ်ခုလျှင် container တစ်ခု။
- `"agent"`: agent တစ်ခုလျှင် container တစ်ခု။
- `"shared"`: sandboxed session အားလုံးအတွက် container တစ်ခုကို မျှဝေသုံးစွဲသည်။

## Workspace access

`agents.defaults.sandbox.workspaceAccess` သည် **sandbox မှ မြင်နိုင်သောအရာများ** ကို ထိန်းချုပ်သည်—

- `"none"` (default): tools များသည် `~/.openclaw/sandboxes` အောက်ရှိ sandbox workspace ကို မြင်နိုင်သည်။
- `"ro"`: agent workspace ကို `/agent` တွင် read-only အဖြစ် mount လုပ်သည်
  (`write`/`edit`/`apply_patch` ကို ပိတ်ထားသည်)။
- `"rw"`: agent workspace ကို `/workspace` တွင် read/write အဖြစ် mount လုပ်သည်။

Inbound media is copied into the active sandbox workspace (`media/inbound/*`).
Skills note: the `read` tool is sandbox-rooted. With `workspaceAccess: "none"`,
OpenClaw mirrors eligible skills into the sandbox workspace (`.../skills`) so
they can be read. With `"rw"`, workspace skills are readable from
`/workspace/skills`.

## Custom bind mounts

`agents.defaults.sandbox.docker.binds` mounts additional host directories into the container.
Format: `host:container:mode` (e.g., `"/home/user/source:/source:rw"`).

Global and per-agent binds are **merged** (not replaced). Under `scope: "shared"`, per-agent binds are ignored.

ဥပမာ (read-only source + docker socket)—

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

Security မှတ်ချက်များ—

- Bind များသည် sandbox filesystem ကို ကျော်လွန်ပြီး သင်သတ်မှတ်ထားသော mode (`:ro` သို့မဟုတ် `:rw`) ဖြင့် host path များကို ဖော်ထုတ်ပေးသည်။
- အရေးကြီးသော mount များ (ဥပမာ `docker.sock`, secrets, SSH keys) ကို မဖြစ်မနေ မလိုအပ်ပါက `:ro` အဖြစ် သတ်မှတ်သင့်သည်။
- Workspace ကို read access သာ လိုအပ်ပါက `workspaceAccess: "ro"` နှင့် ပေါင်းစပ်အသုံးပြုပါ; bind mode များသည် သီးခြားအဖြစ် ဆက်လက်သက်ရောက်သည်။
- Bind များသည် tool policy နှင့် elevated exec တို့နှင့် မည်သို့ အပြန်အလှန် သက်ရောက်သည်ကို
  [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) တွင် ကြည့်ပါ။

## Images + setup

Default image: `openclaw-sandbox:bookworm-slim`

တစ်ကြိမ်သာ build လုပ်ပါ—

```bash
scripts/sandbox-setup.sh
```

Note: the default image does **not** include Node. If a skill needs Node (or
other runtimes), either bake a custom image or install via
`sandbox.docker.setupCommand` (requires network egress + writable root +
root user).

Sandboxed browser image—

```bash
scripts/sandbox-browser-setup.sh
```

By default, sandbox containers run with **no network**.
Override with `agents.defaults.sandbox.docker.network`.

Docker install များနှင့် containerized gateway တည်ရှိရာ—
[Docker](/install/docker)

## setupCommand (one-time container setup)

`setupCommand` runs **once** after the sandbox container is created (not on every run).
It executes inside the container via `sh -lc`.

Paths—

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Per-agent: `agents.list[].sandbox.docker.setupCommand`

Common pitfalls—

- Default `docker.network` သည် `"none"` (egress မရှိ) ဖြစ်သောကြောင့် package install များ မအောင်မြင်နိုင်ပါ။
- `readOnlyRoot: true` သည် write ကို တားဆီးသည်; `readOnlyRoot: false` သတ်မှတ်ပါ သို့မဟုတ် custom image တစ်ခု bake လုပ်ပါ။
- Package install များအတွက် `user` သည် root ဖြစ်ရမည်
  (`user` ကို ဖယ်ရှားပါ သို့မဟုတ် `user: "0:0"` ကို သတ်မှတ်ပါ)။
- Sandbox exec does **not** inherit host `process.env`. Use
  `agents.defaults.sandbox.docker.env` (or a custom image) for skill API keys.

## Tool policy + escape hatches

Tool allow/deny policies still apply before sandbox rules. If a tool is denied
globally or per-agent, sandboxing doesn’t bring it back.

`tools.elevated` is an explicit escape hatch that runs `exec` on the host.
`/exec` directives only apply for authorized senders and persist per session; to hard-disable
`exec`, use tool policy deny (see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Debugging—

- Effective sandbox mode, tool policy နှင့် fix-it config key များကို စစ်ဆေးရန် `openclaw sandbox explain` ကို အသုံးပြုပါ။
- See [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for the “why is this blocked?” mental model.
  Keep it locked down.

## Multi-agent overrides

Each agent can override sandbox + tools:
`agents.list[].sandbox` and `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools` for sandbox tool policy).
See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for precedence.

## Minimal enable example

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Related docs

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
