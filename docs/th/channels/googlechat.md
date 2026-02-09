---
summary: "สถานะการรองรับ ความสามารถ และการกำหนดค่าของแอป Google Chat"
read_when:
  - ทำงานเกี่ยวกับฟีเจอร์ช่องทาง Google Chat
title: "Google Chat"
---

# Google Chat (Chat API)

สถานะ: พร้อมใช้งานสำหรับ DMs และ spaces ผ่าน Google Chat API webhooks (เฉพาะ HTTP)

## Quick setup (beginner)

1. สร้างโปรเจกต์ Google Cloud และเปิดใช้งาน **Google Chat API**
   - ไปที่: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - เปิดใช้งาน API หากยังไม่ได้เปิด
2. สร้าง **Service Account**:
   - กด **Create Credentials** > **Service Account**
   - ตั้งชื่ออะไรก็ได้ (เช่น `openclaw-chat`)
   - เว้นสิทธิ์การใช้งานว่างไว้ (กด **Continue**)
   - เว้น principals with access ว่างไว้ (กด **Done**)
3. สร้างและดาวน์โหลด **JSON Key**:
   - ในรายการ service accounts คลิกบัญชีที่เพิ่งสร้าง
   - ไปที่แท็บ **Keys**
   - คลิก **Add Key** > **Create new key**
   - เลือก **JSON** และกด **Create**
