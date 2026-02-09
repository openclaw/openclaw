---
summary: "รันOpenClawในmacOS VMแบบsandbox(ภายในเครื่องหรือโฮสต์)เมื่อคุณต้องการการแยกสภาพแวดล้อมหรือiMessage"
read_when:
  - คุณต้องการแยกOpenClawออกจากสภาพแวดล้อมmacOSหลักของคุณ
  - คุณต้องการการเชื่อมต่อiMessage(BlueBubbles)ภายในsandbox
  - คุณต้องการสภาพแวดล้อมmacOSที่รีเซ็ตได้และสามารถโคลนได้
  - คุณต้องการเปรียบเทียบตัวเลือกmacOS VMแบบภายในเครื่องกับแบบโฮสต์
title: "macOS VMs"
---

# OpenClawบนmacOS VMs(Sandboxing)

## ค่าเริ่มต้นที่แนะนำ(ผู้ใช้ส่วนใหญ่)

- **Linux VPSขนาดเล็ก** สำหรับGatewayที่ทำงานตลอดเวลาและต้นทุนต่ำ ดูที่ [VPS hosting](/vps) ดู [VPS hosting](/vps)
- **ฮาร์ดแวร์เฉพาะ** (Mac miniหรือกล่องLinux) หากคุณต้องการการควบคุมเต็มรูปแบบและ **IPที่อยู่อาศัย** สำหรับการทำงานอัตโนมัติผ่านเบราว์เซอร์ หลายเว็บไซต์บล็อกIPของดาต้าเซ็นเตอร์ ดังนั้นการท่องเว็บจากเครื่องในพื้นที่มักได้ผลดีกว่า หลายเว็บไซต์บล็อก IP ของดาต้าเซ็นเตอร์ ดังนั้นการท่องเว็บจากเครื่องโลคัลมักจะได้ผลดีกว่า
- **ไฮบริด:** เก็บGatewayไว้บนVPSราคาถูก และเชื่อมต่อMacของคุณเป็น **โหนด** เมื่อคุณต้องการการทำงานอัตโนมัติของเบราว์เซอร์/UI ดู [Nodes](/nodes) และ [Gateway remote](/gateway/remote) ดู [Nodes](/nodes) และ [Gateway remote](/gateway/remote)

ใช้macOS VMเมื่อคุณต้องการความสามารถเฉพาะของmacOS(iMessage/BlueBubbles)หรืออยากได้การแยกสภาพแวดล้อมอย่างเข้มงวดจากMacที่ใช้ประจำวันของคุณ

## ตัวเลือกmacOS VM

### VMภายในเครื่องบนApple Silicon Macของคุณ(Lume)

