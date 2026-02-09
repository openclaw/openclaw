---
summary: "การบันทึกล็อกของ OpenClaw: ไฟล์บันทึกการวินิจฉัยแบบหมุนเวียน + แฟล็กความเป็นส่วนตัวของ unified log"
read_when:
  - การเก็บล็อกบน macOS หรือการตรวจสอบการบันทึกข้อมูลส่วนตัว
  - การดีบักปัญหาเสียงปลุก/วงจรชีวิตของเซสชัน
title: "การบันทึกล็อกบน macOS"
---

# การบันทึกล็อก(macOS)

## ไฟล์บันทึกการวินิจฉัยแบบหมุนเวียน(Debug pane)

OpenClaw ส่งต่อการบันทึกล็อกของแอปบน macOS ผ่าน swift-log(ใช้ unified logging เป็นค่าเริ่มต้น) และสามารถเขียนไฟล์บันทึกแบบหมุนเวียนในเครื่องลงดิสก์ได้เมื่อคุณต้องการการเก็บข้อมูลที่คงทน

- ระดับรายละเอียด: **Debug pane → Logs → App logging → Verbosity**
- เปิดใช้งาน: **Debug pane → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- ตำแหน่งไฟล์: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (หมุนเวียนอัตโนมัติ; ไฟล์เก่าจะถูกต่อท้ายด้วย `.1`, `.2`, …)
- ล้างข้อมูล: **Debug pane → Logs → App logging → “Clear”**

หมายเหตุ:

- ฟีเจอร์นี้ **ปิดใช้งานเป็นค่าเริ่มต้น** ให้เปิดเฉพาะขณะกำลังดีบักเท่านั้น 16. เปิดใช้งานเฉพาะขณะดีบักเท่านั้น
- ถือว่าไฟล์นี้มีความอ่อนไหว; อย่าแชร์โดยไม่ตรวจทานก่อน

## ข้อมูลส่วนตัวใน unified logging บน macOS

17. Unified logging จะปิดบังเพย์โหลดส่วนใหญ่ เว้นแต่ซับซิสเต็มจะเลือกใช้ `privacy -off` Unified logging จะปกปิดเพย์โหลดส่วนใหญ่ เว้นแต่ซับซิสเต็มจะเลือกใช้ `privacy -off` ตามบทความของ Peter เกี่ยวกับ [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) บน macOS(2025) การควบคุมนี้ทำผ่านไฟล์ plist ใน `/Library/Preferences/Logging/Subsystems/` โดยอ้างอิงจากชื่อซับซิสเต็ม เฉพาะรายการล็อกใหม่เท่านั้นที่จะรับแฟล็กนี้ ดังนั้นให้เปิดใช้งานก่อนทำซ้ำปัญหา 18. มีเพียงรายการล็อกใหม่เท่านั้นที่จะใช้แฟล็กนี้ ดังนั้นให้เปิดก่อนทำซ้ำปัญหา

## เปิดใช้งานสำหรับ OpenClaw(`bot.molt`)

- เขียนไฟล์ plist ไปยังไฟล์ชั่วคราวก่อน จากนั้นติดตั้งแบบอะตอมมิกด้วยสิทธิ์ root:

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- ไม่จำเป็นต้องรีบูต; logd จะตรวจพบไฟล์อย่างรวดเร็ว แต่เฉพาะบรรทัดล็อกใหม่เท่านั้นที่จะรวมเพย์โหลดส่วนตัว
- ดูเอาต์พุตที่ละเอียดขึ้นด้วยตัวช่วยที่มีอยู่ เช่น `./scripts/clawlog.sh --category WebChat --last 5m`.

## ปิดใช้งานหลังดีบักเสร็จ

- ลบการ override: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- ตัวเลือกเพิ่มเติมคือรัน `sudo log config --reload` เพื่อบังคับให้ logd ยกเลิก override ทันที
- โปรดจำไว้ว่าพื้นผิวนี้อาจมีหมายเลขโทรศัพท์และเนื้อหาข้อความ ให้คงไฟล์ plist ไว้เฉพาะช่วงที่คุณต้องการรายละเอียดเพิ่มเติมเท่านั้น
