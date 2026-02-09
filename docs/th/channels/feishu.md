---
summary: "ภาพรวมบอตFeishuฟีเจอร์และการกำหนดค่า"
read_when:
  - คุณต้องการเชื่อมต่อบอตFeishu/Lark
  - คุณกำลังกำหนดค่าช่องทางFeishu
title: Feishu
---

# 19. บ็อต Feishu

20. Feishu (Lark) เป็นแพลตฟอร์มแชททีมที่บริษัทต่าง ๆ ใช้สำหรับการสื่อสารและการทำงานร่วมกัน Feishu(Lark)เป็นแพลตฟอร์มแชทสำหรับทีมที่บริษัทใช้สำหรับการส่งข้อความและการทำงานร่วมกันปลั๊กอินนี้เชื่อมต่อOpenClawกับบอตFeishu/Larkโดยใช้การสมัครรับอีเวนต์ผ่านWebSocketของแพลตฟอร์มเพื่อให้สามารถรับข้อความได้โดยไม่ต้องเปิดเผยURLของเว็บฮุคสาธารณะ

---

## ต้องใช้ปลั๊กอิน

ติดตั้งปลั๊กอินFeishu:

```bash
openclaw plugins install @openclaw/feishu
```

เช็คเอาต์ในเครื่อง(เมื่อรันจากgit repo):

```bash
openclaw plugins install ./extensions/feishu
```

---

## เริ่มต้นอย่างรวดเร็ว

มีสองวิธีในการเพิ่มช่องทางFeishu:

### วิธีที่1: ตัวช่วยonboarding(แนะนำ)

หากคุณเพิ่งติดตั้งOpenClawให้รันตัวช่วย:

```bash
openclaw onboard
```

21. วิซาร์ดจะนำทางคุณผ่าน:

1. สร้างแอปFeishuและรวบรวมข้อมูลรับรอง
2. กำหนดค่าข้อมูลรับรองของแอปในOpenClaw
3. เริ่มต้นGateway

✅ **หลังจากกำหนดค่าแล้ว**ตรวจสอบสถานะGateway:

- `openclaw gateway status`
- `openclaw logs --follow`

### วิธีที่2: การตั้งค่าCLI

หากคุณทำการติดตั้งเริ่มต้นเสร็จแล้วให้เพิ่มช่องทางผ่านCLI:

```bash
openclaw channels add
```

เลือก**Feishu**จากนั้นกรอกApp IDและApp Secret

✅ **หลังจากกำหนดค่าแล้ว**จัดการGateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## ขั้นตอนที่1: สร้างแอปFeishu

### 1. เปิดFeishu Open Platform

