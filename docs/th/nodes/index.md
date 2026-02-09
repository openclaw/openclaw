---
summary: "โหนด: การจับคู่ ความสามารถ สิทธิ์ และตัวช่วยCLIสำหรับcanvas/camera/screen/system"
read_when:
  - การจับคู่โหนดiOS/Androidเข้ากับGateway
  - การใช้canvas/cameraของโหนดสำหรับบริบทเอเจนต์
  - การเพิ่มคำสั่งโหนดใหม่หรือตัวช่วยCLI
title: "โหนด"
---

# โหนด

**โหนด**คืออุปกรณ์คู่หู(macOS/iOS/Android/ไม่มีหน้าจอ)ที่เชื่อมต่อกับGateway **WebSocket**(พอร์ตเดียวกับโอเปอเรเตอร์)ด้วย `role: "node"` และเปิดเผยพื้นผิวคำสั่ง(เช่น `canvas.*`, `camera.*`, `system.*`) ผ่าน `node.invoke`. รายละเอียดโปรโตคอล: [Gateway protocol](/gateway/protocol)

ทรานสปอร์ตแบบเดิม: [Bridge protocol](/gateway/bridge-protocol)(TCP JSONL; เลิกใช้/ถอดออกสำหรับโหนดปัจจุบัน)

macOSยังสามารถรันใน**โหมดโหนด**ได้: แอปเมนูบาร์จะเชื่อมต่อกับเซิร์ฟเวอร์WSของGatewayและเปิดเผยคำสั่งcanvas/cameraภายในเครื่องเป็นโหนด(ดังนั้น `openclaw nodes …` จึงทำงานกับMacเครื่องนี้ได้)

หมายเหตุ:

- โหนดเป็น**อุปกรณ์ต่อพ่วง**ไม่ใช่เกตเวย์ พวกมันไม่รันบริการเกตเวย์ 20. พวกเขาไม่ได้รันบริการเกตเวย์
- ข้อความจากTelegram/WhatsApp/ฯลฯจะมาถึงที่**gateway**ไม่ใช่โหนด
- คู่มือการแก้ไขปัญหา: [/nodes/troubleshooting](/nodes/troubleshooting)

## การจับคู่+สถานะ

**โหนดWSใช้การจับคู่อุปกรณ์** โหนดจะแสดงตัวตนอุปกรณ์ระหว่าง `connect`; Gateway
จะสร้างคำขอจับคู่อุปกรณ์สำหรับ `role: node` อนุมัติผ่านCLIของอุปกรณ์(หรือUI) 21. อนุมัติผ่าน CLI ของอุปกรณ์ (หรือ UI)

CLIแบบย่อ:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

หมายเหตุ:

- `nodes status` จะทำเครื่องหมายโหนดเป็น**จับคู่แล้ว**เมื่อบทบาทการจับคู่อุปกรณ์มี `node`
- `node.pair.*`(CLI: `openclaw nodes pending/approve/reject`) เป็นที่เก็บการจับคู่โหนดที่Gatewayเป็นเจ้าของแยกต่างหาก; มัน**ไม่**ได้ควบคุมการแฮนด์เชคWS `connect`

## โฮสต์โหนดระยะไกล(system.run)

22. ใช้ **node host** เมื่อ Gateway ของคุณรันบนเครื่องหนึ่งและคุณต้องการให้คำสั่งไปทำงานบนอีกเครื่องหนึ่ง ใช้**โฮสต์โหนด**เมื่อGatewayรันอยู่บนเครื่องหนึ่งและคุณต้องการให้คำสั่งไปรันบนอีกเครื่องหนึ่ง โมเดลยังคงคุยกับ**gateway**; gateway
    จะส่งต่อการเรียก `exec` ไปยัง**โฮสต์โหนด**เมื่อเลือก `host=node`

### อะไรรันที่ไหน

