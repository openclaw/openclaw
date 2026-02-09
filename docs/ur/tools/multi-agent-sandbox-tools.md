---
summary: "ہر ایجنٹ کے لیے sandbox اور اوزار کی پابندیاں، ترجیحی ترتیب، اور مثالیں"
title: ملٹی ایجنٹ Sandbox اور Tools
read_when: "جب آپ ملٹی ایجنٹ گیٹ وے میں ہر ایجنٹ کے لیے sandboxing یا ہر ایجنٹ کے لیے اوزار کی اجازت/ممانعت کی پالیسیاں چاہتے ہوں۔"
status: active
---

# ملٹی ایجنٹ Sandbox اور Tools کنفیگریشن

## جائزہ

ملٹی ایجنٹ سیٹ اپ میں ہر ایجنٹ اب درج ذیل اپنی الگ ترتیبات رکھ سکتا ہے:

- **Sandbox کنفیگریشن** (`agents.list[].sandbox`، `agents.defaults.sandbox` پر فوقیت رکھتا ہے)
- **اوزار کی پابندیاں** (`tools.allow` / `tools.deny`، نیز `agents.list[].tools`)

اس سے آپ مختلف سکیورٹی پروفائلز کے ساتھ متعدد ایجنٹس چلا سکتے ہیں:

- مکمل رسائی کے ساتھ ذاتی معاون
- محدود اوزاروں والے خاندانی/کام کے ایجنٹس
- sandbox میں عوامی سامنا کرنے والے ایجنٹس

`setupCommand`، `sandbox.docker` (عالمی یا فی ایجنٹ) کے تحت آتا ہے اور کنٹینر بننے کے وقت ایک بار چلتا ہے۔

تصدیق ہر ایجنٹ کے لیے الگ ہے: ہر ایجنٹ اپنی `agentDir` auth اسٹور سے پڑھتا ہے، مقام:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

ایجنٹس کے درمیان کریڈینشلز **شیئر نہیں** کیے جاتے۔ Never reuse `agentDir` across agents.
If you want to share creds, copy `auth-profiles.json` into the other agent's `agentDir`.

For how sandboxing behaves at runtime, see [Sandboxing](/gateway/sandboxing).
For debugging “why is this blocked?”, see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) and `openclaw sandbox explain`.

---

## کنفیگریشن مثالیں

### مثال 1: ذاتی + محدود خاندانی ایجنٹ

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
        "workspace": "~/.openclaw/workspace-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

**نتیجہ:**

- `main` ایجنٹ: ہوسٹ پر چلتا ہے، مکمل اوزار تک رسائی
- `family` ایجنٹ: Docker میں چلتا ہے (ہر ایجنٹ کے لیے ایک کنٹینر)، صرف `read` اوزار

---

### مثال 2: مشترکہ Sandbox کے ساتھ ورک ایجنٹ

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/.openclaw/workspace-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/.openclaw/workspace-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "apply_patch", "exec"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### مثال 2b: عالمی کوڈنگ پروفائل + صرف پیغام رسانی والا ایجنٹ

```json
{
  "tools": { "profile": "coding" },
  "agents": {
    "list": [
      {
        "id": "support",
        "tools": { "profile": "messaging", "allow": ["slack"] }
      }
    ]
  }
}
```

**نتیجہ:**

- ڈیفالٹ ایجنٹس کو کوڈنگ اوزار ملتے ہیں
- `support` ایجنٹ صرف پیغام رسانی کے لیے ہے (+ Slack اوزار)

---

### مثال 3: ہر ایجنٹ کے لیے مختلف Sandbox موڈز

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Override: public always sandboxed
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

---

## کنفیگریشن کی ترجیحی ترتیب

جب عالمی (`agents.defaults.*`) اور ایجنٹ مخصوص (`agents.list[].*`) دونوں کنفیگز موجود ہوں:

### Sandbox کنفیگ

ایجنٹ مخصوص ترتیبات عالمی پر فوقیت رکھتی ہیں:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**نوٹس:**

- `agents.list[].sandbox.{docker,browser,prune}.*` اس ایجنٹ کے لیے `agents.defaults.sandbox.{docker,browser,prune}.*` پر فوقیت رکھتا ہے (جب sandbox اسکوپ `"shared"` پر حل ہو تو نظرانداز کیا جاتا ہے)۔

### اوزار کی پابندیاں

فلٹرنگ کی ترتیب یہ ہے:

1. **اوزار پروفائل** (`tools.profile` یا `agents.list[].tools.profile`)
2. **فراہم کنندہ اوزار پروفائل** (`tools.byProvider[provider].profile` یا `agents.list[].tools.byProvider[provider].profile`)
3. **عالمی اوزار پالیسی** (`tools.allow` / `tools.deny`)
4. **فراہم کنندہ اوزار پالیسی** (`tools.byProvider[provider].allow/deny`)
5. **ایجنٹ مخصوص اوزار پالیسی** (`agents.list[].tools.allow/deny`)
6. **ایجنٹ فراہم کنندہ پالیسی** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Sandbox اوزار پالیسی** (`tools.sandbox.tools` یا `agents.list[].tools.sandbox.tools`)
8. **سب ایجنٹ اوزار پالیسی** (`tools.subagents.tools`، اگر قابلِ اطلاق ہو)

