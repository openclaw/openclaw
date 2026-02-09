---
summary: "คู่มือการแก้ไขปัญหาเชิงลึกสำหรับเกตเวย์ ช่องทาง ระบบอัตโนมัติ โหนด และเบราว์เซอร์"
read_when:
  - ศูนย์การแก้ไขปัญหาแนะนำให้มาที่นี่เพื่อการวินิจฉัยเชิงลึก
  - คุณต้องการส่วนคู่มือแบบอิงอาการที่เสถียรพร้อมคำสั่งที่ชัดเจน
title: "การแก้ไขปัญหา"
---

# การแก้ไขปัญหา Gateway

หน้านี้คือคู่มือเชิงลึก
หน้านี้เป็นคู่มือเชิงลึก
เริ่มที่ [/help/troubleshooting](/help/troubleshooting) หากต้องการโฟลว์คัดกรองอย่างรวดเร็วก่อน

## ลำดับขั้นคำสั่ง

รันคำสั่งเหล่านี้ก่อน ตามลำดับนี้:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

สัญญาณที่คาดหวังเมื่อระบบปกติ:

- `openclaw gateway status` แสดง `Runtime: running` และ `RPC probe: ok`.
- `openclaw doctor` รายงานว่าไม่มีปัญหาคอนฟิก/บริการที่บล็อกการทำงาน
- `openclaw channels status --probe` แสดงช่องทางที่เชื่อมต่อ/พร้อมใช้งาน

## ไม่มีการตอบกลับ

หากช่องทางทำงานอยู่แต่ไม่มีการตอบกลับ ให้ตรวจสอบการกำหนดเส้นทางและนโยบายก่อนทำการเชื่อมต่อใหม่ใดๆ

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

มองหา:

- การจับคู่ค้างอยู่สำหรับผู้ส่ง DM
- การจำกัดการกล่าวถึงในกลุ่ม (`requireMention`, `mentionPatterns`)
- ความไม่ตรงกันของ allowlist ช่องทาง/กลุ่ม

ลักษณะอาการที่พบบ่อย:

- `drop guild message (mention required` → ข้อความกลุ่มถูกเพิกเฉยจนกว่าจะมีการกล่าวถึง
- `pairing request` → ผู้ส่งต้องได้รับการอนุมัติ
- `blocked` / `allowlist` → ผู้ส่ง/ช่องทางถูกกรองโดยนโยบาย

ที่เกี่ยวข้อง:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## การเชื่อมต่อ UI ควบคุมแดชบอร์ด

เมื่อแดชบอร์ด/UI ควบคุมไม่สามารถเชื่อมต่อได้ ให้ตรวจสอบ URL โหมดการยืนยันตัวตน และสมมติฐานบริบทความปลอดภัย

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

มองหา:

- URL สำหรับตรวจสอบและ URL แดชบอร์ดถูกต้อง
- โหมด/โทเคนการยืนยันตัวตนไม่ตรงกันระหว่างไคลเอนต์และเกตเวย์
- ใช้ HTTP ในกรณีที่ต้องการตัวตนอุปกรณ์

ลักษณะอาการที่พบบ่อย:

- `device identity required` → บริบทไม่ปลอดภัยหรือขาดการยืนยันตัวตนอุปกรณ์
- `unauthorized` / วนลูปการเชื่อมต่อใหม่ → โทเคน/รหัสผ่านไม่ตรงกัน
- `gateway connect failed:` → โฮสต์/พอร์ต/URL เป้าหมายไม่ถูกต้อง

ที่เกี่ยวข้อง:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## บริการ Gateway ไม่ทำงาน

ใช้กรณีนี้เมื่อบริการติดตั้งแล้วแต่โปรเซสไม่สามารถทำงานต่อเนื่องได้

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

มองหา:

- `Runtime: stopped` พร้อมคำใบ้การออกจากโปรเซส
- คอนฟิกบริการไม่ตรงกัน (`Config (cli)` เทียบกับ `Config (service)`)
- ความขัดแย้งของพอร์ต/ตัวรับฟัง

