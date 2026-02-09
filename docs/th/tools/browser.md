---
summary: "บริการควบคุมเบราว์เซอร์แบบรวมศูนย์พร้อมคำสั่งการทำงาน"
read_when:
  - การเพิ่มระบบอัตโนมัติของเบราว์เซอร์ที่ควบคุมโดยเอเจนต์
  - การดีบักสาเหตุที่ openclaw รบกวน Chrome ของคุณเอง
  - การนำการตั้งค่าและวงจรชีวิตของเบราว์เซอร์ไปใช้ในแอปmacOS
title: "Browser (จัดการโดย OpenClaw)"
---

# Browser (จัดการโดย openclaw)

OpenClaw สามารถรัน **โปรไฟล์ Chrome/Brave/Edge/Chromium แบบเฉพาะ** ที่เอเจนต์ควบคุมได้
โดยแยกออกจากเบราว์เซอร์ส่วนตัวของคุณ และถูกจัดการผ่านบริการควบคุมขนาดเล็กในเครื่อง
ภายใน Gateway (เฉพาะ local loopback)
มันถูกแยกจากเบราว์เซอร์ส่วนตัวของคุณ และถูกจัดการผ่านบริการควบคุมภายในเครื่องขนาดเล็ก
ภายใน Gateway (เฉพาะ loopback เท่านั้น)

มุมมองสำหรับผู้เริ่มต้น:

- คิดว่าเป็น **เบราว์เซอร์แยกต่างหากสำหรับเอเจนต์เท่านั้น**
- โปรไฟล์ `openclaw` **ไม่** แตะต้องโปรไฟล์เบราว์เซอร์ส่วนตัวของคุณ
- เอเจนต์สามารถ **เปิดแท็บ อ่านหน้า คลิก และพิมพ์** ได้ในเลนที่ปลอดภัย
- โปรไฟล์เริ่มต้น `chrome` ใช้ **เบราว์เซอร์ Chromium ค่าเริ่มต้นของระบบ** ผ่าน
  extension relay; สลับเป็น `openclaw` เพื่อใช้เบราว์เซอร์แบบจัดการแยกต่างหาก

## สิ่งที่คุณจะได้รับ

- โปรไฟล์เบราว์เซอร์แยกต่างหากชื่อ **openclaw** (ค่าเริ่มต้นมีโทนสีส้ม)
- การควบคุมแท็บแบบกำหนดแน่นอน (รายการ/เปิด/โฟกัส/ปิด)
- การกระทำของเอเจนต์ (คลิก/พิมพ์/ลาก/เลือก), สแนปช็อต, ภาพหน้าจอ, PDF
- รองรับหลายโปรไฟล์แบบไม่บังคับ (`openclaw`, `work`, `remote`, ...)

เบราว์เซอร์นี้ **ไม่ใช่** เบราว์เซอร์ที่คุณใช้ประจำวัน เป็นพื้นที่ที่ปลอดภัยและแยกออกมา สำหรับ
การทำงานอัตโนมัติและการตรวจสอบของเอเจนต์

## เริ่มต้นอย่างรวดเร็ว

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

หากคุณพบข้อความ “Browser disabled” ให้เปิดใช้งานในคอนฟิก (ดูด้านล่าง) และรีสตาร์ต
Gateway

## โปรไฟล์: `openclaw` เทียบกับ `chrome`

- `openclaw`: เบราว์เซอร์แบบจัดการและแยกออกมา (ไม่ต้องใช้ส่วนขยาย)
- `chrome`: extension relay ไปยัง **เบราว์เซอร์ของระบบ** ของคุณ (ต้องมีส่วนขยาย OpenClaw
  แนบกับแท็บ)

ตั้งค่า `browser.defaultProfile: "openclaw"` หากต้องการให้โหมดจัดการเป็นค่าเริ่มต้น

## การกำหนดค่า