- **โฮสต์Gateway**: รับข้อความ รันโมเดล จัดเส้นทางการเรียกเครื่องมือ
- **โฮสต์โหนด**: รัน `system.run`/`system.which` บนเครื่องโหนด
- **การอนุมัติ**: บังคับใช้บนโฮสต์โหนดผ่าน `~/.openclaw/exec-approvals.json`

### เริ่มโฮสต์โหนด(โฟร์กราวด์)

บนเครื่องโหนด:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Gatewayระยะไกลผ่านอุโมงค์SSH(ผูกกับloopback)

หากGatewayผูกกับloopback(`gateway.bind=loopback` ค่าเริ่มต้นในโหมดโลคัล) โฮสต์โหนดระยะไกลจะเชื่อมต่อโดยตรงไม่ได้ ให้สร้างอุโมงค์SSHแล้วชี้โฮสต์โหนดไปยังปลายโลคัลของอุโมงค์ 23. สร้าง SSH tunnel แล้วชี้
node host ไปยังปลายทางภายในเครื่องของ tunnel

ตัวอย่าง(โฮสต์โหนด->โฮสต์Gateway):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

หมายเหตุ:

- โทเคนคือ `gateway.auth.token` จากคอนฟิกgateway(`~/.openclaw/openclaw.json` บนโฮสต์gateway)
- `openclaw node run` อ่าน `OPENCLAW_GATEWAY_TOKEN` เพื่อยืนยันตัวตน

### เริ่มโฮสต์โหนด(บริการ)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### จับคู่+ตั้งชื่อ

บนโฮสต์gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

ตัวเลือกการตั้งชื่อ:

- `--display-name` บน `openclaw node run` / `openclaw node install`(คงอยู่ใน `~/.openclaw/node.json` บนโหนด)
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"`(การแทนที่จากgateway)

### อนุญาตคำสั่งในรายการอนุญาต

การอนุมัติการรันเป็นแบบ**ต่อโฮสต์โหนด** เพิ่มรายการอนุญาตจากgateway: 24. เพิ่มรายการ allowlist จากเกตเวย์:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

การอนุมัติจะอยู่บนโฮสต์โหนดที่ `~/.openclaw/exec-approvals.json`.

### ชี้execไปที่โหนด

กำหนดค่าเริ่มต้น(คอนฟิกgateway):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

หรือกำหนดต่อเซสชัน:

```
/exec host=node security=allowlist node=<id-or-name>
```

เมื่อตั้งค่าแล้ว การเรียก `exec` ใดๆที่มี `host=node` จะรันบนโฮสต์โหนด(ขึ้นกับรายการอนุญาต/การอนุมัติของโหนด)

ที่เกี่ยวข้อง:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## การเรียกใช้คำสั่ง

ระดับต่ำ(RPCดิบ):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

มีตัวช่วยระดับสูงสำหรับเวิร์กโฟลว์ทั่วไปแบบ“ให้อีเจนต์มีไฟล์MEDIAแนบ”

## สกรีนช็อต(สแนปช็อตcanvas)

หากโหนดกำลังแสดงCanvas(WebView) `canvas.snapshot` จะคืนค่า `{ format, base64 }`.

ตัวช่วยCLI(เขียนไปยังไฟล์ชั่วคราวและพิมพ์ `MEDIA:<path>`):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### การควบคุมCanvas

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

หมายเหตุ:

- `canvas present` รองรับURLหรือพาธไฟล์ภายในเครื่อง(`--target`) พร้อม `--x/--y/--width/--height` สำหรับการจัดตำแหน่ง
- `canvas eval` รองรับJSแบบอินไลน์(`--js`) หรืออาร์กิวเมนต์ตามตำแหน่ง

### A2UI(Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

หมายเหตุ:

- รองรับเฉพาะA2UI v0.8 JSONL(v0.9/createSurfaceจะถูกปฏิเสธ)

## รูปภาพ+วิดีโอ(กล้องโหนด)