ไปที่[Feishu Open Platform](https://open.feishu.cn/app)และลงชื่อเข้าใช้

ผู้เช่าLark(ทั่วโลก)ควรใช้[https://open.larksuite.com/app](https://open.larksuite.com/app)และตั้งค่า`domain: "lark"`ในคอนฟิกFeishu

### 2. สร้างแอป

1. คลิก**Create enterprise app**
2. กรอกชื่อแอปและคำอธิบาย
3. เลือกไอคอนแอป

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. คัดลอกข้อมูลรับรอง

จาก**Credentials & Basic Info**คัดลอก:

- **App ID**(รูปแบบ: `cli_xxx`)
- **App Secret**

❗ **สำคัญ:** เก็บApp Secretเป็นความลับ

![Get credentials](../images/feishu-step3-credentials.png)

### 4. กำหนดค่าสิทธิ์

ที่**Permissions**คลิก**Batch import**แล้ววาง:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. เปิดใช้งานความสามารถบอต

ใน**App Capability** > **Bot**:

1. เปิดใช้งานความสามารถบอต
2. ตั้งชื่อบอต

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. กำหนดค่าการสมัครรับอีเวนต์

⚠️ **สำคัญ:** ก่อนตั้งค่าการสมัครรับอีเวนต์ตรวจสอบให้แน่ใจว่า:

1. คุณได้รัน`openclaw channels add`สำหรับFeishuแล้ว
2. Gatewayกำลังทำงาน(`openclaw gateway status`)

ใน**Event Subscription**:

1. เลือก**Use long connection to receive events**(WebSocket)
2. เพิ่มอีเวนต์: `im.message.receive_v1`

⚠️ หากGatewayไม่ทำงานการตั้งค่าการเชื่อมต่อแบบยาวอาจบันทึกไม่สำเร็จ

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. เผยแพร่แอป

1. สร้างเวอร์ชันใน**Version Management & Release**
2. ส่งตรวจสอบและเผยแพร่
3. รอการอนุมัติจากแอดมิน(แอปองค์กรโดยทั่วไปจะอนุมัติอัตโนมัติ)

---

## ขั้นตอนที่2: กำหนดค่าOpenClaw

### กำหนดค่าด้วยตัวช่วย(แนะนำ)

```bash
openclaw channels add
```

เลือก**Feishu**และวางApp IDกับApp Secretของคุณ

### กำหนดค่าผ่านไฟล์คอนฟิก

แก้ไข`~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### กำหนดค่าผ่านตัวแปรสภาพแวดล้อม

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### โดเมนLark(ทั่วโลก)

หากผู้เช่าของคุณอยู่บนLark(นานาชาติ)ให้ตั้งค่าโดเมนเป็น`lark`(หรือสตริงโดเมนแบบเต็ม)คุณสามารถตั้งค่าได้ที่`channels.feishu.domain`หรือรายบัญชี(`channels.feishu.accounts.<id> 22. คุณสามารถตั้งค่าได้ที่ `channels.feishu.domain` หรือรายบัญชี (`channels.feishu.accounts.<id>`.domain`)

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## ขั้นตอนที่3: เริ่มต้นและทดสอบ

### 1. เริ่มGateway

```bash
openclaw gateway
```

### 2. ส่งข้อความทดสอบ

ในFeishuค้นหาบอตของคุณและส่งข้อความ

### 3. อนุมัติการจับคู่

ตามค่าเริ่มต้นบอตจะตอบกลับด้วยโค้ดการจับคู่ให้อนุมัติ: 23. อนุมัติ:

```bash
openclaw pairing approve feishu <CODE>
```

หลังจากอนุมัติแล้วคุณสามารถสนทนาได้ตามปกติ

---

## ภาพรวม

- **ช่องทางบอตFeishu**: บอตFeishuที่จัดการโดยGateway
- **การกำหนดเส้นทางแบบกำหนดแน่นอน**: การตอบกลับจะกลับไปที่Feishuเสมอ
- **การแยกเซสชัน**: DMใช้เซสชันหลักร่วมกันกลุ่มจะถูกแยก
- **การเชื่อมต่อWebSocket**: การเชื่อมต่อแบบยาวผ่านFeishu SDKไม่ต้องใช้URLสาธารณะ

---

## การควบคุมการเข้าถึง

### Direct messages

- **ค่าเริ่มต้น**: `dmPolicy: "pairing"`(ผู้ใช้ที่ไม่รู้จักจะได้รับโค้ดการจับคู่)

- **อนุมัติการจับคู่**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **โหมดรายการอนุญาต**: ตั้งค่า`channels.feishu.allowFrom`ด้วยOpen IDที่อนุญาต

### แชทกลุ่ม

**1. นโยบายกลุ่ม**(`channels.feishu.groupPolicy`):

- `"open"` = อนุญาตทุกคนในกลุ่ม(ค่าเริ่มต้น)
- `"allowlist"` = อนุญาตเฉพาะ`groupAllowFrom`
- `"disabled"` = ปิดการรับข้อความกลุ่ม

**2. ข้อกำหนดการกล่าวถึง**(`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = ต้องมี@mention(ค่าเริ่มต้น)
- `false` = ตอบโดยไม่ต้องกล่าวถึง

---

## ตัวอย่างการกำหนดค่ากลุ่ม

### อนุญาตทุกกลุ่มต้องมี@mention(ค่าเริ่มต้น)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### อนุญาตทุกกลุ่มไม่ต้องมี@mention

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### อนุญาตเฉพาะผู้ใช้ที่ระบุในกลุ่มเท่านั้น

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## รับIDของกลุ่ม/ผู้ใช้

### IDกลุ่ม(chat_id)

IDกลุ่มมีลักษณะเช่น`oc_xxx`.

**วิธีที่1(แนะนำ)**

1. เริ่มGatewayและ@mentionบอตในกลุ่ม
2. รัน`openclaw logs --follow`และมองหา`chat_id`

**วิธีที่2**

ใช้Feishu API debuggerเพื่อแสดงรายการแชทกลุ่ม

### IDผู้ใช้(open_id)

IDผู้ใช้มีลักษณะเช่น`ou_xxx`.

**วิธีที่1(แนะนำ)**

1. เริ่มGatewayและส่งDMหาบอต
2. รัน`openclaw logs --follow`และมองหา`open_id`

**วิธีที่2**

ตรวจสอบคำขอการจับคู่เพื่อดูOpen IDของผู้ใช้:

```bash
openclaw pairing list feishu
```

---

## คำสั่งที่ใช้บ่อย

| คำสั่ง    | คำอธิบาย       |
| --------- | -------------- |
| `/status` | แสดงสถานะบอต   |
| `/reset`  | รีเซ็ตเซสชัน   |
| `/model`  | แสดง/สลับโมเดล |

> หมายเหตุ: Feishuยังไม่รองรับเมนูคำสั่งแบบเนทีฟดังนั้นต้องส่งคำสั่งเป็นข้อความ

## คำสั่งจัดการGateway

| คำสั่ง                     | คำอธิบาย                                                                   |
| -------------------------- | -------------------------------------------------------------------------- |
| `openclaw gateway status`  | แสดงสถานะGateway                                                           |
| `openclaw gateway install` | ติดตั้ง/เริ่มบริการGateway                                                 |
| `openclaw gateway stop`    | หยุดบริการGateway                                                          |
| `openclaw gateway restart` | รีสตาร์ตบริการGateway                                                      |
| `openclaw logs --follow`   | 24. ติดตาม (tail) ล็อกของเกตเวย์ |

---

## การแก้ไขปัญหา

### บอตไม่ตอบในแชทกลุ่ม

1. ตรวจสอบให้แน่ใจว่าได้เพิ่มบอตเข้ากลุ่มแล้ว
2. ตรวจสอบว่าคุณได้@mentionบอต(พฤติกรรมค่าเริ่มต้น)
3. ตรวจสอบว่า`groupPolicy`ไม่ได้ตั้งค่าเป็น`"disabled"`
4. ตรวจสอบล็อก: `openclaw logs --follow`

### บอตไม่ได้รับข้อความ

1. ตรวจสอบว่าแอปถูกเผยแพร่และอนุมัติแล้ว
2. ตรวจสอบว่าการสมัครรับอีเวนต์มี`im.message.receive_v1`
3. ตรวจสอบว่าเปิดใช้**long connection**
4. ตรวจสอบว่าสิทธิ์แอปครบถ้วน
5. ตรวจสอบว่าGatewayกำลังทำงาน: `openclaw gateway status`
6. ตรวจสอบล็อก: `openclaw logs --follow`

### App Secretรั่วไหล

1. รีเซ็ตApp SecretในFeishu Open Platform
2. อัปเดตApp Secretในคอนฟิกของคุณ
3. รีสตาร์ตGateway

### การส่งข้อความล้มเหลว

1. ตรวจสอบว่าแอปมีสิทธิ์`im:message:send_as_bot`
2. ตรวจสอบว่าแอปถูกเผยแพร่แล้ว
3. ตรวจสอบล็อกเพื่อดูข้อผิดพลาดโดยละเอียด

---

## การกำหนดค่าขั้นสูง

### หลายบัญชี

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### ขีดจำกัดข้อความ

- `textChunkLimit`: ขนาดชิ้นข้อความขาออก(ค่าเริ่มต้น:2000อักขระ)
- `mediaMaxMb`: ขีดจำกัดการอัปโหลด/ดาวน์โหลดสื่อ(ค่าเริ่มต้น:30MB)

### สตรีมมิง

Feishuรองรับการตอบกลับแบบสตรีมผ่านการ์ดแบบโต้ตอบเมื่อเปิดใช้งานบอตจะอัปเดตการ์ดระหว่างสร้างข้อความ 25. เมื่อเปิดใช้งาน บ็อตจะอัปเดตการ์ดขณะสร้างข้อความ

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

ตั้งค่า`streaming: false`เพื่อรอให้ได้คำตอบครบก่อนส่ง

### การกำหนดเส้นทางหลายเอเจนต์

ใช้`bindings`เพื่อกำหนดเส้นทางDMหรือกลุ่มของFeishuไปยังเอเจนต์ต่างๆ

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

ฟิลด์การกำหนดเส้นทาง:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"`หรือ`"group"`
- `match.peer.id`: Open IDผู้ใช้(`ou_xxx`)หรือIDกลุ่ม(`oc_xxx`)

ดู[รับIDของกลุ่ม/ผู้ใช้](#get-groupuser-ids)สำหรับเคล็ดลับการค้นหา

---

## อ้างอิงการกำหนดค่า

การกำหนดค่าเต็มรูปแบบ: [Gateway configuration](/gateway/configuration)

ตัวเลือกหลัก:

| การตั้งค่า                                        | คำอธิบาย                                                        | ค่าเริ่มต้น |
| ------------------------------------------------- | --------------------------------------------------------------- | ----------- |
| `channels.feishu.enabled`                         | เปิด/ปิดช่องทาง                                                 | `true`      |
| `channels.feishu.domain`                          | โดเมนAPI(`feishu`หรือ`lark`)                 | `feishu`    |
| `channels.feishu.accounts.<id>.appId`             | App ID                                                          | -           |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                                                      | -           |
| `channels.feishu.accounts.<id>.domain`            | การแทนที่โดเมนAPIต่อบัญชี                                       | `feishu`    |
| `channels.feishu.dmPolicy`                        | นโยบายDM                                                        | `pairing`   |
| `channels.feishu.allowFrom`                       | รายการอนุญาตDM(open_id) | -           |
| `channels.feishu.groupPolicy`                     | นโยบายกลุ่ม                                                     | `open`      |
| `channels.feishu.groupAllowFrom`                  | รายการอนุญาตกลุ่ม                                               | -           |
| `channels.feishu.groups.<chat_id>.requireMention` | ต้องมี@mention                                     | `true`      |
| `channels.feishu.groups.<chat_id>.enabled`        | เปิดใช้งานกลุ่ม                                                 | `true`      |
| `channels.feishu.textChunkLimit`                  | ขนาดชิ้นข้อความ                                                 | `2000`      |
| `channels.feishu.mediaMaxMb`                      | ขีดจำกัดขนาดสื่อ                                                | `30`        |
| `channels.feishu.streaming`                       | เปิดใช้งานเอาต์พุตการ์ดสตรีมมิง                                 | `true`      |
| `channels.feishu.blockStreaming`                  | เปิดใช้งานblock streaming                                       | `true`      |

---

## อ้างอิงdmPolicy

| ค่า           | พฤติกรรม                                                                      |
| ------------- | ----------------------------------------------------------------------------- |
| `"pairing"`   | **ค่าเริ่มต้น**ผู้ใช้ที่ไม่รู้จักจะได้รับโค้ดการจับคู่และต้องได้รับการอนุมัติ |
| `"allowlist"` | เฉพาะผู้ใช้ใน`allowFrom`เท่านั้นที่สามารถแชทได้                               |
| `"open"`      | อนุญาตผู้ใช้ทั้งหมด(ต้องมี`"*"`ในallowFrom)                |
| `"disabled"`  | ปิดDM                                                                         |

---

## ประเภทข้อความที่รองรับ

### รับ

- ✅ ข้อความ
- ✅ ข้อความสมบูรณ์(Rich text/post)
- ✅ รูปภาพ
- ✅ ไฟล์
- ✅ เสียง
- ✅ วิดีโอ
- ✅ สติกเกอร์

### ส่ง

- ✅ ข้อความ
- ✅ รูปภาพ
- ✅ ไฟล์
- ✅ เสียง
- ⚠️ ข้อความสมบูรณ์(รองรับบางส่วน)
