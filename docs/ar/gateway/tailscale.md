---
summary: "تكامل Tailscale Serve/Funnel للوحة تحكّم Gateway"
read_when:
  - تعريض واجهة تحكّم Gateway خارج localhost
  - أتمتة الوصول إلى لوحة التحكّم عبر tailnet أو بشكل عام
title: "Tailscale"
---

# Tailscale (لوحة تحكّم Gateway)

يمكن لـ OpenClaw تهيئة Tailscale **Serve** (ضمن tailnet) أو **Funnel** (عام) تلقائيًا
للوحة تحكّم Gateway ومنفذ WebSocket. يحافظ ذلك على ربط Gateway بـ loopback بينما
توفّر Tailscale بروتوكول HTTPS والتوجيه، و(في Serve) رؤوس الهوية.

## أوضاع

- `serve`: Serve ضمن tailnet فقط عبر `tailscale serve`. تبقى البوابة على `127.0.0.1`.
- `funnel`: HTTPS عام عبر `tailscale funnel`. يتطلّب OpenClaw كلمة مرور مشتركة.
- `off`: الافتراضي (لا أتمتة لـ Tailscale).

## المصادقة

عيّن `gateway.auth.mode` للتحكّم في المصافحة:

- `token` (الافتراضي عندما يتم تعيين `OPENCLAW_GATEWAY_TOKEN`)
- `password` (سرّ مشترك عبر `OPENCLAW_GATEWAY_PASSWORD` أو التهيئة)

عندما يكون `tailscale.mode = "serve"` و`gateway.auth.allowTailscale` هو `true`،
يمكن لطلبات وكيل Serve الصالحة المصادقة عبر رؤوس هوية Tailscale
(`tailscale-user-login`) دون تقديم رمز/كلمة مرور. يتحقّق OpenClaw من
الهوية عبر حلّ عنوان `x-forwarded-for` باستخدام برنامج Tailscale
المحلّي (`tailscale whois`) ومطابقته مع الرأس قبل قبوله.
لا يتعامل OpenClaw مع الطلب على أنّه Serve إلا إذا وصل من loopback
مع رؤوس Tailscale `x-forwarded-for` و`x-forwarded-proto` و`x-forwarded-host`.
لفرض بيانات اعتماد صريحة، عيّن `gateway.auth.allowTailscale: false` أو
افرِض `gateway.auth.mode: "password"`.

## أمثلة التهيئة

### ضمن tailnet فقط (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

افتح: `https://<magicdns>/` (أو `gateway.controlUi.basePath` الذي قمت بتهيئته)

### ضمن tailnet فقط (الربط بعنوان Tailnet IP)

استخدم هذا عندما تريد أن يستمع Gateway مباشرةً على عنوان Tailnet IP (من دون Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

الاتصال من جهاز آخر ضمن tailnet:

- واجهة التحكّم: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

ملاحظة: لن يعمل loopback (`http://127.0.0.1:18789`) في هذا الوضع.

### الإنترنت العام (Funnel + كلمة مرور مشتركة)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

يُفضَّل `OPENCLAW_GATEWAY_PASSWORD` بدل حفظ كلمة مرور على القرص.

## أمثلة CLI

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## ملاحظات

- يتطلّب Tailscale Serve/Funnel تثبيت CLI الخاص بـ `tailscale` وتسجيل الدخول.
- يرفض `tailscale.mode: "funnel"` البدء ما لم يكن وضع المصادقة هو `password` لتجنّب التعرّض العام.
- عيّن `gateway.tailscale.resetOnExit` إذا أردت من OpenClaw التراجع عن تهيئة `tailscale serve`
  أو `tailscale funnel` عند الإيقاف.
- `gateway.bind: "tailnet"` هو ربط مباشر بـ Tailnet (من دون HTTPS، ولا Serve/Funnel).
- يفضّل `gateway.bind: "auto"` loopback؛ استخدم `tailnet` إذا أردت tailnet فقط.
- يعرّض Serve/Funnel فقط **واجهة تحكّم Gateway + WS**. تتصل العُقد عبر
  نقطة نهاية Gateway WS نفسها، لذا يمكن أن يعمل Serve للوصول إلى العُقد.

## التحكم في المتصفح (البوابة البعيدة + المتصفح المحلي)

إذا شغّلت Gateway على جهاز وتريد قيادة متصفّح على جهاز آخر،
فشغّل **مضيف عُقدة** على جهاز المتصفّح وأبقِ الجهازين ضمن tailnet نفسه.
سيقوم Gateway بتمرير إجراءات المتصفّح إلى العُقدة؛ لا حاجة إلى خادم تحكّم منفصل أو عنوان Serve.

تجنب Funnel للتحكم في المتصفح؛ معالجة اقتران العقدة مثل وصول المشغل.

## متطلبات Tailscale والقيود

- يتطلّب Serve تمكين HTTPS لـ tailnet الخاص بك؛ وسيطالبك CLI إذا كان مفقودًا.
- يحقن Serve رؤوس هوية Tailscale؛ بينما لا يفعل Funnel ذلك.
- يتطلّب Funnel Tailscale الإصدار 1.38.3+ وMagicDNS وتمكين HTTPS وسِمة funnel للعُقدة.
- يدعم Funnel فقط المنافذ `443` و`8443` و`10000` عبر TLS.
- يتطلّب Funnel على macOS نسخة تطبيق Tailscale مفتوحة المصدر.

## تعلّم المزيد

- نظرة عامة على Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- أمر `tailscale serve`: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- نظرة عامة على Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- أمر `tailscale funnel`: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