Each level can further restrict tools, but cannot grant back denied tools from earlier levels.
If `agents.list[].tools.sandbox.tools` is set, it replaces `tools.sandbox.tools` for that agent.
If `agents.list[].tools.profile` is set, it overrides `tools.profile` for that agent.
Provider tool keys accept either `provider` (e.g. `google-antigravity`) or `provider/model` (e.g. `openai/gpt-5.2`).

### اوزار گروپس (مختصر نام)

اوزار پالیسیاں (عالمی، ایجنٹ، sandbox) `group:*` اندراجات کی حمایت کرتی ہیں جو متعدد ٹھوس اوزاروں میں پھیلتی ہیں:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: تمام بلٹ اِن OpenClaw اوزار (فراہم کنندہ پلگ انز شامل نہیں)

### Elevated موڈ

`tools.elevated` is the global baseline (sender-based allowlist). `agents.list[].tools.elevated` can further restrict elevated for specific agents (both must allow).

تخفیف کے نمونے:

- غیر معتبر ایجنٹس کے لیے `exec` کو مسترد کریں (`agents.list[].tools.deny: ["exec"]`)
- ایسے ارسال کنندگان کو allowlist کرنے سے گریز کریں جو محدود ایجنٹس تک روٹ کرتے ہوں
- اگر آپ صرف sandboxed اجرا چاہتے ہیں تو عالمی طور پر elevated غیر فعال کریں (`tools.elevated.enabled: false`)
- حساس پروفائلز کے لیے فی ایجنٹ elevated غیر فعال کریں (`agents.list[].tools.elevated.enabled: false`)

---

## واحد ایجنٹ سے منتقلی

**پہلے (واحد ایجنٹ):**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "apply_patch", "exec"],
        "deny": []
      }
    }
  }
}
```

**بعد میں (مختلف پروفائلز کے ساتھ ملٹی ایجنٹ):**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

وراثتی `agent.*` کنفیگز `openclaw doctor` کے ذریعے منتقل ہو جاتے ہیں؛ آئندہ `agents.defaults` + `agents.list` کو ترجیح دیں۔

---

## اوزار پابندی کی مثالیں

### صرف پڑھنے والا ایجنٹ

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### محفوظ اجرا والا ایجنٹ (فائل میں ترمیم نہیں)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### صرف رابطہ کاری والا ایجنٹ

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## عام غلطی: "non-main"

`agents.defaults.sandbox.mode: "non-main"` is based on `session.mainKey` (default `"main"`),
not the agent id. Group/channel sessions always get their own keys, so they
are treated as non-main and will be sandboxed. If you want an agent to never
sandbox, set `agents.list[].sandbox.mode: "off"`.

---

## جانچ

ملٹی ایجنٹ sandbox اور اوزار کنفیگر کرنے کے بعد:

1. **ایجنٹ ریزولوشن چیک کریں:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Sandbox کنٹینرز کی تصدیق کریں:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **اوزار پابندیوں کی جانچ کریں:**
   - ایسا پیغام بھیجیں جس میں محدود اوزار درکار ہوں
   - تصدیق کریں کہ ایجنٹ مسترد شدہ اوزار استعمال نہیں کر سکتا

4. **لاگز کی نگرانی کریں:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## خرابیوں کا ازالہ

### `mode: "all"` کے باوجود ایجنٹ sandbox میں نہیں جا رہا

- دیکھیں کہ کہیں کوئی عالمی `agents.defaults.sandbox.mode` تو نہیں جو اسے اووررائیڈ کر رہا ہو
- ایجنٹ مخصوص کنفیگ فوقیت رکھتی ہے، اس لیے `agents.list[].sandbox.mode: "all"` سیٹ کریں

### deny فہرست کے باوجود اوزار دستیاب ہیں

- اوزار فلٹرنگ کی ترتیب چیک کریں: عالمی → ایجنٹ → sandbox → سب ایجنٹ
- ہر سطح صرف مزید پابندی لگا سکتی ہے، واپس اجازت نہیں دے سکتی
- لاگز سے تصدیق کریں: `[tools] filtering tools for agent:${agentId}`

### فی ایجنٹ کنٹینر الگ تھلگ نہیں

- ایجنٹ مخصوص sandbox کنفیگ میں `scope: "agent"` سیٹ کریں
- ڈیفالٹ `"session"` ہے جو فی سیشن ایک کنٹینر بناتا ہے

---

## یہ بھی دیکھیں

- [ملٹی ایجنٹ روٹنگ](/concepts/multi-agent)
- [Sandbox کنفیگریشن](/gateway/configuration#agentsdefaults-sandbox)
- [سیشن مینجمنٹ](/concepts/session)
