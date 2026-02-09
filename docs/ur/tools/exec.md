---
summary: "Exec ٹول کا استعمال، stdin موڈز، اور TTY سپورٹ"
read_when:
  - Exec ٹول کا استعمال یا ترمیم کرتے وقت
  - stdin یا TTY کے رویّے کی ڈیبگنگ کرتے وقت
title: "Exec ٹول"
---

# Exec ٹول

ورک اسپیس میں شیل کمانڈز چلائیں۔ Supports foreground + background execution via `process`.
اگر `process` غیر مجاز ہو، تو `exec` ہم وقت چلتا ہے اور `yieldMs`/`background` کو نظرانداز کرتا ہے۔
Background sessions are scoped per agent; `process` only sees sessions from the same agent.

## Parameters

- `command` (لازم)
- `workdir` (بطورِ طے شدہ cwd)
- `env` (key/value اوور رائیڈز)
- `yieldMs` (بطورِ طے شدہ 10000): تاخیر کے بعد خودکار بیک گراؤنڈ
- `background` (bool): فوراً بیک گراؤنڈ
- `timeout` (سیکنڈز، بطورِ طے شدہ 1800): معیاد ختم ہونے پر بند کریں
- `pty` (bool): دستیاب ہونے پر pseudo-terminal میں چلائیں (صرف TTY والے CLIs، کوڈنگ ایجنٹس، ٹرمینل UIs)
- `host` (`sandbox | gateway | node`): کہاں اجرا کرنا ہے
- `security` (`deny | allowlist | full`): `gateway`/`node` کے لیے نفاذی موڈ
- `ask` (`off | on-miss | always`): `gateway`/`node` کے لیے منظوری پرامپٹس
- `node` (string): `host=node` کے لیے نوڈ آئی ڈی/نام
- `elevated` (bool): بلند اختیاراتی موڈ کی درخواست (گیٹ وے ہوسٹ)؛ `security=full` صرف تب لازمی ہوتا ہے جب elevated حل ہو کر `full` بنے

Notes:

- `host` بطورِ طے شدہ `sandbox` ہوتا ہے۔
- sandboxing بند ہونے پر `elevated` نظر انداز کیا جاتا ہے (exec پہلے ہی ہوسٹ پر چلتا ہے)۔
- `gateway`/`node` کی منظوریات `~/.openclaw/exec-approvals.json` کے ذریعے کنٹرول ہوتی ہیں۔
- `node` کے لیے جوڑا ہوا نوڈ درکار ہے (معاون ایپ یا ہیڈ لیس نوڈ ہوسٹ)۔
- اگر متعدد نوڈز دستیاب ہوں، تو ایک منتخب کرنے کے لیے `exec.node` یا `tools.exec.node` سیٹ کریں۔
- نان-ونڈوز ہوسٹس پر، exec سیٹ ہونے پر `SHELL` استعمال کرتا ہے؛ اگر `SHELL` `fish` ہو، تو fish سے غیر مطابقت رکھنے والی اسکرپٹس سے بچنے کے لیے `PATH` میں سے `bash` (یا `sh`) کو ترجیح دیتا ہے، پھر اگر دونوں موجود نہ ہوں تو `SHELL` پر واپس آتا ہے۔
- ہوسٹ اجرا (`gateway`/`node`) بائنری ہائی جیکنگ یا انجیکٹڈ کوڈ سے بچاؤ کے لیے `env.PATH` اور لوڈر اوور رائیڈز (`LD_*`/`DYLD_*`) کو مسترد کرتا ہے۔
- Important: sandboxing is **off by default**. If sandboxing is off, `host=sandbox` runs directly on
  the gateway host (no container) and **does not require approvals**. To require approvals, run with
  `host=gateway` and configure exec approvals (or enable sandboxing).

## Config

