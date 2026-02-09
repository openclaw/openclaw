---
summary: "مرجع CLI لأمر `openclaw agents` (السرد/الإضافة/الحذف/تعيين الهوية)"
read_when:
  - عندما تحتاج إلى عدة وكلاء معزولين (مساحات عمل + توجيه + مصادقة)
title: "الوكلاء"
---

# `openclaw agents`

إدارة وكلاء معزولين (مساحات عمل + مصادقة + توجيه).

ذو صلة:

- توجيه متعدد الوكلاء: [Multi-Agent Routing](/concepts/multi-agent)
- مساحة عمل الوكيل: [Agent workspace](/concepts/agent-workspace)

## أمثلة

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## ملفات الهوية

يمكن لكل مساحة عمل لوكيل أن تتضمن `IDENTITY.md` في جذر مساحة العمل:

- مسار مثال: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` يقرأ من جذر مساحة العمل (أو من `--identity-file` صريح)

تُحلّ مسارات الصورة الرمزية نسبةً إلى جذر مساحة العمل.

## تعيين الهوية

`set-identity` يكتب الحقول إلى `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (مسار نسبي لمساحة العمل، أو عنوان URL ‏http(s)، أو data URI)

التحميل من `IDENTITY.md`:

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

تجاوز الحقول صراحةً:

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

عينة تهيئة:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "OpenClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/openclaw.png",
        },
      },
    ],
  },
}
```