ลักษณะอาการที่พบบ่อย:

- `Gateway start blocked: set gateway.mode=local` → โหมดเกตเวย์ภายในเครื่องไม่ได้เปิดใช้งาน
- `refusing to bind gateway ... without auth` → bind ที่ไม่ใช่ loopback โดยไม่มีโทเคน/รหัสผ่าน
- `another gateway instance is already listening` / `EADDRINUSE` → พอร์ตขัดแย้ง

ที่เกี่ยวข้อง:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## ช่องทางเชื่อมต่อแล้วแต่ข้อความไม่ไหล

หากสถานะช่องทางเป็นเชื่อมต่อแล้วแต่การไหลของข้อความหยุด ให้โฟกัสที่นโยบาย สิทธิ์ และกติกาการส่งเฉพาะของช่องทาง

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

มองหา:

- นโยบาย DM (`pairing`, `allowlist`, `open`, `disabled`)
- allowlist กลุ่มและข้อกำหนดการกล่าวถึง
- สิทธิ์/สโคป API ของช่องทางที่ขาดหาย

ลักษณะอาการที่พบบ่อย:

- `mention required` → ข้อความถูกเพิกเฉยตามนโยบายการกล่าวถึงในกลุ่ม
- `pairing` / ร่องรอยการอนุมัติค้างอยู่ → ผู้ส่งยังไม่ได้รับการอนุมัติ
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → ปัญหาการยืนยันตัวตน/สิทธิ์ของช่องทาง

ที่เกี่ยวข้อง:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## การส่งมอบ Cron และ Heartbeat

หาก cron หรือ heartbeat ไม่ทำงานหรือไม่ถูกส่ง ให้ตรวจสอบสถานะตัวจัดตารางก่อน จากนั้นตรวจสอบเป้าหมายการส่งมอบ

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

มองหา:

- เปิดใช้งาน cron และมีเวลาปลุกถัดไป
- สถานะประวัติการรันงาน (`ok`, `skipped`, `error`)
- เหตุผลที่ข้าม heartbeat (`quiet-hours`, `requests-in-flight`, `alerts-disabled`)

ลักษณะอาการที่พบบ่อย:

- `cron: scheduler disabled; jobs will not run automatically` → cron ถูกปิดใช้งาน
- `cron: timer tick failed` → การติ๊กของตัวจัดตารางล้มเหลว; ตรวจสอบไฟล์/ล็อก/ข้อผิดพลาดรันไทม์
- `heartbeat skipped` พร้อม `reason=quiet-hours` → อยู่นอกช่วงชั่วโมงที่เปิดใช้งาน
- `heartbeat: unknown accountId` → account id สำหรับเป้าหมายการส่ง heartbeat ไม่ถูกต้อง

ที่เกี่ยวข้อง:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## เครื่องมือของโหนดที่จับคู่แล้วล้มเหลว

หากโหนดจับคู่แล้วแต่เครื่องมือใช้งานไม่ได้ ให้แยกวิเคราะห์สถานะโฟร์กราวด์ สิทธิ์ และการอนุมัติ

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

มองหา:

- โหนดออนไลน์พร้อมความสามารถที่คาดหวัง
- การอนุญาตระดับ OS สำหรับกล้อง/ไมค์/ตำแหน่ง/หน้าจอ
- การอนุมัติการรันคำสั่งและสถานะ allowlist

ลักษณะอาการที่พบบ่อย:

- `NODE_BACKGROUND_UNAVAILABLE` → แอปโหนดต้องอยู่ในโฟร์กราวด์
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → ขาดการอนุญาตระดับ OS
- `SYSTEM_RUN_DENIED: approval required` → การอนุมัติการรันคำสั่งค้างอยู่
- `SYSTEM_RUN_DENIED: allowlist miss` → คำสั่งถูกบล็อกโดย allowlist

