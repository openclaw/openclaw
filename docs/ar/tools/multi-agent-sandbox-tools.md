---
summary: "Sandbox لكل وكيل + قيود الأدوات، الأسبقية، وأمثلة"
title: Sandbox والأدوات متعددة الوكلاء
read_when: "عندما تريد sandboxing لكل وكيل أو سياسات سماح/منع أدوات لكل وكيل ضمن Gateway متعدد الوكلاء."
status: active
---

# تهيئة Sandbox والأدوات متعددة الوكلاء

## نظرة عامة

يمكن لكل وكيل في إعداد متعدد الوكلاء أن يمتلك الآن ما يلي:

- **تهيئة Sandbox** (`agents.list[].sandbox` تتجاوز `agents.defaults.sandbox`)
- **قيود الأدوات** (`tools.allow` / `tools.deny`، بالإضافة إلى `agents.list[].tools`)

يتيح لك ذلك تشغيل عدة وكلاء بملفات أمان مختلفة:

- مساعد شخصي بصلاحيات وصول كاملة
- وكلاء للعائلة/العمل مع أدوات مقيّدة
- وكلاء موجهون للعامة داخل sandboxes

يندرج `setupCommand` ضمن `sandbox.docker` (عالمي أو لكل وكيل) ويعمل مرة واحدة
عند إنشاء الحاوية.

المصادقة لكل وكيل: يقرأ كل وكيل من مخزن المصادقة الخاص به `agentDir` الموجود في:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

لا تتم مشاركة بيانات الاعتماد بين الوكلاء. لا تُعد استخدام `agentDir` عبر الوكلاء.
إذا أردت مشاركة بيانات الاعتماد، انسخ `auth-profiles.json` إلى `agentDir` الخاص بالوكيل الآخر.

لمعرفة كيفية عمل sandboxing أثناء التشغيل، راجع [Sandboxing](/gateway/sandboxing).
ولتصحيح سبب «لماذا هذا محظور؟»، راجع [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) و `openclaw sandbox explain`.

---

## أمثلة على التهيئة

### المثال 1: وكيل شخصي + وكيل عائلي مقيّد

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

**النتيجة:**

- وكيل `main`: يعمل على المضيف، وصول كامل للأدوات
- وكيل `family`: يعمل داخل Docker (حاوية واحدة لكل وكيل)، أداة `read` فقط

---

### المثال 2: وكيل عمل مع Sandbox مشتركة

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

### المثال 2ب: ملف ترميز عالمي + وكيل مراسلة فقط

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

**النتيجة:**

- الوكلاء الافتراضيون يحصلون على أدوات الترميز
- وكيل `support` مخصّص للمراسلة فقط (+ أداة Slack)

---

### المثال 3: أوضاع Sandbox مختلفة لكل وكيل

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

## سابقة الإعدادات

عند وجود تهيئات عالمية (`agents.defaults.*`) وخاصة بالوكيل (`agents.list[].*`):

### تهيئة Sandbox

تتجاوز إعدادات الوكيل الإعدادات العالمية:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**ملاحظات:**

- `agents.list[].sandbox.{docker,browser,prune}.*` يتجاوز `agents.defaults.sandbox.{docker,browser,prune}.*` لذلك الوكيل (يُتجاهل عندما يُحلّ نطاق sandbox إلى `"shared"`).

### قيود الأدوات

ترتيب التصفية هو:

1. **ملف تعريف الأدوات** (`tools.profile` أو `agents.list[].tools.profile`)
2. **ملف تعريف أدوات الموفّر** (`tools.byProvider[provider].profile` أو `agents.list[].tools.byProvider[provider].profile`)
3. **سياسة الأدوات العالمية** (`tools.allow` / `tools.deny`)
4. **سياسة أدوات الموفّر** (`tools.byProvider[provider].allow/deny`)
5. **سياسة أدوات خاصة بالوكيل** (`agents.list[].tools.allow/deny`)
6. **سياسة موفّر الوكيل** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **سياسة أدوات Sandbox** (`tools.sandbox.tools` أو `agents.list[].tools.sandbox.tools`)
8. **سياسة أدوات الوكيل الفرعي** (`tools.subagents.tools`، إن وُجدت)