การตั้งค่าเบราว์เซอร์อยู่ใน `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

หมายเหตุ:

- บริการควบคุมเบราว์เซอร์ผูกกับ loopback บนพอร์ตที่ได้มาจาก `gateway.port`
  (ค่าเริ่มต้น: `18791` ซึ่งคือ gateway + 2) ส่วน relay ใช้พอร์ตถัดไป (`18792`) รีเลย์จะใช้พอร์ตถัดไป (`18792`)
- หากคุณแทนที่พอร์ต Gateway (`gateway.port` หรือ `OPENCLAW_GATEWAY_PORT`)
  พอร์ตเบราว์เซอร์ที่คำนวณได้จะเลื่อนไปเพื่อให้อยู่ใน “ตระกูล” เดียวกัน
- `cdpUrl` จะใช้ค่าเริ่มต้นเป็นพอร์ต relay เมื่อไม่ได้ตั้งค่า
- `remoteCdpTimeoutMs` ใช้กับการตรวจสอบการเข้าถึง CDP ระยะไกล (ไม่ใช่ loopback)
- `remoteCdpHandshakeTimeoutMs` ใช้กับการตรวจสอบการเข้าถึง CDP WebSocket ระยะไกล
- `attachOnly: true` หมายถึง “ไม่เปิดเบราว์เซอร์ภายในเครื่อง; แนบเฉพาะเมื่อกำลังรันอยู่แล้ว”
- `color` + ค่า `color` ต่อโปรไฟล์ จะย้อมสี UI ของเบราว์เซอร์เพื่อให้เห็นว่าโปรไฟล์ใดทำงานอยู่
- โปรไฟล์เริ่มต้นคือ `chrome` (extension relay) โปรไฟล์เริ่มต้นคือ `chrome` (extension relay) ใช้ `defaultProfile: "openclaw"` สำหรับเบราว์เซอร์แบบจัดการ
- ลำดับการตรวจจับอัตโนมัติ: เบราว์เซอร์ค่าเริ่มต้นของระบบถ้าเป็น Chromium; มิฉะนั้น Chrome → Brave → Edge → Chromium → Chrome Canary
- โปรไฟล์ `openclaw` ภายในเครื่องจะกำหนด `cdpPort`/`cdpUrl` อัตโนมัติ — ตั้งค่าเหล่านั้นเฉพาะสำหรับ CDP ระยะไกลเท่านั้น

## ใช้ Brave (หรือเบราว์เซอร์ที่อิง Chromium อื่น)

หากเบราว์เซอร์ **ค่าเริ่มต้นของระบบ** ของคุณเป็น Chromium-based (Chrome/Brave/Edge ฯลฯ)
OpenClaw จะใช้งานโดยอัตโนมัติ ตั้งค่า `browser.executablePath` เพื่อแทนที่การตรวจจับอัตโนมัติ: ตั้งค่า `browser.executablePath` เพื่อแทนที่
การตรวจจับอัตโนมัติ:

ตัวอย่าง CLI:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## การควบคุมภายในเครื่องเทียบกับระยะไกล

- **การควบคุมภายในเครื่อง (ค่าเริ่มต้น):** Gateway เริ่มบริการควบคุม loopback และสามารถเปิดเบราว์เซอร์ภายในเครื่องได้
- **การควบคุมระยะไกล (โฮสต์โหนด):** รันโฮสต์โหนดบนเครื่องที่มีเบราว์เซอร์; Gateway จะพร็อกซีการกระทำของเบราว์เซอร์ไปยังโฮสต์นั้น
- **Remote CDP:** ตั้งค่า `browser.profiles.<name>`.cdpUrl`(หรือ`browser.cdpUrl`) เพื่อ
  เชื่อมต่อกับเบราว์เซอร์ที่ใช้ Chromium แบบระยะไกล .cdpUrl` (หรือ `browser.cdpUrl`)
  เพื่อแนบกับเบราว์เซอร์ที่อิง Chromium ระยะไกล ในกรณีนี้ OpenClaw จะไม่เปิดเบราว์เซอร์ภายในเครื่อง

URL ของ Remote CDP สามารถมีการยืนยันตัวตนได้:

- โทเคนใน query (เช่น `https://provider.example?token=<token>`)
- HTTP Basic auth (เช่น `https://user:pass@provider.example`)

