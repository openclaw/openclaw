---
summary: "วงจรชีวิตของGatewayบนmacOS(launchd)"
read_when:
  - การผสานแอปmacOSเข้ากับวงจรชีวิตของGateway
title: "วงจรชีวิตของGateway"
x-i18n:
  source_path: platforms/mac/child-process.md
  source_hash: 9b910f574b723bc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:27Z
---

# วงจรชีวิตของGatewayบนmacOS

แอปmacOS **จัดการGatewayผ่านlaunchd** เป็นค่าเริ่มต้น และจะไม่สตาร์ต
Gatewayเป็นโปรเซสลูก แอปจะพยายามเชื่อมต่อกับGatewayที่กำลังรันอยู่แล้วบนพอร์ตที่กำหนดก่อน หากไม่พบจึงจะเปิดใช้งานบริการlaunchdผ่านCLIภายนอก `openclaw` (ไม่มีรันไทม์ฝังมา) วิธีนี้ช่วยให้เริ่มอัตโนมัติเมื่อเข้าสู่ระบบและรีสตาร์ตเมื่อเกิดการแครชได้อย่างเชื่อถือได้

โหมดโปรเซสลูก (Gatewayถูกสตาร์ตโดยแอปโดยตรง) **ยังไม่ถูกใช้งาน** ในปัจจุบัน หากต้องการการเชื่อมโยงกับUIที่แน่นขึ้น ให้รันGatewayด้วยตนเองในเทอร์มินัล

## พฤติกรรมเริ่มต้น (launchd)

- แอปติดตั้ง LaunchAgent ต่อผู้ใช้โดยมีป้ายกำกับ `bot.molt.gateway`
  (หรือ `bot.molt.<profile>` เมื่อใช้ `--profile`/`OPENCLAW_PROFILE`; รองรับ legacy `com.openclaw.*`).
- เมื่อเปิดใช้งานโหมดLocal แอปจะตรวจให้แน่ใจว่า LaunchAgent ถูกโหลด และ
  จะสตาร์ตGatewayหากจำเป็น
- บันทึกถูกเขียนไปยังพาธล็อกGatewayของlaunchd (ดูได้ใน Debug Settings)

คำสั่งที่ใช้บ่อย:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

แทนที่ป้ายกำกับด้วย `bot.molt.<profile>` เมื่อรันโปรไฟล์ที่มีชื่อ

## บิลด์สำหรับพัฒนาแบบไม่เซ็นชื่อ

`scripts/restart-mac.sh --no-sign` ใช้สำหรับบิลด์โลคัลอย่างรวดเร็วเมื่อคุณยังไม่มี
คีย์สำหรับการเซ็นชื่อ เพื่อป้องกันไม่ให้launchdชี้ไปยังไบนารีรีเลย์ที่ไม่ถูกเซ็นชื่อ แอปจะ:

- เขียน `~/.openclaw/disable-launchagent`.

การรันแบบเซ็นชื่อของ `scripts/restart-mac.sh` จะล้างการแทนค่านี้หากพบมาร์กเกอร์
หากต้องการรีเซ็ตด้วยตนเอง:

```bash
rm ~/.openclaw/disable-launchagent
```

## โหมดแนบอย่างเดียว (Attach-only)

หากต้องการบังคับให้แอปmacOS **ไม่ติดตั้งหรือจัดการlaunchdเลย** ให้เปิดแอปด้วย
`--attach-only` (หรือ `--no-launchd`) ซึ่งจะตั้งค่า `~/.openclaw/disable-launchagent`,
ทำให้แอปทำได้เพียงแนบเข้ากับGatewayที่กำลังรันอยู่แล้ว คุณสามารถสลับพฤติกรรมเดียวกันได้ใน Debug Settings

## โหมดRemote

โหมดRemoteจะไม่สตาร์ตGatewayในเครื่อง แอปจะใช้อุโมงค์SSHไปยังโฮสต์ระยะไกลและเชื่อมต่อผ่านอุโมงค์นั้น

## เหตุผลที่เราเลือกใช้launchd

- เริ่มอัตโนมัติเมื่อเข้าสู่ระบบ
- มีกลไกรีสตาร์ต/KeepAliveในตัว
- บันทึกและการกำกับดูแลที่คาดเดาได้

หากจำเป็นต้องมีโหมดโปรเซสลูกจริงๆ อีกครั้ง ควรจัดทำเอกสารเป็นโหมดสำหรับนักพัฒนาเท่านั้นที่แยกชัดเจน
