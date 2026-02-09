---
summary: "แก้ไขปัญหาการเริ่มต้น Chrome/Brave/Edge/Chromium CDP สำหรับการควบคุมเบราว์เซอร์ OpenClaw บน Linux"
read_when: "การควบคุมเบราว์เซอร์ล้มเหลวบน Linux โดยเฉพาะเมื่อใช้ Chromium แบบ snap"
title: "การแก้ไขปัญหาเบราว์เซอร์"
---

# การแก้ไขปัญหาเบราว์เซอร์ (Linux)

## ปัญหา: "Failed to start Chrome CDP on port 18800"

เซิร์ฟเวอร์ควบคุมเบราว์เซอร์ของ OpenClaw ไม่สามารถเปิด Chrome/Brave/Edge/Chromium ได้ โดยแสดงข้อผิดพลาด:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### สาเหตุหลัก

บน Ubuntu (และดิสทริบิวชัน Linux จำนวนมาก) การติดตั้ง Chromium ค่าเริ่มต้นเป็น **แพ็กเกจ snap** การกักกันของ AppArmor ใน snap รบกวนวิธีที่ OpenClaw สร้างและตรวจสอบกระบวนการของเบราว์เซอร์ การจำกัด AppArmor ของ Snap รบกวนวิธีที่ OpenClaw สร้างและตรวจสอบกระบวนการเบราว์เซอร์

คำสั่ง `apt install chromium` จะติดตั้งแพ็กเกจสตับที่เปลี่ยนเส้นทางไปยัง snap:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

นี่ไม่ใช่เบราว์เซอร์จริง — เป็นเพียงตัวห่อหุ้มเท่านั้น

### วิธีแก้ไข 1: ติดตั้ง Google Chrome (แนะนำ)

ติดตั้งแพ็กเกจ `.deb` ของ Google Chrome อย่างเป็นทางการ ซึ่งไม่ถูก sandbox โดย snap:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

จากนั้นอัปเดตคอนฟิก OpenClaw ของคุณ (`~/.openclaw/openclaw.json`):

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### วิธีแก้ไข 2: ใช้ Snap Chromium พร้อมโหมด Attach-Only

หากจำเป็นต้องใช้ snap Chromium ให้ตั้งค่า OpenClaw ให้เชื่อมต่อกับเบราว์เซอร์ที่เริ่มต้นด้วยตนเอง:

1. อัปเดตคอนฟิก:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. เริ่ม Chromium ด้วยตนเอง:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. ทางเลือก: สร้าง systemd user service เพื่อเริ่ม Chrome อัตโนมัติ:

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

เปิดใช้งานด้วย: `systemctl --user enable --now openclaw-browser.service`

### การตรวจสอบว่าเบราว์เซอร์ทำงานได้

ตรวจสอบสถานะ:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

ทดสอบการท่องเว็บ:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### อ้างอิงคอนฟิก

| Option                   | Description                                                                                 | Default                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `browser.enabled`        | เปิดใช้งานการควบคุมเบราว์เซอร์                                                              | `true`                                                                                              |
| `browser.executablePath` | พาธไปยังไบนารีของเบราว์เซอร์ที่อิง Chromium (Chrome/Brave/Edge/Chromium) | ตรวจจับอัตโนมัติ (ให้ความสำคัญกับเบราว์เซอร์ค่าเริ่มต้นเมื่อเป็น Chromium-based) |
| `browser.headless`       | รันโดยไม่ใช้ GUI                                                                            | `false`                                                                                             |
| `browser.noSandbox`      | เพิ่มแฟล็ก `--no-sandbox` (จำเป็นสำหรับบางการตั้งค่า Linux)              | `false`                                                                                             |
| `browser.attachOnly`     | ไม่ต้องเปิดเบราว์เซอร์ ให้เชื่อมต่อกับที่มีอยู่เท่านั้น                                     | `false`                                                                                             |
| `browser.cdpPort`        | พอร์ต Chrome DevTools Protocol                                                              | `18800`                                                                                             |

### ปัญหา: "Chrome extension relay is running, but no tab is connected"

คุณกำลังใช้โปรไฟล์ `chrome` (extension relay) คุณกำลังใช้โปรไฟล์ `chrome` (extension relay) ซึ่งคาดหวังให้ส่วนขยายเบราว์เซอร์ของ OpenClaw เชื่อมต่อกับแท็บที่กำลังทำงานอยู่

ตัวเลือกการแก้ไข:

1. **ใช้เบราว์เซอร์ที่จัดการแล้ว:** `openclaw browser start --browser-profile openclaw`
   (หรือกำหนด `browser.defaultProfile: "openclaw"`).
2. **ใช้ extension relay:** ติดตั้งส่วนขยาย เปิดแท็บ แล้วคลิกไอคอนส่วนขยาย OpenClaw เพื่อเชื่อมต่อ

หมายเหตุ:

- โปรไฟล์ `chrome` จะใช้ **เบราว์เซอร์ Chromium ค่าเริ่มต้นของระบบ** เมื่อเป็นไปได้
- โปรไฟล์ `openclaw` แบบโลคัลจะกำหนด `cdpPort`/`cdpUrl` ให้อัตโนมัติ ให้ตั้งค่าเฉพาะกรณีใช้ CDP ระยะไกลเท่านั้น