OpenClaw จะเก็บการยืนยันตัวตนไว้เมื่อเรียก endpoint `/json/*` และเมื่อเชื่อมต่อ
กับ CDP WebSocket แนะนำให้ใช้ตัวแปรสภาพแวดล้อมหรือระบบจัดการซีเคร็ต
แทนการคอมมิตโทเคนลงในไฟล์คอนฟิก ควรใช้ตัวแปรสภาพแวดล้อมหรือระบบจัดการความลับสำหรับ
โทเคน แทนการบันทึกไว้ในไฟล์คอนฟิก

## Node browser proxy (ค่าเริ่มต้นแบบไม่ต้องคอนฟิก)

หากคุณรัน **โฮสต์โหนด** บนเครื่องที่มีเบราว์เซอร์ OpenClaw สามารถ
จัดเส้นทางการเรียกเครื่องมือเบราว์เซอร์ไปยังโหนดนั้นโดยอัตโนมัติโดยไม่ต้องตั้งค่าเบราว์เซอร์เพิ่มเติม
นี่คือเส้นทางเริ่มต้นสำหรับ Gateway ระยะไกล
นี่คือพาธเริ่มต้นสำหรับเกตเวย์ระยะไกล

หมายเหตุ:

- โฮสต์โหนดเปิดเผยเซิร์ฟเวอร์ควบคุมเบราว์เซอร์ภายในเครื่องผ่าน **คำสั่งพร็อกซี**
- โปรไฟล์มาจากคอนฟิก `browser.profiles` ของโหนดเอง (เหมือนกับภายในเครื่อง)
- ปิดการทำงานได้หากไม่ต้องการ:
  - บนโหนด: `nodeHost.browserProxy.enabled=false`
  - บน Gateway: `gateway.nodes.browser.mode="off"`

## Browserless (Remote CDP แบบโฮสต์)

