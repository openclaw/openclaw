---
summary: "เช็กลิสต์การรีลีส OpenClaw บน macOS (ฟีด Sparkle, การแพ็กเกจ, การเซ็นชื่อ)"
read_when:
  - ระหว่างตัดหรือยืนยันการรีลีส OpenClaw บน macOS
  - ระหว่างอัปเดต appcast หรือแอสเซ็ตของฟีด Sparkle
title: "การรีลีส macOS"
x-i18n:
  source_path: platforms/mac/release.md
  source_hash: 98d6640ae4ea9cc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:29Z
---

# การรีลีส OpenClaw บน macOS (Sparkle)

แอปนี้รองรับการอัปเดตอัตโนมัติด้วย Sparkle แล้ว บิลด์สำหรับรีลีสต้องเซ็นชื่อด้วย Developer ID, บีบอัดเป็น zip และเผยแพร่พร้อมรายการ appcast ที่เซ็นชื่อแล้ว

## ข้อกำหนดก่อนเริ่มต้น

- ติดตั้งใบรับรอง Developer ID Application แล้ว (ตัวอย่าง: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- ตั้งค่าเส้นทางคีย์ส่วนตัวของ Sparkle ใน environment เป็น `SPARKLE_PRIVATE_KEY_FILE` (พาธไปยังคีย์ส่วนตัว ed25519 ของ Sparkle; คีย์สาธารณะถูกฝังใน Info.plist). หากไม่มี ให้ตรวจสอบ `~/.profile`.
- ข้อมูลรับรองสำหรับ Notary (โปรไฟล์ใน keychain หรือ API key) สำหรับ `xcrun notarytool` หากต้องการแจกจ่าย DMG/zip ที่ปลอดภัยกับ Gatekeeper.
  - เราใช้โปรไฟล์ Keychain ชื่อ `openclaw-notary` ซึ่งสร้างจากตัวแปรสภาพแวดล้อมของ App Store Connect API key ใน shell profile:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- ติดตั้ง deps ของ `pnpm` แล้ว (`pnpm install --config.node-linker=hoisted`).
- เครื่องมือ Sparkle จะถูกดึงอัตโนมัติผ่าน SwiftPM ที่ `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast` ฯลฯ).

## สร้างบิลด์และแพ็กเกจ

หมายเหตุ:

- `APP_BUILD` แมปไปยัง `CFBundleVersion`/`sparkle:version`; ควรเป็นตัวเลขและเพิ่มขึ้นอย่างต่อเนื่อง (ไม่มี `-beta`), มิฉะนั้น Sparkle จะเปรียบเทียบว่าเท่ากัน
- ค่าเริ่มต้นจะใช้สถาปัตยกรรมปัจจุบัน (`$(uname -m)`). สำหรับบิลด์รีลีส/แบบ universal ให้ตั้งค่า `BUILD_ARCHS="arm64 x86_64"` (หรือ `BUILD_ARCHS=all`).
- ใช้ `scripts/package-mac-dist.sh` สำหรับอาร์ติแฟกต์รีลีส (zip + DMG + การรับรอง Notarization). ใช้ `scripts/package-mac-app.sh` สำหรับการแพ็กเกจแบบ local/dev

```bash
# From repo root; set release IDs so Sparkle feed is enabled.
# APP_BUILD must be numeric + monotonic for Sparkle compare.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.6 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# Zip for distribution (includes resource forks for Sparkle delta support)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.6.zip

# Optional: also build a styled DMG for humans (drag to /Applications)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.6.dmg

# Recommended: build + notarize/staple zip + DMG
# First, create a keychain profile once:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.6 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# Optional: ship dSYM alongside the release
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.6.dSYM.zip
```

## รายการ Appcast

ใช้ตัวสร้างบันทึกการรีลีสเพื่อให้ Sparkle แสดงบันทึกเป็น HTML ที่จัดรูปแบบแล้ว:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

สร้างบันทึกการรีลีสแบบ HTML จาก `CHANGELOG.md` (ผ่าน [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) และฝังลงในรายการ appcast
คอมมิตไฟล์ `appcast.xml` ที่อัปเดตแล้วไปพร้อมกับแอสเซ็ตของรีลีส (zip + dSYM) ระหว่างการเผยแพร่

## เผยแพร่และตรวจสอบ

- อัปโหลด `OpenClaw-2026.2.6.zip` (และ `OpenClaw-2026.2.6.dSYM.zip`) ไปยัง GitHub release สำหรับแท็ก `v2026.2.6`.
- ตรวจสอบว่า URL ของ appcast แบบ raw ตรงกับฟีดที่ฝังไว้: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- การตรวจสอบความเรียบร้อย:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` ตอบกลับ 200.
  - `curl -I <enclosure url>` ตอบกลับ 200 หลังอัปโหลดแอสเซ็ตแล้ว
  - บนบิลด์สาธารณะก่อนหน้า ให้รัน “Check for Updates…” จากแท็บ About และยืนยันว่า Sparkle ติดตั้งบิลด์ใหม่ได้อย่างราบรื่น

นิยามของความเสร็จสิ้น: แอปที่เซ็นชื่อและ appcast ถูกเผยแพร่แล้ว กระบวนการอัปเดตทำงานได้จากเวอร์ชันที่ติดตั้งไว้ก่อนหน้า และแอสเซ็ตของรีลีสถูกแนบใน GitHub release แล้ว