รันOpenClawในmacOS VMแบบsandboxบนApple Silicon Macที่คุณมีอยู่ โดยใช้ [Lume](https://cua.ai/docs/lume)

สิ่งที่คุณจะได้รับ:

- สภาพแวดล้อมmacOSเต็มรูปแบบที่แยกจากกัน(โฮสต์ของคุณยังคงสะอาด)
- รองรับiMessageผ่านBlueBubbles(เป็นไปไม่ได้บนLinux/Windows)
- รีเซ็ตได้ทันทีด้วยการโคลนVM
- ไม่ต้องมีฮาร์ดแวร์เพิ่มเติมหรือค่าใช้จ่ายคลาวด์

### ผู้ให้บริการMacแบบโฮสต์(คลาวด์)

หากคุณต้องการmacOSบนคลาวด์ ผู้ให้บริการMacแบบโฮสต์ก็ใช้งานได้เช่นกัน:

- [MacStadium](https://www.macstadium.com/) (Macแบบโฮสต์)
- ผู้ให้บริการMacแบบโฮสต์รายอื่นก็ใช้ได้เช่นกัน ให้ทำตามเอกสารVM+SSHของผู้ให้บริการนั้น

เมื่อคุณมีการเข้าถึงmacOS VMผ่านSSHแล้ว ให้ไปต่อที่ขั้นตอนที่6ด้านล่าง

---

## เส้นทางด่วน(Lume,ผู้ใช้ที่มีประสบการณ์)

1. ติดตั้งLume
2. `lume create openclaw --os macos --ipsw latest`
3. ทำSetup Assistantให้เสร็จ เปิดใช้งานRemote Login(SSH)
4. `lume run openclaw --no-display`
5. SSHเข้าไป ติดตั้งOpenClaw ตั้งค่าช่องทาง
6. เสร็จสิ้น

---

## สิ่งที่ต้องมี(Lume)

- Apple Silicon Mac(M1/M2/M3/M4)
- macOS Sequoiaหรือใหม่กว่าบนโฮสต์
- พื้นที่ดิสก์ว่างประมาณ~60GBต่อVM
- เวลาประมาณ~20นาที

---

## 1. ติดตั้งLume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

หาก `~/.local/bin` ไม่อยู่ในPATHของคุณ:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

ตรวจสอบ:

```bash
lume --version
```

เอกสาร: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. สร้างmacOS VM

```bash
lume create openclaw --os macos --ipsw latest
```

ขั้นตอนนี้จะดาวน์โหลดmacOSและสร้างVM หน้าต่างVNCจะเปิดขึ้นโดยอัตโนมัติ หน้าต่าง VNC จะเปิดขึ้นโดยอัตโนมัติ

หมายเหตุ: การดาวน์โหลดอาจใช้เวลาสักครู่ขึ้นอยู่กับการเชื่อมต่อของคุณ

---

## 3. ทำSetup Assistantให้เสร็จ

ในหน้าต่างVNC:

1. เลือกภาษาและภูมิภาค
2. ข้ามApple ID(หรือเข้าสู่ระบบหากคุณต้องการiMessageในภายหลัง)
3. สร้างบัญชีผู้ใช้(จดจำชื่อผู้ใช้และรหัสผ่าน)
4. ข้ามฟีเจอร์เสริมทั้งหมด

หลังจากการตั้งค่าเสร็จสิ้น ให้เปิดใช้งานSSH:

1. เปิดSystem Settings → General → Sharing
2. เปิดใช้งาน "Remote Login"

---

## 4. รับที่อยู่IPของVM

```bash
lume get openclaw
```

มองหาที่อยู่IP(โดยปกติคือ `192.168.64.x`)

---

## 5. SSHเข้าไปยังVM

```bash
ssh youruser@192.168.64.X
```

แทนที่ `youruser` ด้วยบัญชีที่คุณสร้างไว้ และแทนที่IPด้วยIPของVMของคุณ

---

## 6. ติดตั้งOpenClaw

ภายในVM:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

ทำตามพรอมป์ตการเริ่มต้นใช้งานเพื่อตั้งค่าผู้ให้บริการโมเดลของคุณ(Anthropic, OpenAI เป็นต้น)

---

## 7. ตั้งค่าช่องทาง

แก้ไขไฟล์คอนฟิก:

```bash
nano ~/.openclaw/openclaw.json
```

เพิ่มช่องทางของคุณ:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

จากนั้นเข้าสู่ระบบWhatsApp(สแกนQR):

```bash
openclaw channels login
```

---

## 8. รันVMแบบไม่แสดงผล

หยุดVMแล้วเริ่มใหม่โดยไม่แสดงหน้าจอ:

```bash
lume stop openclaw
lume run openclaw --no-display
```

VM ทำงานอยู่เบื้องหลัง VMจะทำงานอยู่เบื้องหลัง เดมอนของOpenClawจะทำให้Gatewayทำงานต่อเนื่อง

ตรวจสอบสถานะ:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## โบนัส: การเชื่อมต่อiMessage

นี่คือฟีเจอร์เด็ดของการรันบน macOS นี่คือฟีเจอร์เด่นของการรันบนmacOS ใช้ [BlueBubbles](https://bluebubbles.app) เพื่อเพิ่มiMessageให้กับOpenClaw

ภายในVM:

1. ดาวน์โหลดBlueBubblesจากbluebubbles.app
2. ลงชื่อเข้าใช้ด้วยApple IDของคุณ
3. เปิดใช้งานWeb APIและตั้งรหัสผ่าน
4. ชี้webhooksของBlueBubblesไปยังGatewayของคุณ(ตัวอย่าง: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

เพิ่มลงในคอนฟิกของOpenClaw:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

รีสตาร์ทGateway（เกตเวย์） รีสตาร์ทGateway ตอนนี้เอเจนต์ของคุณสามารถส่งและรับiMessagesได้แล้ว

รายละเอียดการตั้งค่าแบบเต็ม: [BlueBubbles channel](/channels/bluebubbles)

---

## บันทึกgolden image

ก่อนปรับแต่งเพิ่มเติม ให้สแนปช็อตสถานะที่สะอาดของคุณ:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

รีเซ็ตได้ทุกเมื่อ:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## การรันตลอด24/7

ทำให้VMทำงานต่อเนื่องโดย:

- เสียบปลั๊กMacไว้ตลอด
- ปิดโหมดสลีปในSystem Settings → Energy Saver
- ใช้ `caffeinate` หากจำเป็น

สำหรับการทำงานตลอดเวลาจริงๆ พิจารณาใช้Mac miniเฉพาะหรือVPSขนาดเล็ก ดู [VPS hosting](/vps) ดู [VPS hosting](/vps)

---

## การแก้ไขปัญหา

| ปัญหา                   | วิธีแก้ไข                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| ไม่สามารถSSHเข้าVMได้   | ตรวจสอบว่าเปิดใช้งาน "Remote Login" ในSystem SettingsของVMแล้ว                                         |
| ไม่แสดงIPของVM          | รอให้VMบูตเสร็จสมบูรณ์ แล้วรัน `lume get openclaw` อีกครั้ง                                            |
| ไม่พบคำสั่งLume         | เพิ่ม `~/.local/bin` ลงในPATHของคุณ                                                                    |
| สแกนQRของWhatsAppไม่ได้ | ตรวจสอบให้แน่ใจว่าคุณเข้าสู่ระบบในVM(ไม่ใช่โฮสต์)เมื่อรัน `openclaw channels login` |

---

## เอกสารที่เกี่ยวข้อง

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (ขั้นสูง)
- [Docker Sandboxing](/install/docker) (แนวทางการแยกสภาพแวดล้อมทางเลือก)
