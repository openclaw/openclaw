---
summary: "โฟลว์ของแอปmacOSสำหรับควบคุมOpenClaw Gatewayระยะไกลผ่านSSH"
read_when:
  - เมื่อกำลังตั้งค่าหรือแก้ไขปัญหาการควบคุมmacระยะไกล
title: "การควบคุมระยะไกล"
---

# Remote OpenClaw (macOS ⇄ โฮสต์ระยะไกล)

โฟลว์นี้ช่วยให้แอปmacOSทำหน้าที่เป็นรีโมตคอนโทรลเต็มรูปแบบสำหรับOpenClaw Gateway（เกตเวย์）ที่รันอยู่บนโฮสต์อื่น(เดสก์ท็อป/เซิร์ฟเวอร์) นี่คือฟีเจอร์ **Remote over SSH** (remote run) ของแอป ฟีเจอร์ทั้งหมด—การตรวจสุขภาพ, การส่งต่อ Voice Wake และ Web Chat—จะใช้คอนฟิกSSHระยะไกลชุดเดียวกันจาก _Settings → General_ 37. นี่คือฟีเจอร์ **Remote over SSH** (รันระยะไกล) ของแอป 38. ทุกฟีเจอร์—การตรวจสุขภาพ, การส่งต่อ Voice Wake และ Web Chat—ใช้การตั้งค่า SSH ระยะไกลเดียวกันจาก _Settings → General_

## Modes

- **Local (this Mac)**: ทุกอย่างรันบนแล็ปท็อป ไม่เกี่ยวข้องกับSSH 39. ไม่มี SSH เกี่ยวข้อง
- **Remote over SSH (default)**: คำสั่งOpenClawถูกรันบนโฮสต์ระยะไกล แอปmacจะเปิดการเชื่อมต่อSSHด้วย `-o BatchMode` พร้อมตัวตน/คีย์ที่คุณเลือกและการทำพอร์ตฟอร์เวิร์ดภายในเครื่อง 40. แอป mac จะเปิดการเชื่อมต่อ SSH ด้วย `-o BatchMode` พร้อม identity/key ที่คุณเลือก และการพอร์ตฟอร์เวิร์ดภายในเครื่อง
- 41. **Remote direct (ws/wss)**: ไม่มี SSH tunnel **Remote direct (ws/wss)**: ไม่มีอุโมงค์SSH แอปmacเชื่อมต่อกับURLของGatewayโดยตรง(เช่น ผ่านTailscale Serve หรือรีเวิร์สพร็อกซีHTTPSสาธารณะ)

## Remote transports

โหมดระยะไกลรองรับทรานสปอร์ตสองแบบ:

- **SSH tunnel** (ค่าเริ่มต้น): ใช้ `ssh -N -L ...` เพื่อฟอร์เวิร์ดพอร์ตของGatewayมายังlocalhost Gatewayจะเห็นIPของโหนดเป็น `127.0.0.1` เนื่องจากอุโมงค์เป็นแบบloopback 42. เกตเวย์จะเห็น IP ของโหนดเป็น `127.0.0.1` เนื่องจากท่อสื่อสารเป็น loopback
- **Direct (ws/wss)**: เชื่อมต่อไปยังURLของGatewayโดยตรง Gatewayจะเห็นIPไคลเอนต์จริง 43. เกตเวย์จะเห็น IP จริงของไคลเอนต์

## Prereqs on the remote host

1. ติดตั้งNode + pnpm และสร้าง/ติดตั้งOpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`)
2. ตรวจสอบให้แน่ใจว่า `openclaw` อยู่บนPATHสำหรับเชลล์ที่ไม่โต้ตอบ(ทำsymlinkไปยัง `/usr/local/bin` หรือ `/opt/homebrew/bin` หากจำเป็น)
3. 44. เปิด SSH ด้วยการยืนยันตัวตนด้วยคีย์ เปิดSSHด้วยการยืนยันตัวตนแบบคีย์ แนะนำให้ใช้IPของ **Tailscale** เพื่อการเข้าถึงที่เสถียรนอกLAN

## macOS app setup

1. เปิด _Settings → General_
2. ใต้ **OpenClaw runs** เลือก **Remote over SSH** และตั้งค่า:
   - **Transport**: **SSH tunnel** หรือ **Direct (ws/wss)**
   - **SSH target**: `user@host` (ไม่บังคับ `:port`)
     - หากGatewayอยู่ในLANเดียวกันและประกาศผ่านBonjour ให้เลือกจากรายการที่ค้นพบเพื่อกรอกช่องนี้อัตโนมัติ
   - **Gateway URL** (เฉพาะDirect): `wss://gateway.example.ts.net` (หรือ `ws://...` สำหรับlocal/LAN)
   - **Identity file** (ขั้นสูง): พาธไปยังคีย์ของคุณ
   - **Project root** (ขั้นสูง): พาธเช็กเอาต์บนรีโมตที่ใช้สำหรับคำสั่ง
   - **CLI path** (ขั้นสูง): พาธเสริมไปยังเอนทรีพอยต์/ไบนารี `openclaw` ที่รันได้(จะกรอกอัตโนมัติเมื่อมีการประกาศ)