[Browserless](https://browserless.io) เป็นบริการ Chromium แบบโฮสต์ที่เปิดให้ใช้งาน
เอ็นด์พอยต์ CDP ผ่าน HTTPS [Browserless](https://browserless.io) คือบริการ Chromium แบบโฮสต์ที่เปิดเผย
endpoint ของ CDP ผ่าน HTTPS คุณสามารถชี้โปรไฟล์เบราว์เซอร์ของ OpenClaw
ไปยัง endpoint ของภูมิภาค Browserless และยืนยันตัวตนด้วยคีย์API

ตัวอย่าง:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

หมายเหตุ:

- แทนที่ `<BROWSERLESS_API_KEY>` ด้วยโทเคน Browserless จริงของคุณ
- เลือก endpoint ของภูมิภาคให้ตรงกับบัญชี Browserless ของคุณ (ดูเอกสารของพวกเขา)

## ความปลอดภัย

แนวคิดหลัก:

- การควบคุมเบราว์เซอร์เป็นแบบ loopback เท่านั้น; การเข้าถึงไหลผ่านการยืนยันตัวตนของ Gateway หรือการจับคู่โหนด
- เก็บ Gateway และโฮสต์โหนดไว้ในเครือข่ายส่วนตัว (Tailscale); หลีกเลี่ยงการเปิดสาธารณะ
- ปฏิบัติต่อ URL/โทเคนของ Remote CDP เป็นความลับ; ใช้ env vars หรือระบบจัดการซีเคร็ต

เคล็ดลับ Remote CDP:

- เลือก endpoint HTTPS และโทเคนอายุสั้นเมื่อเป็นไปได้
- หลีกเลี่ยงการฝังโทเคนอายุยาวไว้ในไฟล์คอนฟิกโดยตรง

## โปรไฟล์ (หลายเบราว์เซอร์)

OpenClaw รองรับหลายโปรไฟล์ที่ตั้งชื่อได้ (routing configs) โปรไฟล์สามารถเป็น: โปรไฟล์สามารถเป็น:

- **openclaw-managed**: อินสแตนซ์เบราว์เซอร์ที่อิง Chromium แบบเฉพาะ พร้อมไดเรกทอรีข้อมูลผู้ใช้และพอร์ต CDP ของตนเอง
- **remote**: URL CDP แบบระบุชัด (เบราว์เซอร์ที่อิง Chromium รันอยู่ที่อื่น)
- **extension relay**: แท็บ Chrome ที่มีอยู่ของคุณผ่าน relay ภายในเครื่อง + ส่วนขยาย Chrome

ค่าเริ่มต้น:

- โปรไฟล์ `openclaw` จะถูกสร้างอัตโนมัติหากไม่มี
- โปรไฟล์ `chrome` เป็นแบบฝังมาสำหรับ Chrome extension relay (ชี้ไปที่ `http://127.0.0.1:18792` โดยค่าเริ่มต้น)
- พอร์ต CDP ภายในเครื่องจัดสรรจาก **18800–18899** โดยค่าเริ่มต้น
- การลบโปรไฟล์จะย้ายไดเรกทอรีข้อมูลภายในเครื่องไปยังถังขยะ

endpoint ควบคุมทั้งหมดรับ `?profile=<name>`; CLI ใช้ `--browser-profile`

## Chrome extension relay (ใช้ Chrome ที่มีอยู่)

OpenClaw สามารถควบคุม **แท็บ Chrome ที่มีอยู่ของคุณ** ได้ (ไม่มีอินสแตนซ์ Chrome “openclaw” แยก)
ผ่าน CDP relay ภายในเครื่อง + ส่วนขยาย Chrome

คู่มือฉบับเต็ม: [Chrome extension](/tools/chrome-extension)

โฟลว์:

- Gateway รันในเครื่อง (เครื่องเดียวกัน) หรือมีโฮสต์โหนดรันบนเครื่องเบราว์เซอร์
- **เซิร์ฟเวอร์ relay** ภายในเครื่องฟังที่ loopback `cdpUrl` (ค่าเริ่มต้น: `http://127.0.0.1:18792`)
- คุณคลิกไอคอนส่วนขยาย **OpenClaw Browser Relay** บนแท็บเพื่อแนบ (จะไม่แนบอัตโนมัติ)
- เอเจนต์ควบคุมแท็บนั้นผ่านเครื่องมือ `browser` ตามปกติ โดยเลือกโปรไฟล์ที่ถูกต้อง

หาก Gateway รันอยู่ที่อื่น ให้รันโฮสต์โหนดบนเครื่องเบราว์เซอร์เพื่อให้ Gateway พร็อกซีการกระทำของเบราว์เซอร์ได้

### เซสชันแบบ sandboxed

หากเซสชันเอเจนต์เป็นแบบ sandboxed เครื่องมือ `browser` อาจตั้งค่าเริ่มต้นเป็น `target="sandbox"` (เบราว์เซอร์ sandbox)
การยึดการควบคุมผ่าน Chrome extension relay ต้องการการควบคุมเบราว์เซอร์ของโฮสต์ ดังนั้นให้ทำอย่างใดอย่างหนึ่ง:
การยึดการควบคุม Chrome extension relay ต้องการการควบคุมเบราว์เซอร์โฮสต์ ดังนั้นอย่างใดอย่างหนึ่ง:

- รันเซสชันแบบไม่ sandboxed หรือ
- ตั้งค่า `agents.defaults.sandbox.browser.allowHostControl: true` และใช้ `target="host"` เมื่อเรียกเครื่องมือ

### การตั้งค่า

1. โหลดส่วนขยาย (dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → เปิด “Developer mode”
- “Load unpacked” → เลือกไดเรกทอรีที่พิมพ์โดย `openclaw browser extension path`
- ปักหมุดส่วนขยาย จากนั้นคลิกบนแท็บที่ต้องการควบคุม (แบดจะแสดง `ON`)

2. ใช้งาน:

- CLI: `openclaw browser --browser-profile chrome tabs`
- เครื่องมือเอเจนต์: `browser` พร้อม `profile="chrome"`

ไม่บังคับ: หากต้องการชื่อหรือพอร์ต relay ที่ต่างออกไป ให้สร้างโปรไฟล์ของคุณเอง:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

หมายเหตุ:

- โหมดนี้พึ่งพา Playwright-on-CDP สำหรับการทำงานส่วนใหญ่ (ภาพหน้าจอ/สแนปช็อต/การกระทำ)
- ยกเลิกการแนบโดยคลิกไอคอนส่วนขยายอีกครั้ง

## การรับประกันการแยกส่วน

- **ไดเรกทอรีข้อมูลผู้ใช้เฉพาะ**: ไม่แตะต้องโปรไฟล์เบราว์เซอร์ส่วนตัวของคุณ
- **พอร์ตเฉพาะ**: หลีกเลี่ยง `9222` เพื่อป้องกันการชนกับเวิร์กโฟลว์นักพัฒนา
- **การควบคุมแท็บแบบกำหนดแน่นอน**: ระบุเป้าหมายแท็บด้วย `targetId` ไม่ใช่ “แท็บล่าสุด”

## การเลือกเบราว์เซอร์

เมื่อเปิดในเครื่อง OpenClaw จะเลือกตัวแรกที่พร้อมใช้งาน:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

คุณสามารถแทนที่ด้วย `browser.executablePath`

แพลตฟอร์ม:

- macOS: ตรวจสอบ `/Applications` และ `~/Applications`
- Linux: มองหา `google-chrome`, `brave`, `microsoft-edge`, `chromium` เป็นต้น
- Windows: ตรวจสอบตำแหน่งติดตั้งทั่วไป

## Control API (ไม่บังคับ)

สำหรับการผสานรวมภายในเครื่องเท่านั้น Gateway จะเปิด HTTP API ขนาดเล็กบน loopback:

- สถานะ/เริ่ม/หยุด: `GET /`, `POST /start`, `POST /stop`
- แท็บ: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- สแนปช็อต/ภาพหน้าจอ: `GET /snapshot`, `POST /screenshot`
- การกระทำ: `POST /navigate`, `POST /act`
- ฮุค: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- ดาวน์โหลด: `POST /download`, `POST /wait/download`
- การดีบัก: `GET /console`, `POST /pdf`
- การดีบัก: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- เครือข่าย: `POST /response/body`
- สถานะ: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- สถานะ: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- การตั้งค่า: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

endpoint ทั้งหมดรับ `?profile=<name>`

### ข้อกำหนดของ Playwright

ฟีเจอร์บางอย่าง (navigate/act/AI snapshot/role snapshot, ภาพหน้าจอขององค์ประกอบ, PDF) ต้องใช้
Playwright หากไม่ได้ติดตั้ง Playwright เอ็นด์พอยต์เหล่านั้นจะส่งคืนข้อผิดพลาด 501
ที่ชัดเจน ARIA snapshots และภาพหน้าจอพื้นฐานยังคงใช้งานได้สำหรับ Chrome ที่จัดการโดย openclaw
ฟีเจอร์บางอย่าง (navigate/act/AI snapshot/role snapshot, ภาพหน้าจอองค์ประกอบ, PDF)
ต้องใช้ Playwright หากไม่ได้ติดตั้ง Playwright endpoint เหล่านั้นจะคืนค่า
ข้อผิดพลาด 501 อย่างชัดเจน ARIA snapshot และภาพหน้าจอพื้นฐานยังใช้งานได้กับ Chrome แบบ openclaw-managed
สำหรับไดรเวอร์ Chrome extension relay ARIA snapshot และภาพหน้าจอต้องใช้ Playwright

หากคุณเห็น `Playwright is not available in this gateway build` ให้ติดตั้งแพ็กเกจ
Playwright แบบเต็ม (ไม่ใช่ `playwright-core`) และรีสตาร์ต gateway หรือทำการติดตั้ง
OpenClaw ใหม่พร้อมการรองรับเบราว์เซอร์

#### การติดตั้ง Playwright ใน Docker

หาก Gateway ของคุณรันใน Docker ให้หลีกเลี่ยง `npx playwright` (ชนกับการ override ของ npm)
ให้ใช้ CLI ที่มาพร้อมแพ็กเกจแทน:
ให้ใช้ CLI ที่มาพร้อมกันแทน:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

เพื่อเก็บการดาวน์โหลดของเบราว์เซอร์อย่างถาวร ให้ตั้งค่า `PLAYWRIGHT_BROWSERS_PATH` (เช่น
`/home/node/.cache/ms-playwright`) และตรวจสอบว่า `/home/node` ถูกเก็บถาวรผ่าน
`OPENCLAW_HOME_VOLUME` หรือ bind mount ดู [Docker](/install/docker) ดู [Docker](/install/docker)

## ทำงานอย่างไร (ภายใน)

โฟลว์ระดับสูง:

- **เซิร์ฟเวอร์ควบคุม** ขนาดเล็กรับคำขอ HTTP
- เชื่อมต่อกับเบราว์เซอร์ที่อิง Chromium (Chrome/Brave/Edge/Chromium) ผ่าน **CDP**
- สำหรับการกระทำขั้นสูง (คลิก/พิมพ์/สแนปช็อต/PDF) ใช้ **Playwright** ซ้อนบน CDP
- เมื่อไม่มี Playwright จะมีเฉพาะการทำงานที่ไม่พึ่ง Playwright เท่านั้น

การออกแบบนี้ทำให้เอเจนต์ใช้อินเทอร์เฟซที่เสถียรและกำหนดแน่นอน ขณะเดียวกันก็ให้คุณสลับ
เบราว์เซอร์และโปรไฟล์แบบภายใน/ระยะไกลได้

## อ้างอิง CLI อย่างรวดเร็ว

คำสั่งทั้งหมดรับ `--browser-profile <name>` เพื่อระบุโปรไฟล์เป้าหมาย
คำสั่งทั้งหมดยังรับ `--json` สำหรับเอาต์พุตที่เครื่องอ่านได้ (payload เสถียร)
คำสั่งทั้งหมดรองรับ `--json` ด้วย สำหรับเอาต์พุตที่อ่านได้ด้วยเครื่อง (payload คงที่)

พื้นฐาน:

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

การตรวจสอบ:

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

การกระทำ:

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

สถานะ:

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

หมายเหตุ:

- `upload` และ `dialog` เป็นการเรียกแบบ **arming**; ให้รันก่อนการคลิก/กด
  ที่กระตุ้นตัวเลือก/ไดอะล็อก
- `upload` ยังสามารถตั้งค่าอินพุตไฟล์ได้โดยตรงผ่าน `--input-ref` หรือ `--element`
- `snapshot`:
  - `--format ai` (ค่าเริ่มต้นเมื่อมี Playwright): คืนค่า AI snapshot พร้อมตัวอ้างอิงเชิงตัวเลข (`aria-ref="<n>"`)
  - `--format aria`: คืนค่า accessibility tree (ไม่มีตัวอ้างอิง; ใช้ตรวจสอบเท่านั้น)
  - `--efficient` (หรือ `--mode efficient`): พรีเซ็ต role snapshot แบบกะทัดรัด (โต้ตอบได้ + กะทัดรัด + ความลึก + maxChars ต่ำ)
  - ค่าเริ่มต้นจากคอนฟิก (เฉพาะ tool/CLI): ตั้งค่า `browser.snapshotDefaults.mode: "efficient"` เพื่อใช้สแนปช็อตที่มีประสิทธิภาพเมื่อผู้เรียกไม่ส่งโหมดมา (ดู [Gateway configuration](/gateway/configuration#browser-openclaw-managed-browser))
  - ตัวเลือก role snapshot (`--interactive`, `--compact`, `--depth`, `--selector`) บังคับสแนปช็อตแบบอิง role พร้อมตัวอ้างอิงเช่น `ref=e12`
  - `--frame "<iframe selector>"` จำกัดขอบเขต role snapshot ไปยัง iframe (จับคู่กับ role ref เช่น `e12`)
  - `--interactive` ส่งออกเป็นรายการองค์ประกอบที่โต้ตอบได้แบบแบน เลือกได้ง่าย (เหมาะสำหรับขับการกระทำ)
  - `--labels` เพิ่มภาพหน้าจอเฉพาะ viewport พร้อมป้ายกำกับตัวอ้างอิงซ้อนทับ (พิมพ์ `MEDIA:<path>`)
- `click`/`type`/ฯลฯ ต้องใช้ `ref` จาก `snapshot` (เป็นตัวเลข `12` หรือ role ref `e12`)
  การเลือกด้วย CSS selector ถูกตั้งใจไม่รองรับสำหรับการกระทำ
  ตั้งใจไม่รองรับตัวเลือก CSS สำหรับการกระทำ

## Snapshots และ refs

OpenClaw รองรับ “สแนปช็อต” สองรูปแบบ:

- **AI snapshot (ตัวอ้างอิงเชิงตัวเลข)**: `openclaw browser snapshot` (ค่าเริ่มต้น; `--format ai`)
  - เอาต์พุต: สแนปช็อตข้อความที่มีตัวอ้างอิงตัวเลข
  - การกระทำ: `openclaw browser click 12`, `openclaw browser type 23 "hello"`
  - ภายใน ระบบแก้ตัวอ้างอิงผ่าน `aria-ref` ของ Playwright

- **Role snapshot (role ref เช่น `e12`)**: `openclaw browser snapshot --interactive` (หรือ `--compact`, `--depth`, `--selector`, `--frame`)
  - เอาต์พุต: รายการ/ต้นไม้แบบอิง role พร้อม `[ref=e12]` (และ `[nth=1]` แบบไม่บังคับ)
  - การกระทำ: `openclaw browser click e12`, `openclaw browser highlight e12`
  - ภายใน ระบบแก้ตัวอ้างอิงผ่าน `getByRole(...)` (และ `nth()` สำหรับรายการซ้ำ)
  - เพิ่ม `--labels` เพื่อรวมภาพหน้าจอ viewport พร้อมป้าย `e12` ซ้อนทับ

พฤติกรรมของตัวอ้างอิง:

- ตัวอ้างอิง **ไม่เสถียรข้ามการนำทาง**; หากล้มเหลว ให้รัน `snapshot` ใหม่และใช้ตัวอ้างอิงใหม่
- หาก role snapshot ถูกถ่ายด้วย `--frame` role ref จะถูกจำกัดขอบเขตอยู่ใน iframe นั้นจนกว่าจะมี role snapshot ถัดไป

## Wait power-ups

คุณสามารถรอมากกว่าแค่เวลา/ข้อความ:

- รอ URL (รองรับ glob ของ Playwright):
  - `openclaw browser wait --url "**/dash"`
- รอสถานะการโหลด:
  - `openclaw browser wait --load networkidle`
- รอเงื่อนไข JS:
  - `openclaw browser wait --fn "window.ready===true"`
- รอ selector ปรากฏให้เห็น:
  - `openclaw browser wait "#main"`

สามารถรวมกันได้:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## เวิร์กโฟลว์การดีบัก

เมื่อการกระทำล้มเหลว (เช่น “not visible”, “strict mode violation”, “covered”):

1. `openclaw browser snapshot --interactive`
2. ใช้ `click <ref>` / `type <ref>` (แนะนำ role ref ในโหมดโต้ตอบ)
3. หากยังล้มเหลว: `openclaw browser highlight <ref>` เพื่อดูว่า Playwright กำหนดเป้าหมายอะไร
4. หากหน้าเว็บมีพฤติกรรมแปลก:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. สำหรับการดีบักเชิงลึก: บันทึก trace:
   - `openclaw browser trace start`
   - ทำซ้ำปัญหา
   - `openclaw browser trace stop` (พิมพ์ `TRACE:<path>`)

## เอาต์พุตJSON

`--json` ใช้สำหรับสคริปต์และเครื่องมือเชิงโครงสร้าง

ตัวอย่าง:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Role snapshot ใน JSON จะมี `refs` พร้อมบล็อก `stats` ขนาดเล็ก (บรรทัด/ตัวอักษร/ตัวอ้างอิง/โต้ตอบได้) เพื่อให้เครื่องมือประเมินขนาดและความหนาแน่นของ payload ได้

## ปุ่มควบคุมสถานะและสภาพแวดล้อม

มีประโยชน์สำหรับเวิร์กโฟลว์ “ทำให้เว็บไซต์ทำงานเหมือน X”:

- คุกกี้: `cookies`, `cookies set`, `cookies clear`
- สตอเรจ: `storage local|session get|set|clear`
- ออฟไลน์: `set offline on|off`
- เฮดเดอร์: `set headers --json '{"X-Debug":"1"}'` (หรือ `--clear`)
- HTTP basic auth: `set credentials user pass` (หรือ `--clear`)
- ตำแหน่งที่ตั้ง: `set geo <lat> <lon> --origin "https://example.com"` (หรือ `--clear`)
- มีเดีย: `set media dark|light|no-preference|none`
- โซนเวลา/โลแคล: `set timezone ...`, `set locale ...`
- อุปกรณ์/viewport:
  - `set device "iPhone 14"` (Playwright device presets)
  - `set viewport 1280 720`

## ความปลอดภัยและความเป็นส่วนตัว

- โปรไฟล์เบราว์เซอร์ openclaw อาจมีเซสชันที่ล็อกอินอยู่ ให้ถือว่าเป็นข้อมูลอ่อนไหว
- `browser act kind=evaluate` / `openclaw browser evaluate` และ `wait --fn`
  รัน JavaScript ใดๆ ในบริบทของหน้า การโจมตีแบบ prompt injection สามารถชี้นำได้
  ปิดด้วย `browser.evaluateEnabled=false` หากไม่จำเป็น การฉีดพรอมต์สามารถชี้นำ
  สิ่งนี้ได้ ปิดใช้งานด้วย `browser.evaluateEnabled=false` หากคุณไม่ต้องการมัน
- สำหรับการล็อกอินและหมายเหตุ anti-bot (X/Twitter ฯลฯ) ดู [Browser login + X/Twitter posting](/tools/browser-login)
- เก็บ Gateway/โฮสต์โหนดให้เป็นส่วนตัว (loopback หรือเฉพาะ tailnet)
- endpoint ของ Remote CDP มีพลังสูง ควรทำอุโมงค์และปกป้อง

## การแก้ไขปัญหา

สำหรับปัญหาเฉพาะ Linux (โดยเฉพาะ snap Chromium) ดู
[Browser troubleshooting](/tools/browser-linux-troubleshooting)

## เครื่องมือเอเจนต์และการทำงานของการควบคุม

เอเจนต์จะได้รับ **เครื่องมือเดียว** สำหรับระบบอัตโนมัติของเบราว์เซอร์:

- `browser` — สถานะ/เริ่ม/หยุด/แท็บ/เปิด/โฟกัส/ปิด/สแนปช็อต/ภาพหน้าจอ/นำทาง/act

การแมปเป็นอย่างไร:

- `browser snapshot` คืนค่าโครงสร้าง UI ที่เสถียร (AI หรือ ARIA)
- `browser act` ใช้ ID ของสแนปช็อต `ref` เพื่อคลิก/พิมพ์/ลาก/เลือก
- `browser screenshot` จับพิกเซล (ทั้งหน้า或องค์ประกอบ)
- `browser` รับ:
  - `profile` เพื่อเลือกโปรไฟล์เบราว์เซอร์ที่ตั้งชื่อ (openclaw, chrome หรือ remote CDP)
  - `target` (`sandbox` | `host` | `node`) เพื่อเลือกตำแหน่งที่เบราว์เซอร์อยู่
  - ในเซสชัน sandboxed, `target: "host"` ต้องใช้ `agents.defaults.sandbox.browser.allowHostControl=true`
  - หากละ `target`: เซสชัน sandboxed จะใช้ค่าเริ่มต้น `sandbox`, เซสชันไม่ sandbox จะใช้ `host`
  - หากมีโหนดที่รองรับเบราว์เซอร์เชื่อมต่ออยู่ เครื่องมืออาจจัดเส้นทางอัตโนมัติไปยังโหนดนั้น เว้นแต่คุณจะปักหมุด `target="host"` หรือ `target="node"`

แนวทางนี้ทำให้เอเจนต์ทำงานได้แบบกำหนดแน่นอนและหลีกเลี่ยง selector ที่เปราะบาง