4. จัดเก็บไฟล์ JSON ที่ดาวน์โหลดไว้บนโฮสต์Gateway (เช่น `~/.openclaw/googlechat-service-account.json`)
5. สร้างแอป Google Chat ใน [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - กรอก **Application info**:
     - **App name**: (เช่น `OpenClaw`)
     - **Avatar URL**: (เช่น `https://openclaw.ai/logo.png`)
     - **Description**: (เช่น `Personal AI Assistant`)
   - เปิดใช้งาน **Interactive features**
   - ภายใต้ **Functionality** ให้ติ๊ก **Join spaces and group conversations**
   - ภายใต้ **Connection settings** เลือก **HTTP endpoint URL**
   - ภายใต้ **Triggers** เลือก **Use a common HTTP endpoint URL for all triggers** และตั้งค่าเป็น public URL ของ Gateway ต่อท้ายด้วย `/googlechat`
     - _เคล็ดลับ: รัน `openclaw status` เพื่อดู public URL ของ Gateway_
   - ภายใต้ **Visibility** ให้ติ๊ก **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**
   - ใส่อีเมลของคุณ (เช่น `user@example.com`) ในช่องข้อความ
   - คลิก **Save** ที่ด้านล่าง
6. **เปิดใช้งานสถานะแอป**:
   - หลังจากบันทึกแล้ว **รีเฟรชหน้า**
   - มองหาส่วน **App status** (มักอยู่ด้านบนหรือล่างหลังบันทึก)
   - เปลี่ยนสถานะเป็น **Live - available to users**
   - คลิก **Save** อีกครั้ง
7. กำหนดค่า OpenClaw ด้วยพาธ service account + webhook audience:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - หรือคอนฟิก: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`
8. ตั้งค่า webhook audience type + value (ต้องตรงกับคอนฟิกของแอป Chat)
9. เริ่มต้น Gateway 26. Google Chat จะ POST มายังพาธ webhook ของคุณ

## Add to Google Chat

เมื่อ Gateway ทำงานแล้วและอีเมลของคุณถูกเพิ่มในรายการการมองเห็น:

1. ไปที่ [Google Chat](https://chat.google.com/)
2. คลิกไอคอน **+** (บวก) ถัดจาก **Direct Messages**
3. ในแถบค้นหา (ที่ใช้เพิ่มคน) พิมพ์ **App name** ที่คุณตั้งค่าไว้ใน Google Cloud Console
   - **หมายเหตุ**: บอตจะ _ไม่_ ปรากฏในรายการเรียกดู "Marketplace" เนื่องจากเป็นแอปส่วนตัว คุณต้องค้นหาด้วยชื่อเท่านั้น 27. คุณต้องค้นหามันด้วยชื่อ
4. เลือกบอตของคุณจากผลลัพธ์
5. คลิก **Add** หรือ **Chat** เพื่อเริ่มการสนทนาแบบ 1:1
6. ส่ง "Hello" เพื่อกระตุ้นผู้ช่วย!

## Public URL (Webhook-only)

28. webhook ของ Google Chat ต้องการ endpoint HTTPS สาธารณะ Google Chat webhooks ต้องการ HTTPS endpoint แบบสาธารณะ เพื่อความปลอดภัย **ให้เปิดเผยเฉพาะพาธ `/googlechat` เท่านั้น** สู่อินเทอร์เน็ต เก็บแดชบอร์ด OpenClaw และ endpoint ที่อ่อนไหวอื่นๆ ไว้ในเครือข่ายส่วนตัว 29. เก็บแดชบอร์ด OpenClaw และ endpoint ที่มีความอ่อนไหวอื่น ๆ ไว้ในเครือข่ายส่วนตัวของคุณ

### Option A: Tailscale Funnel (Recommended)

ใช้ Tailscale Serve สำหรับแดชบอร์ดแบบส่วนตัว และ Funnel สำหรับพาธ webhook สาธารณะ วิธีนี้จะคง `/` ไว้เป็นส่วนตัว ขณะเดียวกันเปิดเผยเฉพาะ `/googlechat` 30. วิธีนี้จะทำให้ `/` เป็นส่วนตัว ขณะเปิดเผยเฉพาะ `/googlechat`

1. **ตรวจสอบว่า Gateway bind กับที่อยู่อะไร:**

   ```bash
   ss -tlnp | grep 18789
   ```

   จด IP address (เช่น `127.0.0.1`, `0.0.0.0` หรือ Tailscale IP ของคุณอย่าง `100.x.x.x`)

2. **เปิดเผยแดชบอร์ดให้เข้าถึงได้เฉพาะใน tailnet (พอร์ต 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **เปิดเผยเฉพาะพาธ webhook แบบสาธารณะ:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **อนุญาตโหนดสำหรับการเข้าถึง Funnel:**
   หากมีการแจ้งเตือน ให้ไปที่ URL การอนุญาตที่แสดงในเอาต์พุตเพื่อเปิดใช้งาน Funnel สำหรับโหนดนี้ในนโยบาย tailnet ของคุณ

5. **ตรวจสอบการกำหนดค่า:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

URL webhook สาธารณะของคุณจะเป็น:
`https://<node-name>.<tailnet>.ts.net/googlechat`

แดชบอร์ดส่วนตัวของคุณจะคงไว้เฉพาะใน tailnet:
`https://<node-name>.<tailnet>.ts.net:8443/`

ใช้ URL สาธารณะ (ไม่รวม `:8443`) ในคอนฟิกของแอป Google Chat

> 31. หมายเหตุ: การกำหนดค่านี้คงอยู่แม้รีบูต หมายเหตุ: การกำหนดค่านี้คงอยู่แม้รีบูต หากต้องการลบภายหลัง ให้รัน `tailscale funnel reset` และ `tailscale serve reset`

### Option B: Reverse Proxy (Caddy)

หากคุณใช้ reverse proxy อย่าง Caddy ให้ proxy เฉพาะพาธที่กำหนด:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

ด้วยคอนฟิกนี้ คำขอใดๆ ไปยัง `your-domain.com/` จะถูกละเลยหรือส่งกลับเป็น 404 ขณะที่ `your-domain.com/googlechat` จะถูกส่งต่อไปยัง OpenClaw อย่างปลอดภัย

### Option C: Cloudflare Tunnel

กำหนดค่า ingress rules ของ tunnel ให้ route เฉพาะพาธ webhook:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## How it works

1. เริ่ม Gateway โดย Google Chat จะ POST มายังพาธ webhook ของคุณ Google Chat ส่ง webhook POST มายัง Gateway โดยแต่ละคำขอจะมีเฮดเดอร์ `Authorization: Bearer <token>`
2. OpenClaw ตรวจสอบโทเคนกับ `audienceType` + `audience` ที่ตั้งค่าไว้:
   - `audienceType: "app-url"` → audience คือ HTTPS webhook URL ของคุณ
   - `audienceType: "project-number"` → audience คือหมายเลข Cloud project
3. ข้อความจะถูกส่งต่อโดยอิงตาม space:
   - DMs ใช้ session key `agent:<agentId>:googlechat:dm:<spaceId>`
   - Spaces ใช้ session key `agent:<agentId>:googlechat:group:<spaceId>`
4. 32. การเข้าถึง DM เป็นแบบจับคู่ (pairing) ตามค่าเริ่มต้น การเข้าถึง DM เป็นแบบ pairing ตามค่าเริ่มต้น ผู้ส่งที่ไม่รู้จักจะได้รับ pairing code ให้อนุมัติด้วย:
   - `openclaw pairing approve googlechat <code>`
5. 33. พื้นที่กลุ่มต้องมีการ @-mention ตามค่าเริ่มต้น Group spaces ต้องมีการ @-mention ตามค่าเริ่มต้น ใช้ `botUser` หากการตรวจจับ mention ต้องการชื่อผู้ใช้ของแอป

## Targets

ใช้ตัวระบุเหล่านี้สำหรับการส่งมอบและรายการอนุญาต:

- Direct messages: `users/<userId>` หรือ `users/<email>` (ยอมรับที่อยู่อีเมล)
- Spaces: `spaces/<spaceId>`

## Config highlights

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Notes:

- ข้อมูลรับรองของ service account สามารถส่งแบบ inline ได้ด้วย `serviceAccount` (สตริง JSON)
- พาธ webhook ค่าเริ่มต้นคือ `/googlechat` หากไม่ได้ตั้งค่า `webhookPath`
- Reactions ใช้งานได้ผ่านเครื่องมือ `reactions` และ `channels action` เมื่อเปิดใช้งาน `actions.reactions`
- `typingIndicator` รองรับ `none`, `message` (ค่าเริ่มต้น) และ `reaction` (reaction ต้องใช้ user OAuth)
- Attachments จะถูกดาวน์โหลดผ่าน Chat API และจัดเก็บใน media pipeline (จำกัดขนาดโดย `mediaMaxMb`)

## Troubleshooting

### 405 Method Not Allowed

หาก Google Cloud Logs Explorer แสดงข้อผิดพลาดเช่น:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

แสดงว่า webhook handler ยังไม่ได้ถูกลงทะเบียน สาเหตุที่พบบ่อย: 34. สาเหตุที่พบบ่อย:

1. **ยังไม่ได้กำหนดค่าช่องทาง**: ส่วน `channels.googlechat` ขาดหายไปจากคอนฟิก ตรวจสอบด้วย: ตรวจสอบด้วย:

   ```bash
   openclaw config get channels.googlechat
   ```

   หากคืนค่า "Config path not found" ให้เพิ่มการกำหนดค่า (ดู [Config highlights](#config-highlights))

2. **ปลั๊กอินยังไม่เปิดใช้งาน**: ตรวจสอบสถานะปลั๊กอิน:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   หากแสดง "disabled" ให้เพิ่ม `plugins.entries.googlechat.enabled: true` ลงในคอนฟิก

3. **Gateway ยังไม่ได้รีสตาร์ท**: หลังเพิ่มคอนฟิก ให้รีสตาร์ท Gateway:

   ```bash
   openclaw gateway restart
   ```

ตรวจสอบว่าช่องทางกำลังทำงานอยู่:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Other issues

- ตรวจสอบ `openclaw channels status --probe` สำหรับข้อผิดพลาดด้านการยืนยันตัวตนหรือการตั้งค่า audience ที่ขาดหาย
- หากไม่มีข้อความเข้ามา ให้ยืนยัน webhook URL + event subscriptions ของแอป Chat
- หากการบังคับใช้ mention บล็อกการตอบกลับ ให้ตั้งค่า `botUser` เป็น user resource name ของแอป และตรวจสอบ `requireMention`
- ใช้ `openclaw logs --follow` ระหว่างส่งข้อความทดสอบเพื่อดูว่าคำขอถึง Gateway หรือไม่

Related docs:

- [Gateway configuration](/gateway/configuration)
- [Security](/gateway/security)
- [Reactions](/tools/reactions)