3. 45. คลิก **Test remote** 46. ความสำเร็จหมายความว่า `openclaw status --json` บนรีโมตรันได้ถูกต้อง กด **Test remote** หากสำเร็จแสดงว่า `openclaw status --json` ระยะไกลทำงานถูกต้อง ความล้มเหลวมักเกิดจากปัญหาPATH/CLI; exit 127 หมายถึงไม่พบCLIบนรีโมต
4. การตรวจสุขภาพและ Web Chat จะรันผ่านอุโมงค์SSHนี้โดยอัตโนมัติ

## Web Chat

- **SSH tunnel**: Web Chat เชื่อมต่อกับGatewayผ่านพอร์ตควบคุมWebSocketที่ถูกฟอร์เวิร์ด(ค่าเริ่มต้น 18789)
- **Direct (ws/wss)**: Web Chat เชื่อมต่อไปยังURLของGatewayที่ตั้งค่าไว้โดยตรง
- ไม่มีเซิร์ฟเวอร์HTTPสำหรับWebChatแยกต่างหากอีกต่อไป

## Permissions

- โฮสต์ระยะไกลต้องการการอนุมัติTCCแบบเดียวกับภายในเครื่อง(Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications) ให้รันการเริ่มต้นใช้งานบนเครื่องนั้นเพื่ออนุญาตครั้งเดียว 47. รัน onboarding บนเครื่องนั้นเพื่อให้สิทธิ์เพียงครั้งเดียว
- โหนดจะประกาศสถานะสิทธิ์ผ่าน `node.list` / `node.describe` เพื่อให้เอเจนต์ทราบว่าสามารถใช้งานอะไรได้บ้าง

## Security notes

- แนะนำให้ bind แบบloopbackบนโฮสต์ระยะไกลและเชื่อมต่อผ่านSSHหรือTailscale
- หากคุณ bind Gatewayไปยังอินเทอร์เฟซที่ไม่ใช่loopback ให้บังคับใช้การยืนยันตัวตนด้วยโทเคน/รหัสผ่าน
- ดู [Security](/gateway/security) และ [Tailscale](/gateway/tailscale)

## WhatsApp login flow (remote)

- รัน `openclaw channels login --verbose` **บนโฮสต์ระยะไกล** สแกนQRด้วยWhatsAppบนโทรศัพท์ของคุณ 48. สแกน QR ด้วย WhatsApp บนโทรศัพท์ของคุณ
- รันการล็อกอินใหม่บนโฮสต์นั้นหากการยืนยันตัวตนหมดอายุ การตรวจสุขภาพจะแสดงปัญหาการเชื่อมต่อ 49. การตรวจสุขภาพจะแสดงปัญหาการเชื่อมต่อ

## Troubleshooting

- 50. **exit 127 / not found**: `openclaw` ไม่อยู่ใน PATH สำหรับเชลล์ที่ไม่ใช่เชลล์ล็อกอิน **exit 127 / not found**: `openclaw` ไม่อยู่บนPATHสำหรับเชลล์ที่ไม่ใช่การล็อกอิน เพิ่มไปยัง `/etc/paths`, shell rc ของคุณ หรือทำsymlinkไปยัง `/usr/local/bin`/`/opt/homebrew/bin`
- **Health probe failed**: ตรวจสอบการเข้าถึงSSH, PATH และตรวจว่าBaileysได้ล็อกอินแล้ว (`openclaw status --json`)
- **Web Chat stuck**: ยืนยันว่าGatewayกำลังรันอยู่บนโฮสต์ระยะไกลและพอร์ตที่ฟอร์เวิร์ดตรงกับพอร์ตWSของGateway; UIต้องการการเชื่อมต่อWSที่สมบูรณ์
- **Node IP แสดงเป็น 127.0.0.1**: เป็นสิ่งที่คาดไว้เมื่อใช้ SSH tunnel **Node IP shows 127.0.0.1**: เป็นพฤติกรรมที่คาดไว้เมื่อใช้อุโมงค์SSH เปลี่ยน **Transport** เป็น **Direct (ws/wss)** หากต้องการให้Gatewayเห็นIPไคลเอนต์จริง
- **Voice Wake**: วลีทริกเกอร์จะถูกส่งต่ออัตโนมัติในโหมดระยะไกล ไม่ต้องมีตัวส่งต่อแยกต่างหาก

## Notification sounds

เลือกเสียงต่อการแจ้งเตือนจากสคริปต์ด้วย `openclaw` และ `node.invoke` ตัวอย่างเช่น:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

ขณะนี้ไม่มีสวิตช์ “default sound” แบบรวมในแอปอีกต่อไป ผู้เรียกจะเลือกเสียง(หรือไม่เลือกเสียง)เป็นรายคำขอ