ที่เกี่ยวข้อง:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## เครื่องมือเบราว์เซอร์ล้มเหลว

ใช้กรณีนี้เมื่อการทำงานของเครื่องมือเบราว์เซอร์ล้มเหลวแม้ว่าเกตเวย์จะปกติดี

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

มองหา:

- พาธไฟล์ปฏิบัติการของเบราว์เซอร์ถูกต้อง
- การเข้าถึงโปรไฟล์ CDP
- การแนบแท็บรีเลย์ส่วนขยายสำหรับ `profile="chrome"`

ลักษณะอาการที่พบบ่อย:

- `Failed to start Chrome CDP on port` → โปรเซสเบราว์เซอร์ไม่สามารถเริ่มได้
- `browser.executablePath not found` → พาธที่ตั้งค่าไว้ไม่ถูกต้อง
- `Chrome extension relay is running, but no tab is connected` → รีเลย์ส่วนขยายไม่ได้แนบ
- `Browser attachOnly is enabled ... not reachable` → โปรไฟล์แบบแนบอย่างเดียวไม่มีเป้าหมายที่เข้าถึงได้

ที่เกี่ยวข้อง:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## หากคุณอัปเกรดแล้วเกิดปัญหาทันที

ปัญหาหลังอัปเกรดส่วนใหญ่เกิดจากคอนฟิกเปลี่ยนหรือค่าเริ่มต้นที่เข้มงวดขึ้นถูกบังคับใช้

### 1. พฤติกรรมการยืนยันตัวตนและการ override URL เปลี่ยนไป

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

สิ่งที่ต้องตรวจสอบ:

- หาก `gateway.mode=remote` การเรียก CLI อาจชี้ไปยังรีโมตทั้งที่บริการภายในเครื่องปกติดี
- การเรียก `--url` แบบระบุชัดจะไม่ย้อนกลับไปใช้ข้อมูลรับรองที่เก็บไว้

ลักษณะอาการที่พบบ่อย:

- `gateway connect failed:` → เป้าหมาย URL ไม่ถูกต้อง
- `unauthorized` → ปลายทางเข้าถึงได้แต่การยืนยันตัวตนไม่ถูกต้อง

### 2. ข้อกำหนดการ bind และ guardrail การยืนยันตัวตนเข้มงวดขึ้น

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

สิ่งที่ต้องตรวจสอบ:

- การ bind ที่ไม่ใช่ loopback (`lan`, `tailnet`, `custom`) ต้องตั้งค่าการยืนยันตัวตน
- คีย์เก่าอย่าง `gateway.token` ไม่สามารถแทนที่ `gateway.auth.token` ได้

ลักษณะอาการที่พบบ่อย:

- `refusing to bind gateway ... without auth` → bind+auth ไม่ตรงกัน
- `RPC probe: failed` ขณะรันไทม์ทำงานอยู่ → เกตเวย์ยังทำงานแต่ไม่สามารถเข้าถึงด้วย auth/URL ปัจจุบัน

### 3. สถานะการจับคู่และตัวตนอุปกรณ์เปลี่ยนไป

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

สิ่งที่ต้องตรวจสอบ:

- การอนุมัติอุปกรณ์ที่ค้างอยู่สำหรับแดชบอร์ด/โหนด
- การอนุมัติการจับคู่ DM ที่ค้างอยู่หลังการเปลี่ยนนโยบายหรือตัวตน

ลักษณะอาการที่พบบ่อย:

- `device identity required` → การยืนยันตัวตนอุปกรณ์ไม่ผ่าน
- `pairing required` → ผู้ส่ง/อุปกรณ์ต้องได้รับการอนุมัติ

หากคอนฟิกบริการและรันไทม์ยังไม่ตรงกันหลังตรวจสอบ ให้ติดตั้งเมทาดาทาบริการใหม่จากไดเรกทอรีโปรไฟล์/สถานะเดียวกัน:

```bash
openclaw gateway install --force
openclaw gateway restart
```

ที่เกี่ยวข้อง:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
