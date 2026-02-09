---
summary: "مرجع CLI للأمر `openclaw voicecall` (سطح أوامر إضافة المكالمات الصوتية)"
read_when:
  - تستخدم إضافة المكالمات الصوتية وتريد نقاط الدخول في CLI
  - تريد أمثلة سريعة لأوامر `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` هو أمر موفَّر عبر إضافة. لا يظهر إلا إذا كانت إضافة المكالمات الصوتية مثبّتة ومُمكّنة.

الوثيقة الأساسية:

- إضافة المكالمات الصوتية: [Voice Call](/plugins/voice-call)

## الأوامر الشائعة

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## تعريض webhooks (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

ملاحظة أمنية: لا تُعرِّض نقطة نهاية webhook إلا للشبكات التي تثق بها. يُفضَّل استخدام Tailscale Serve بدل Funnel كلما أمكن.