يمكن لكل مستوى تضييق الأدوات أكثر، لكنه لا يمكنه إعادة منح أدوات تم منعها في مستويات سابقة.
إذا تم تعيين `agents.list[].tools.sandbox.tools`، فإنه يستبدل `tools.sandbox.tools` لذلك الوكيل.
إذا تم تعيين `agents.list[].tools.profile`، فإنه يتجاوز `tools.profile` لذلك الوكيل.
تقبل مفاتيح أدوات الموفّر إما `provider` (مثل `google-antigravity`) أو `provider/model` (مثل `openai/gpt-5.2`).

### مجموعات الأدوات (اختصارات)

تدعم سياسات الأدوات (العالمية، الخاصة بالوكيل، وSandbox) إدخالات `group:*` التي تتوسع إلى عدة أدوات ملموسة:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: جميع أدوات OpenClaw المدمجة (باستثناء إضافات الموفّرين)

### وضع Elevated

`tools.elevated` هو الأساس العالمي (قائمة سماح تعتمد على المُرسِل). يمكن لـ `agents.list[].tools.elevated` تقييد الوضع المُرتفع أكثر لوكلاء محددين (يجب أن يسمح كلاهما).

أنماط التخفيف:

- منع `exec` للوكلاء غير الموثوقين (`agents.list[].tools.deny: ["exec"]`)
- تجنب إدراج المُرسِلين في قائمة السماح الذين يوجّهون إلى وكلاء مقيّدين
- تعطيل الوضع المُرتفع عالميًا (`tools.elevated.enabled: false`) إذا كنت تريد التنفيذ داخل sandbox فقط
- تعطيل الوضع المُرتفع لكل وكيل (`agents.list[].tools.elevated.enabled: false`) للملفات الحساسة

---

## الترحيل من وكيل واحد

**قبل (وكيل واحد):**

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

**بعد (متعدد الوكلاء مع ملفات مختلفة):**

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

تتم ترقية تهيئات `agent.*` القديمة بواسطة `openclaw doctor`؛ ويُفضّل استخدام `agents.defaults` + `agents.list` مستقبلًا.

---

## أمثلة على قيود الأدوات

### وكيل للقراءة فقط

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### وكيل تنفيذ آمن (من دون تعديل الملفات)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### وكيل للتواصل فقط

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## مأزق شائع: «non-main»

يعتمد `agents.defaults.sandbox.mode: "non-main"` على `session.mainKey` (الافتراضي `"main"`)،
وليس على معرّف الوكيل. تحصل جلسات المجموعات/القنوات دائمًا على مفاتيحها الخاصة،
لذا تُعامَل على أنها non-main وتُوضَع داخل sandbox. إذا أردت ألا يُفعَّل sandbox لوكيل ما أبدًا،
فعيّن `agents.list[].sandbox.mode: "off"`.

---

## الاختبار

بعد تهيئة Sandbox والأدوات متعددة الوكلاء:

1. **التحقق من حلّ الوكيل:**

   ```exec
   openclaw agents list --bindings
   ```

2. **التحقق من حاويات Sandbox:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **اختبار قيود الأدوات:**
   - أرسل رسالة تتطلب أدوات مقيّدة
   - تحقّق من أن الوكيل لا يستطيع استخدام الأدوات الممنوعة

4. **مراقبة السجلات:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## استكشاف الأخطاء وإصلاحها

### الوكيل غير مُوضَع داخل sandbox رغم `mode: "all"`

- تحقّق مما إذا كانت هناك `agents.defaults.sandbox.mode` عالمية تتجاوز ذلك
- تهيئة الوكيل لها أسبقية، لذا عيّن `agents.list[].sandbox.mode: "all"`

### ما تزال الأدوات متاحة رغم قائمة المنع

- تحقّق من ترتيب تصفية الأدوات: عالمي → وكيل → sandbox → وكيل فرعي
- يمكن لكل مستوى التضييق فقط، وليس إعادة المنح
- تحقّق عبر السجلات: `[tools] filtering tools for agent:${agentId}`

### الحاوية غير معزولة لكل وكيل

- عيّن `scope: "agent"` في تهيئة Sandbox الخاصة بالوكيل
- القيمة الافتراضية هي `"session"` التي تُنشئ حاوية واحدة لكل جلسة

---

## انظر أيضًا

- [توجيه متعدد الوكلاء](/concepts/multi-agent)
- [تهيئة Sandbox](/gateway/configuration#agentsdefaults-sandbox)
- [إدارة الجلسات](/concepts/session)