- `tools.exec.notifyOnExit` (بطورِ طے شدہ: true): true ہونے پر، بیک گراؤنڈ کیے گئے exec سیشنز ایک سسٹم ایونٹ قطار میں ڈالتے ہیں اور اختتام پر ہارٹ بیٹ کی درخواست کرتے ہیں۔
- `tools.exec.approvalRunningNoticeMs` (بطورِ طے شدہ: 10000): جب منظوری سے مشروط exec اس مدت سے زیادہ چلے تو ایک واحد “running” نوٹس جاری کریں (0 غیر فعال کرتا ہے)۔
- `tools.exec.host` (بطورِ طے شدہ: `sandbox`)
- `tools.exec.security` (بطورِ طے شدہ: sandbox کے لیے `deny`، اور گیٹ وے + نوڈ کے لیے `allowlist` جب غیر سیٹ ہو)
- `tools.exec.ask` (بطورِ طے شدہ: `on-miss`)
- `tools.exec.node` (بطورِ طے شدہ: unset)
- `tools.exec.pathPrepend`: exec رنز کے لیے `PATH` میں prepend کرنے والی ڈائریکٹریز کی فہرست۔
- `tools.exec.safeBins`: صرف-stdin محفوظ بائنریز جو صریح allowlist اندراجات کے بغیر چل سکتی ہیں۔

Example:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH handling

- `host=gateway`: merges your login-shell `PATH` into the exec environment. `env.PATH` overrides are
  rejected for host execution. The daemon itself still runs with a minimal `PATH`:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: runs `sh -lc` (login shell) inside the container, so `/etc/profile` may reset `PATH`.
  OpenClaw prepends `env.PATH` after profile sourcing via an internal env var (no shell interpolation);
  `tools.exec.pathPrepend` applies here too.
- `host=node`: only non-blocked env overrides you pass are sent to the node. `env.PATH` overrides are
  rejected for host execution. Headless node hosts accept `PATH` only when it prepends the node host
  PATH (no replacement). macOS nodes drop `PATH` overrides entirely.

ہر ایجنٹ کے لیے نوڈ بائنڈنگ (کنفیگ میں ایجنٹ لسٹ انڈیکس استعمال کریں):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

کنٹرول UI: Nodes ٹیب میں انہی سیٹنگز کے لیے ایک چھوٹا “Exec node binding” پینل شامل ہے۔

## Session overrides (`/exec`)

Use `/exec` to set **per-session** defaults for `host`, `security`, `ask`, and `node`.
Send `/exec` with no arguments to show the current values.

Example:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Authorization model

`/exec` is only honored for **authorized senders** (channel allowlists/pairing plus `commands.useAccessGroups`).
It updates **session state only** and does not write config. To hard-disable exec, deny it via tool
policy (`tools.deny: ["exec"]` or per-agent). Host approvals still apply unless you explicitly set
`security=full` and `ask=off`.

## Exec approvals (companion app / node host)

Sandboxed agents can require per-request approval before `exec` runs on the gateway or node host.
See [Exec approvals](/tools/exec-approvals) for the policy, allowlist, and UI flow.

When approvals are required, the exec tool returns immediately with
`status: "approval-pending"` and an approval id. Once approved (or denied / timed out),
the Gateway emits system events (`Exec finished` / `Exec denied`). If the command is still
running after `tools.exec.approvalRunningNoticeMs`, a single `Exec running` notice is emitted.

## Allowlist + safe bins

Allowlist enforcement matches **resolved binary paths only** (no basename matches). When
`security=allowlist`, shell commands are auto-allowed only if every pipeline segment is
allowlisted or a safe bin. Chaining (`;`, `&&`, `||`) and redirections are rejected in
allowlist mode.

## Examples

Foreground:

```json
{ "tool": "exec", "command": "ls -la" }
```

Background + poll:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Send keys (tmux-style):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Submit (صرف CR بھیجیں):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Paste (بطورِ طے شدہ bracketed):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (تجرباتی)

`apply_patch` is a subtool of `exec` for structured multi-file edits.
Enable it explicitly:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Notes:

- صرف OpenAI/OpenAI Codex ماڈلز کے لیے دستیاب۔
- ٹول پالیسی بدستور لاگو رہتی ہے؛ `allow: ["exec"]` بالواسطہ طور پر `apply_patch` کی اجازت دیتا ہے۔
- کنفیگ `tools.exec.applyPatch` کے تحت موجود ہے۔
