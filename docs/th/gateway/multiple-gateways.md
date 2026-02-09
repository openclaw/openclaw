---
summary: "รัน OpenClaw Gateway（เกตเวย์）หลายตัวบนโฮสต์เดียว(การแยกส่วน พอร์ต และโปรไฟล์)"
read_when:
  - รัน Gateway（เกตเวย์）มากกว่าหนึ่งตัวบนเครื่องเดียวกัน
  - ต้องการคอนฟิก/สถานะ/พอร์ตที่แยกจากกันต่อ Gateway（เกตเวย์）
title: "หลาย Gateway（เกตเวย์）"
---

# หลาย Gateway（เกตเวย์）(โฮสต์เดียวกัน)

การตั้งค่าส่วนใหญ่ควรใช้ Gateway（เกตเวย์）เพียงตัวเดียว เนื่องจาก Gateway（เกตเวย์）ตัวเดียวสามารถจัดการการเชื่อมต่อระบบข้อความหลายช่องทางและเอเจนต์หลายตัวได้ หากต้องการการแยกส่วนที่เข้มแข็งขึ้นหรือความซ้ำซ้อน(เช่น บอตกู้ภัย) ให้รัน Gateway（เกตเวย์）แยกกันโดยใช้โปรไฟล์/พอร์ตที่แยกจากกัน If you need stronger isolation or redundancy (e.g., a rescue bot), run separate Gateways with isolated profiles/ports.

## เช็กลิสต์การแยกส่วน(จำเป็น)

- `OPENCLAW_CONFIG_PATH` — ไฟล์คอนฟิกต่ออินสแตนซ์
- `OPENCLAW_STATE_DIR` — เซสชัน ครีเดนเชียล แคชต่ออินสแตนซ์
- `agents.defaults.workspace` — รูทเวิร์กสเปซต่ออินสแตนซ์
- `gateway.port` (หรือ `--port`) — ต้องไม่ซ้ำกันต่ออินสแตนซ์
- พอร์ตที่ได้มาภายหลัง(เบราว์เซอร์/แคนวาส)ต้องไม่ทับซ้อนกัน

หากมีการใช้ร่วมกัน จะเกิดการแย่งเขียนคอนฟิกและความขัดแย้งของพอร์ต

## แนะนำ: โปรไฟล์(`--profile`)

โปรไฟล์จะกำหนดขอบเขต `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` อัตโนมัติ และเติมคำต่อท้ายชื่อบริการ

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

บริการต่อโปรไฟล์:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## คู่มือบอตกู้ภัย

รัน Gateway（เกตเวย์）ตัวที่สองบนโฮสต์เดียวกัน โดยมีของตนเอง:

- โปรไฟล์/คอนฟิก
- state dir
- เวิร์กสเปซ
- พอร์ตฐาน(รวมพอร์ตที่ได้มาภายหลัง)

วิธีนี้ทำให้บอตกู้ภัยแยกจากบอตหลัก เพื่อให้สามารถดีบักหรือปรับใช้การเปลี่ยนแปลงคอนฟิกได้เมื่อบอตหลักล่ม

การเว้นระยะพอร์ต: เว้นอย่างน้อย 20 พอร์ตระหว่างพอร์ตฐาน เพื่อให้พอร์ตเบราว์เซอร์/แคนวาส/CDP ที่ได้มาภายหลังไม่ชนกัน

### วิธีติดตั้ง(บอตกู้ภัย)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## การแมปพอร์ต(พอร์ตที่ได้มาภายหลัง)

พอร์ตฐาน = `gateway.port` (หรือ `OPENCLAW_GATEWAY_PORT` / `--port`).

- พอร์ตบริการควบคุมเบราว์เซอร์ = ฐาน + 2 (เฉพาะ local loopback)
- `canvasHost.port = base + 4`
- พอร์ต CDP ของโปรไฟล์เบราว์เซอร์จะจัดสรรอัตโนมัติจาก `browser.controlPort + 9 .. + 108`

หากคุณเขียนทับค่าใดๆ ในคอนฟิกหรือ environment variables ต้องรักษาให้ไม่ซ้ำกันต่ออินสแตนซ์

## หมายเหตุ Browser/CDP(กับดักที่พบบ่อย)

- **อย่า**ตรึงค่า `browser.cdpUrl` ให้เหมือนกันบนหลายอินสแตนซ์
- แต่ละอินสแตนซ์ต้องมีพอร์ตควบคุมเบราว์เซอร์และช่วง CDP ของตนเอง(อ้างอิงจากพอร์ตของ Gateway)
- หากต้องการกำหนดพอร์ต CDP แบบระบุชัด ให้ตั้งค่า `browser.profiles.<name>.cdpPort` ต่ออินสแตนซ์
- Chrome ระยะไกล: ใช้ `browser.profiles.<name>.cdpUrl` (ต่อโปรไฟล์ ต่ออินสแตนซ์)

## Manual env example

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## การตรวจสอบอย่างรวดเร็ว

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
