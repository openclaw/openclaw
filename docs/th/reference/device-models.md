---
summary: "วิธีที่ OpenClaw จัดเตรียมตัวระบุรุ่นอุปกรณ์ของ Apple ให้เป็นชื่อที่อ่านเข้าใจง่ายในแอปmacOS"
read_when:
  - อัปเดตการแม็ปตัวระบุรุ่นอุปกรณ์หรือไฟล์ NOTICE/ไลเซนส์
  - เปลี่ยนวิธีที่ UI ของ Instances แสดงชื่ออุปกรณ์
title: "ฐานข้อมูลรุ่นอุปกรณ์"
---

# ฐานข้อมูลรุ่นอุปกรณ์(ชื่อที่เป็นมิตร)

แอปคู่หูบน macOS จะแสดงชื่อรุ่นอุปกรณ์ของ Apple ที่อ่านเข้าใจง่ายใน UI ของ **Instances** โดยการแม็ปตัวระบุรุ่นของ Apple (เช่น `iPad16,6`, `Mac16,6`) ไปเป็นชื่อที่มนุษย์อ่านเข้าใจได้

การแม็ปถูกจัดเตรียมเป็น JSON ไว้ที่:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## แหล่งข้อมูล

ปัจจุบันมีการใช้สองแพตเทิร์น

- `kyle-seongwoo-jun/apple-device-identifiers`

เพื่อให้การบิลด์มีความกำหนดแน่นอน ไฟล์ JSON จะถูกปักหมุดไว้กับคอมมิตต้นทางที่เฉพาะเจาะจง(บันทึกไว้ใน `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`)

## การอัปเดตฐานข้อมูล

1. เลือกคอมมิตต้นทางที่ต้องการปักหมุด(หนึ่งรายการสำหรับ iOS และหนึ่งรายการสำหรับ macOS)
2. อัปเดตแฮชคอมมิตใน `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`
3. ดาวน์โหลดไฟล์ JSON ใหม่อีกครั้ง โดยปักหมุดกับคอมมิตเหล่านั้น:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. ตรวจสอบให้แน่ใจว่า `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` ยังตรงกับต้นทาง(แทนที่หากไลเซนส์ต้นทางมีการเปลี่ยนแปลง)
5. ตรวจสอบว่าแอปmacOS บิลด์ได้อย่างเรียบร้อย(ไม่มีคำเตือน):

```bash
swift build --package-path apps/macos
```
