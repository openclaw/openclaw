---
summary: "OpenClaw میں sandboxing کیسے کام کرتا ہے: موڈز، اسکوپس، ورک اسپیس رسائی، اور امیجز"
title: Sandboxing
read_when: "جب آپ کو sandboxing کی مخصوص وضاحت درکار ہو یا agents.defaults.sandbox کو ٹیون کرنا ہو۔"
status: active
---

# Sandboxing

50. OpenClaw **Docker containers کے اندر tools** چلا سکتا ہے تاکہ blast radius کم کیا جا سکے۔
    This is **optional** and controlled by configuration (`agents.defaults.sandbox` or
    `agents.list[].sandbox`). If sandboxing is off, tools run on the host.
    The Gateway stays on the host; tool execution runs in an isolated sandbox
    when enabled.

یہ مکمل سکیورٹی حد نہیں ہے، مگر جب ماڈل کوئی ناسمجھی کرے تو فائل سسٹم
اور پروسیس رسائی کو نمایاں طور پر محدود کرتی ہے۔

## کیا چیز sandbox کی جاتی ہے

- ٹول کی عمل کاری (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, وغیرہ)۔
- اختیاری sandboxed براؤزر (`agents.defaults.sandbox.browser`)۔
  - By default, the sandbox browser auto-starts (ensures CDP is reachable) when the browser tool needs it.
    Configure via `agents.defaults.sandbox.browser.autoStart` and `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` sandboxed سیشنز کو ہوسٹ براؤزر کو صراحتاً ہدف بنانے دیتا ہے۔
  - اختیاری allowlists `target: "custom"` کو گیٹ کرتی ہیں: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`۔

Sandbox نہیں کیا جاتا:

- Gateway پروسیس خود۔
- کوئی بھی ٹول جسے صراحتاً ہوسٹ پر چلانے کی اجازت ہو (مثلاً `tools.elevated`)۔
  - **Elevated exec ہوسٹ پر چلتا ہے اور sandboxing کو بائی پاس کرتا ہے۔**
  - If sandboxing is off, `tools.elevated` does not change execution (already on host). دیکھیں [Elevated Mode](/tools/elevated)۔

## Modes

`agents.defaults.sandbox.mode` یہ کنٹرول کرتا ہے کہ sandboxing **کب** استعمال ہو:

- `"off"`: کوئی sandboxing نہیں۔
- `"non-main"`: صرف **غیر-مرکزی** سیشنز sandbox ہوں (اگر آپ عام چیٹس کو ہوسٹ پر چاہتے ہیں تو یہ بطورِ طے شدہ ہے)۔
- `"all"`: every session runs in a sandbox.
  Note: `"non-main"` is based on `session.mainKey` (default `"main"`), not agent id.
  Group/channel sessions use their own keys, so they count as non-main and will be sandboxed.

## Scope

`agents.defaults.sandbox.scope` یہ کنٹرول کرتا ہے کہ **کتنے کنٹینرز** بنائے جائیں:

- `"session"` (بطورِ طے شدہ): ہر سیشن کے لیے ایک کنٹینر۔
- `"agent"`: ہر ایجنٹ کے لیے ایک کنٹینر۔
- `"shared"`: تمام sandboxed سیشنز کے لیے ایک مشترکہ کنٹینر۔

## Workspace access

`agents.defaults.sandbox.workspaceAccess` یہ کنٹرول کرتا ہے کہ **sandbox کیا دیکھ سکتا ہے**:

- `"none"` (بطورِ طے شدہ): ٹولز `~/.openclaw/sandboxes` کے تحت ایک sandbox ورک اسپیس دیکھتے ہیں۔
- `"ro"`: ایجنٹ ورک اسپیس کو read-only طور پر `/agent` پر ماؤنٹ کرتا ہے (`write`/`edit`/`apply_patch` کو غیر فعال کرتا ہے)۔
- `"rw"`: ایجنٹ ورک اسپیس کو read/write کے ساتھ `/workspace` پر ماؤنٹ کرتا ہے۔

Inbound media is copied into the active sandbox workspace (`media/inbound/*`).
Skills note: the `read` tool is sandbox-rooted. With `workspaceAccess: "none"`,
OpenClaw mirrors eligible skills into the sandbox workspace (`.../skills`) so
they can be read. With `"rw"`, workspace skills are readable from
`/workspace/skills`.

## Custom bind mounts

`agents.defaults.sandbox.docker.binds` mounts additional host directories into the container.
Format: `host:container:mode` (e.g., `"/home/user/source:/source:rw"`).

Global and per-agent binds are **merged** (not replaced). Under `scope: "shared"`, per-agent binds are ignored.

مثال (read-only سورس + docker ساکٹ):

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

سکیورٹی نوٹس:

- Binds sandbox فائل سسٹم کو بائی پاس کرتے ہیں: وہ ہوسٹ راستوں کو اسی موڈ کے ساتھ ظاہر کرتے ہیں جو آپ سیٹ کریں (`:ro` یا `:rw`)۔
- حساس ماؤنٹس (مثلاً `docker.sock`, secrets, SSH keys) کو `:ro` ہونا چاہیے، جب تک کہ بالکل ضروری نہ ہو۔
- اگر آپ کو صرف ورک اسپیس کی read رسائی درکار ہو تو `workspaceAccess: "ro"` کے ساتھ ملائیں؛ bind موڈز آزاد رہتے ہیں۔
- یہ سمجھنے کے لیے کہ binds ٹول پالیسی اور elevated exec کے ساتھ کیسے تعامل کرتے ہیں، دیکھیں [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)۔

## Images + setup

بطورِ طے شدہ امیج: `openclaw-sandbox:bookworm-slim`

اسے ایک بار بنائیں:

```bash
scripts/sandbox-setup.sh
```

Note: the default image does **not** include Node. If a skill needs Node (or
other runtimes), either bake a custom image or install via
`sandbox.docker.setupCommand` (requires network egress + writable root +
root user).

Sandboxed براؤزر امیج:

```bash
scripts/sandbox-browser-setup.sh
```

By default, sandbox containers run with **no network**.
Override with `agents.defaults.sandbox.docker.network`.

Docker کی تنصیبات اور کنٹینرائزڈ Gateway یہاں موجود ہیں:
[Docker](/install/docker)

## setupCommand (کنٹینر کی ایک بارہ سیٹ اپ)

`setupCommand` runs **once** after the sandbox container is created (not on every run).
It executes inside the container via `sh -lc`.

راستے:

- گلوبل: `agents.defaults.sandbox.docker.setupCommand`
- Per-agent: `agents.list[].sandbox.docker.setupCommand`

عام مسائل:

- بطورِ طے شدہ `docker.network` `"none"` ہے (کوئی egress نہیں)، اس لیے پیکج انسٹالز ناکام ہوں گے۔
- `readOnlyRoot: true` لکھائی کو روکتا ہے؛ `readOnlyRoot: false` سیٹ کریں یا کسٹم امیج بنائیں۔
- پیکج انسٹالز کے لیے `user` کا root ہونا لازم ہے ( `user` کو حذف کریں یا `user: "0:0"` سیٹ کریں)۔
- Sandbox exec does **not** inherit host `process.env`. Use
  `agents.defaults.sandbox.docker.env` (or a custom image) for skill API keys.

## Tool policy + escape hatches

Tool allow/deny policies still apply before sandbox rules. If a tool is denied
globally or per-agent, sandboxing doesn’t bring it back.

`tools.elevated` is an explicit escape hatch that runs `exec` on the host.
`/exec` directives only apply for authorized senders and persist per session; to hard-disable
`exec`, use tool policy deny (see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Debugging:

- مؤثر sandbox موڈ، ٹول پالیسی، اور fix-it کنفیگ کلیدیں دیکھنے کے لیے `openclaw sandbox explain` استعمال کریں۔
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
