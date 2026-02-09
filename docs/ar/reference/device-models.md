---
summary: "كيف يقوم OpenClaw بتضمين معرّفات نماذج أجهزة Apple لتقديم أسماء ودّية في تطبيق macOS."
read_when:
  - تحديث تعيينات معرّفات نماذج الأجهزة أو ملفات NOTICE/الترخيص
  - تغيير كيفية عرض واجهة Instances لأسماء الأجهزة
title: "قاعدة بيانات نماذج الأجهزة"
---

# قاعدة بيانات نماذج الأجهزة (الأسماء الودّية)

يعرض تطبيق macOS المُرافِق أسماء ودّية لنماذج أجهزة Apple في واجهة **Instances** من خلال تعيين معرّفات نماذج Apple (مثل `iPad16,6`، `Mac16,6`) إلى أسماء قابلة للقراءة البشرية.

يتم تضمين هذا التعيين على هيئة JSON ضمن:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## مصدر البيانات

نقوم حاليًا بتضمين التعيين من المستودع المرخّص بترخيص MIT:

- `kyle-seongwoo-jun/apple-device-identifiers`

للحفاظ على حتمية عمليات البناء، يتم تثبيت ملفات JSON على التزامات محددة من المصدر العلوي (مسجّلة في `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## تحديث قاعدة البيانات

1. اختر التزامات المصدر العلوي التي تريد التثبيت عليها (واحد لـ iOS وواحد لـ macOS).
2. حدّث تجزئات الالتزام في `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. أعد تنزيل ملفات JSON، مع تثبيتها على تلك الالتزامات:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. تأكّد من أن `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` لا يزال مطابقًا للمصدر العلوي (استبدله إذا تغيّر ترخيص المصدر العلوي).
5. تحقّق من أن تطبيق macOS يُبنى دون أخطاء (من دون تحذيرات):

```bash
swift build --package-path apps/macos
```
