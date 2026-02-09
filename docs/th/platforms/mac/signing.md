---
summary: "ขั้นตอนการลงนามสำหรับบิลด์ดีบักของmacOSที่สร้างโดยสคริปต์แพ็กเกจ"
read_when:
  - การสร้างหรือการลงนามบิลด์ดีบักของmac
title: "การลงนามบนmacOS"
---

# การลงนามบนmac (บิลด์ดีบัก)

แอปนี้มักถูกสร้างจาก [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) ซึ่งปัจจุบันจะ:

- ตั้งค่า bundle identifier สำหรับดีบักให้คงที่: `ai.openclaw.mac.debug`
- เขียน Info.plist ด้วย bundle id นั้น(สามารถ override ได้ผ่าน `BUNDLE_ID=...`)
- เรียก [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) เพื่อทำการลงนามไบนารีหลักและแอปบันเดิล เพื่อให้macOSมองว่าแต่ละการรีบิลด์เป็นบันเดิลที่ลงนามเดียวกันและคงสิทธิ์TCCไว้(การแจ้งเตือน,การช่วยการเข้าถึง,การบันทึกหน้าจอ,ไมโครโฟน,การพูด). เพื่อให้สิทธิ์คงที่ แนะนำให้ใช้ signing identity จริง; การลงนามแบบ ad-hoc เป็นแบบต้องเลือกใช้เองและเปราะบาง(ดู [macOS permissions](/platforms/mac/permissions)).
- ใช้ `CODESIGN_TIMESTAMP=auto` เป็นค่าเริ่มต้น; เปิดใช้งาน trusted timestamps สำหรับลายเซ็น Developer ID. ตั้งค่า `CODESIGN_TIMESTAMP=off` เพื่อข้ามการประทับเวลา(บิลด์ดีบักออฟไลน์).
- แทรกเมทาดาทาของบิลด์ลงใน Info.plist: `OpenClawBuildTimestamp`(UTC) และ `OpenClawGitCommit`(แฮชแบบสั้น) เพื่อให้หน้า About แสดงข้อมูลบิลด์,gitและช่องทางดีบัก/รีลีส.
- **การแพ็กเกจต้องใช้ Node 22+**: สคริปต์จะรันการบิลด์ TS และการบิลด์ Control UI.
- อ่านค่า `SIGN_IDENTITY` จาก environment. เพิ่ม `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"`(หรือใบรับรอง Developer ID Application ของคุณ) ลงใน shell rc เพื่อให้ลงนามด้วยใบรับรองของคุณเสมอ. การลงนามแบบ ad-hoc ต้องเลือกใช้เองอย่างชัดเจนผ่าน `ALLOW_ADHOC_SIGNING=1` หรือ `SIGN_IDENTITY="-"`(ไม่แนะนำสำหรับการทดสอบสิทธิ์).
- รันการตรวจสอบ Team ID หลังการลงนาม และจะล้มเหลวหากมี Mach-O ใดๆภายในแอปบันเดิลที่ถูกลงนามด้วย Team ID อื่น. ตั้งค่า `SKIP_TEAM_ID_CHECK=1` เพื่อข้ามขั้นตอนนี้.

## การใช้งาน

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### หมายเหตุการลงนามแบบ Ad-hoc

เมื่อเซ็นด้วย `SIGN_IDENTITY="-"` (ad-hoc) สคริปต์จะปิด **Hardened Runtime** (`--options runtime`) โดยอัตโนมัติ สิ่งนี้จำเป็นเพื่อป้องกันการแครชเมื่อแอปพยายามโหลด embedded frameworks (เช่น Sparkle) ที่ไม่ได้ใช้ Team ID เดียวกัน ลายเซ็นแบบ ad-hoc ยังทำให้การคงอยู่ของสิทธิ์ TCC ใช้งานไม่ได้; ดู [macOS permissions](/platforms/mac/permissions) สำหรับขั้นตอนการกู้คืน

## เมทาดาทาของบิลด์สำหรับ About

`package-mac-app.sh` จะประทับข้อมูลลงในบันเดิลดังนี้:

- `OpenClawBuildTimestamp`: ISO8601 UTC ณ เวลาแพ็กเกจ
- `OpenClawGitCommit`: แฮช git แบบสั้น(หรือ `unknown` หากไม่พร้อมใช้งาน)

แท็บ About จะอ่านคีย์เหล่านี้เพื่อแสดงเวอร์ชัน,วันที่บิลด์,คอมมิต gitและระบุว่าเป็นบิลด์ดีบักหรือไม่(ผ่าน `#if DEBUG`). ให้รันตัวแพ็กเกจอีกครั้งเพื่อรีเฟรชค่าต่างๆหลังมีการเปลี่ยนแปลงโค้ด

## ทำไม

สิทธิ์ TCC ผูกกับ bundle identifier _และ_ ลายเซ็นโค้ด บิลด์ดีบักที่ไม่เซ็นและมี UUID เปลี่ยนทุกครั้ง ทำให้ macOS ลืมการอนุญาตหลังการรีบิลด์แต่ละครั้ง สิทธิ์TCCผูกกับ bundle identifier _และ_ ลายเซ็นโค้ด บิลด์ดีบักที่ไม่ลงนามและมี UUID เปลี่ยนไปเรื่อยๆทำให้macOSลืมการอนุญาตหลังการรีบิลด์แต่ละครั้ง การลงนามไบนารี(ค่าเริ่มต้นเป็น ad-hoc)และคง bundle id/พาธให้คงที่(`dist/OpenClaw.app`)จะช่วยรักษาการอนุญาตระหว่างบิลด์ให้คงอยู่ สอดคล้องกับแนวทางของ VibeTunnel