รูปภาพ(`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

คลิปวิดีโอ(`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

หมายเหตุ:

- โหนดต้องอยู่ใน**โฟร์กราวด์**สำหรับ `canvas.*` และ `camera.*`(การเรียกพื้นหลังจะคืนค่า `NODE_BACKGROUND_UNAVAILABLE`)
- ระยะเวลาคลิปถูกจำกัด(ปัจจุบัน `<= 60s`) เพื่อหลีกเลี่ยงpayload base64ขนาดใหญ่
- Androidจะขอสิทธิ์ `CAMERA`/`RECORD_AUDIO` เมื่อเป็นไปได้; การปฏิเสธสิทธิ์จะล้มเหลวด้วย `*_PERMISSION_REQUIRED`

## การบันทึกหน้าจอ(โหนด)

โหนดเปิดเผย `screen.record`(mp4) ตัวอย่าง: ตัวอย่าง:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

หมายเหตุ:

- `screen.record` ต้องให้แอปโหนดอยู่โฟร์กราวด์
- Androidจะแสดงพรอมต์การจับภาพหน้าจอของระบบก่อนบันทึก
- การบันทึกหน้าจอถูกจำกัดที่ `<= 60s`
- `--no-audio` ปิดการบันทึกไมโครโฟน(รองรับบน iOS/Android; macOSใช้เสียงจากการจับภาพของระบบ)
- ใช้ `--screen <index>` เพื่อเลือกจอเมื่อมีหลายหน้าจอ

## ตำแหน่งที่ตั้ง(โหนด)

โหนดเปิดเผย `location.get` เมื่อเปิดใช้งานLocationในการตั้งค่า

ตัวช่วยCLI:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

หมายเหตุ:

- Location**ปิดเป็นค่าเริ่มต้น**
- “Always”ต้องใช้สิทธิ์ของระบบ; การดึงข้อมูลเบื้องหลังเป็นแบบพยายามให้ได้ผล
- การตอบกลับมีlat/lon ความแม่นยำ(เมตร) และเวลา

## SMS(โหนดAndroid)

โหนดAndroidสามารถเปิดเผย `sms.send` เมื่อผู้ใช้ให้สิทธิ์**SMS**และอุปกรณ์รองรับโทรศัพท์

การเรียกระดับต่ำ:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

หมายเหตุ:

- ต้องยอมรับพรอมต์สิทธิ์บนอุปกรณ์Androidก่อนจึงจะโฆษณาความสามารถได้
- อุปกรณ์ที่มีแต่Wi‑Fiและไม่มีโทรศัพท์จะไม่โฆษณา `sms.send`

## คำสั่งระบบ(โฮสต์โหนด/โหนดmac)

โหนดmacOSเปิดเผย `system.run`, `system.notify`, และ `system.execApprovals.get/set`.
โฮสต์โหนดแบบไม่มีหน้าจอเปิดเผย `system.run`, `system.which`, และ `system.execApprovals.get/set`.

ตัวอย่าง:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

หมายเหตุ:

- `system.run` คืนค่าstdout/stderr/exit codeในpayload
- `system.notify` เคารพสถานะสิทธิ์การแจ้งเตือนในแอปmacOS
- `system.run` รองรับ `--cwd`, `--env KEY=VAL`, `--command-timeout`, และ `--needs-screen-recording`
- `system.notify` รองรับ `--priority <passive|active|timeSensitive>` และ `--delivery <system|overlay|auto>`
- โหนดmacOSจะทิ้งการแทนที่ `PATH`; โฮสต์โหนดแบบไม่มีหน้าจอจะยอมรับ `PATH` เฉพาะเมื่อมันนำหน้าPATHของโฮสต์โหนด
- ในโหมดโหนดmacOS `system.run` ถูกควบคุมด้วยการอนุมัติการรันในแอปmacOS(การตั้งค่า→Exec approvals) โหมดAsk/allowlist/fullทำงานเหมือนโฮสต์โหนดแบบไม่มีหน้าจอ; การปฏิเสธพรอมต์จะคืนค่า `SYSTEM_RUN_DENIED`
  25. Ask/allowlist/full ทำงานเหมือนกับ headless node host; คำขอที่ถูกปฏิเสธจะส่งคืน `SYSTEM_RUN_DENIED`
- บนโฮสต์โหนดแบบไม่มีหน้าจอ `system.run` ถูกควบคุมด้วยการอนุมัติการรัน(`~/.openclaw/exec-approvals.json`)

## การผูกexecกับโหนด

26. เมื่อมีหลายโหนดให้ใช้งาน คุณสามารถผูก exec กับโหนดเฉพาะได้
    เมื่อมีหลายโหนด คุณสามารถผูกexecกับโหนดที่เฉพาะเจาะจงได้ สิ่งนี้ตั้งค่าโหนดเริ่มต้นสำหรับ `exec host=node`(และสามารถแทนที่ต่อเอเจนต์ได้)

ค่าเริ่มต้นส่วนกลาง:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

การแทนที่ต่อเอเจนต์:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

ยกเลิกการตั้งค่าเพื่ออนุญาตโหนดใดก็ได้:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## แผนที่สิทธิ์

โหนดอาจรวมแผนที่ `permissions` ใน `node.list` / `node.describe` โดยใช้ชื่อสิทธิ์เป็นคีย์(เช่น `screenRecording`, `accessibility`) และค่าเป็นบูลีน(`true` = ได้รับอนุญาต)

## โฮสต์โหนดแบบไม่มีหน้าจอ(ข้ามแพลตฟอร์ม)

OpenClawสามารถรัน**โฮสต์โหนดแบบไม่มีหน้าจอ**(ไม่มีUI)ที่เชื่อมต่อกับGateway
WebSocketและเปิดเผย `system.run` / `system.which`. สิ่งนี้มีประโยชน์บนLinux/Windows
หรือสำหรับรันโหนดแบบมินิมัลควบคู่กับเซิร์ฟเวอร์

เริ่มต้น:

```bash
openclaw node run --host <gateway-host> --port 18789
```

หมายเหตุ:

- ยังคงต้องจับคู่(Gatewayจะแสดงพรอมต์อนุมัติโหนด)
- โฮสต์โหนดจะเก็บnode id โทเคน ชื่อที่แสดง และข้อมูลการเชื่อมต่อgatewayไว้ใน `~/.openclaw/node.json`
- การอนุมัติการรันถูกบังคับใช้ในเครื่องผ่าน `~/.openclaw/exec-approvals.json`
  (ดู [Exec approvals](/tools/exec-approvals))
- บนmacOS โฮสต์โหนดแบบไม่มีหน้าจอจะเลือกใช้โฮสต์รันของแอปคู่หูเมื่อเข้าถึงได้ และจะถอยกลับไปใช้การรันในเครื่องหากแอปไม่พร้อมใช้งาน ตั้งค่า `OPENCLAW_NODE_EXEC_HOST=app` เพื่อบังคับใช้แอป หรือ `OPENCLAW_NODE_EXEC_FALLBACK=0` เพื่อปิดการถอยกลับ 27. ตั้งค่า `OPENCLAW_NODE_EXEC_HOST=app` เพื่อบังคับใช้
  แอป หรือ `OPENCLAW_NODE_EXEC_FALLBACK=0` เพื่อปิดการสำรอง
- เพิ่ม `--tls` / `--tls-fingerprint` เมื่อGateway WSใช้TLS

## โหมดโหนดmac

- แอปเมนูบาร์macOSเชื่อมต่อกับเซิร์ฟเวอร์Gateway WSในฐานะโหนด(ดังนั้น `openclaw nodes …` จึงทำงานกับMacเครื่องนี้ได้)
- ในโหมดรีโมต แอปจะเปิดอุโมงค์SSHสำหรับพอร์ตGatewayและเชื่อมต่อไปยัง `localhost`
