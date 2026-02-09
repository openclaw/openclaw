---
summary: "สถานะการรองรับ ความสามารถ และการกำหนดค่าบอต Microsoft Teams"
read_when:
  - ทำงานกับฟีเจอร์ช่องทาง MS Teams
title: "Microsoft Teams"
---

# Microsoft Teams (ปลั๊กอิน)

> "จงละทิ้งความหวังทั้งปวง ผู้ที่ก้าวเข้ามาที่นี่"

อัปเดต: 2026-01-21

สถานะ: รองรับข้อความและไฟล์แนบใน DM; การส่งไฟล์ในช่องทาง/กลุ่มต้องใช้ `sharePointSiteId` + สิทธิ์ Graph (ดู [การส่งไฟล์ในแชทกลุ่ม](#sending-files-in-group-chats)). โพลถูกส่งผ่าน Adaptive Cards

## ต้องใช้ปลั๊กอิน

Microsoft Teams มาในรูปแบบปลั๊กอินและไม่ได้รวมมากับการติดตั้งแกนหลัก

**การเปลี่ยนแปลงที่ทำให้ไม่เข้ากัน (2026.1.15):** MS Teams ถูกแยกออกจาก core หากคุณใช้งาน ต้องติดตั้งปลั๊กอิน หากคุณใช้งาน ต้องติดตั้งปลั๊กอิน

เหตุผล: ทำให้การติดตั้ง core เบาลง และให้ไลบรารีของ MS Teams อัปเดตได้อย่างอิสระ

ติดตั้งผ่าน CLI (npm registry):

```bash
openclaw plugins install @openclaw/msteams
```

เช็กเอาต์ในเครื่อง (เมื่อรันจาก git repo):

```bash
openclaw plugins install ./extensions/msteams
```

หากคุณเลือก Teams ระหว่างการตั้งค่า/ออนบอร์ด และตรวจพบ git checkout,
OpenClaw จะเสนอพาธติดตั้งในเครื่องให้อัตโนมัติ

รายละเอียด: [Plugins](/tools/plugin)

## ตั้งค่าอย่างรวดเร็ว(ผู้เริ่มต้น)

1. ติดตั้งปลั๊กอิน Microsoft Teams
2. สร้าง **Azure Bot** (App ID + client secret + tenant ID)
3. กำหนดค่า OpenClaw ด้วยข้อมูลรับรองดังกล่าว
4. เปิดเผย `/api/messages` (พอร์ต 3978 เป็นค่าเริ่มต้น) ผ่าน URL สาธารณะหรือท่อ (tunnel)
5. ติดตั้งแพ็กเกจแอป Teams และเริ่ม Gateway

คอนฟิกขั้นต่ำ:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

หมายเหตุ: แชทกลุ่มถูกบล็อกเป็นค่าเริ่มต้น (`channels.msteams.groupPolicy: "allowlist"`). หากต้องการอนุญาตการตอบในกลุ่ม ให้ตั้งค่า `channels.msteams.groupAllowFrom` (หรือใช้ `groupPolicy: "open"` เพื่ออนุญาตสมาชิกทุกคน โดยยังคงต้องกล่าวถึง)

## เป้าหมาย

- สนทนากับ OpenClaw ผ่าน DM, แชทกลุ่ม หรือช่องทางของ Teams
- คงเส้นทางให้กำหนดแน่นอน: การตอบกลับจะกลับไปยังช่องทางที่เข้ามาเสมอ
- ค่าเริ่มต้นเป็นพฤติกรรมที่ปลอดภัยของช่องทาง (ต้อง @mention เว้นแต่กำหนดไว้เป็นอย่างอื่น)

## การเขียนคอนฟิก

โดยค่าเริ่มต้น Microsoft Teams ได้รับอนุญาตให้เขียนอัปเดตคอนฟิกที่ถูกทริกเกอร์โดย `/config set|unset` (ต้องใช้ `commands.config: true`)

ปิดใช้งานด้วย:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## การควบคุมการเข้าถึง(DMs+กลุ่ม)

**การเข้าถึง DM**

- ค่าเริ่มต้น: `channels.msteams.dmPolicy = "pairing"`. ผู้ส่งที่ไม่รู้จักจะถูกเพิกเฉยจนกว่าจะอนุมัติ
- `channels.msteams.allowFrom` รองรับ AAD object IDs, UPNs หรือชื่อที่แสดง ตัวช่วย (wizard) จะแปลงชื่อเป็น ID ผ่าน Microsoft Graph เมื่อมีสิทธิ์การเข้าถึง

**การเข้าถึงกลุ่ม**

- ค่าเริ่มต้น: `channels.msteams.groupPolicy = "allowlist"` (บล็อก เว้นแต่คุณเพิ่ม `groupAllowFrom`). ใช้ `channels.defaults.groupPolicy` เพื่อแทนที่ค่าเริ่มต้นเมื่อยังไม่ตั้งค่า
- `channels.msteams.groupAllowFrom` ควบคุมว่าผู้ส่งใดสามารถทริกเกอร์ในแชทกลุ่ม/ช่องทาง (ย้อนกลับไปใช้ `channels.msteams.allowFrom`)
- ตั้งค่า `groupPolicy: "open"` เพื่ออนุญาตสมาชิกทุกคน (ยังต้องกล่าวถึงเป็นค่าเริ่มต้น)
- หากต้องการ **ไม่อนุญาตช่องทางใดเลย** ให้ตั้งค่า `channels.msteams.groupPolicy: "disabled"`

ตัวอย่าง:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**รายการอนุญาต Teams + ช่องทาง**

- จำกัดขอบเขตการตอบในกลุ่ม/ช่องทางโดยระบุทีมและช่องทางภายใต้ `channels.msteams.teams`
- คีย์สามารถเป็น ID หรือชื่อทีม; คีย์ช่องทางสามารถเป็น conversation ID หรือชื่อ
- เมื่อ `groupPolicy="allowlist"` และมีรายการอนุญาตทีม จะยอมรับเฉพาะทีม/ช่องทางที่ระบุ (ต้องกล่าวถึง)
- วิซาร์ดการตั้งค่ารองรับรายการ `Team/Channel` และจัดเก็บให้คุณ
- ระหว่างเริ่มต้น OpenClaw จะแปลงชื่อทีม/ช่องทางและผู้ใช้ในรายการอนุญาตเป็น ID (เมื่อ Graph อนุญาต)
  และบันทึกการแมป; รายการที่แปลงไม่ได้จะคงไว้ตามที่พิมพ์

ตัวอย่าง:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## ทำงานอย่างไร

1. ติดตั้งปลั๊กอิน Microsoft Teams
2. สร้าง **Azure Bot** (App ID + secret + tenant ID)
3. สร้าง **แพ็กเกจแอป Teams** ที่อ้างอิงบอตและรวมสิทธิ์ RSC ด้านล่าง
4. อัปโหลด/ติดตั้งแอป Teams ลงในทีม (หรือขอบเขตส่วนตัวสำหรับ DM)
5. กำหนดค่า `msteams` ใน `~/.openclaw/openclaw.json` (หรือตัวแปรสภาพแวดล้อม) และเริ่ม Gateway
6. Gateway รับทราฟฟิก webhook ของ Bot Framework บน `/api/messages` เป็นค่าเริ่มต้น

## การตั้งค่า Azure Bot (ข้อกำหนดก่อนเริ่มต้น)

ก่อนกำหนดค่า OpenClaw คุณต้องสร้างทรัพยากร Azure Bot

### ขั้นตอนที่ 1: สร้าง Azure Bot

1. ไปที่ [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. กรอกแท็บ **Basics**:

   | ฟิลด์              | ค่า                                                                   |
   | ------------------ | --------------------------------------------------------------------- |
   | **Bot handle**     | ชื่อบอตของคุณ เช่น `openclaw-msteams` (ต้องไม่ซ้ำ) |
   | **Subscription**   | เลือก Azure subscription ของคุณ                                       |
   | **Resource group** | สร้างใหม่หรือใช้ที่มีอยู่                                             |
   | **Pricing tier**   | **Free** สำหรับ dev/testing                                           |
   | **Type of App**    | **Single Tenant** (แนะนำ - ดูหมายเหตุด้านล่าง)     |
   | **Creation type**  | **Create new Microsoft App ID**                                       |

> **ประกาศเลิกใช้:** การสร้างบอตแบบ multi-tenant ใหม่ถูกยกเลิกหลัง 2025-07-31 ใช้ **Single Tenant** สำหรับบอตใหม่ Use **Single Tenant** for new bots.

3. คลิก **Review + create** → **Create** (รอ ~1-2 นาที)

### ขั้นตอนที่ 2: รับข้อมูลรับรอง

1. ไปที่ทรัพยากร Azure Bot ของคุณ → **Configuration**
2. คัดลอก **Microsoft App ID** → นี่คือ `appId`
3. คลิก **Manage Password** → ไปที่ App Registration
4. ใต้ **Certificates & secrets** → **New client secret** → คัดลอก **Value** → นี่คือ `appPassword`
5. ไปที่ **Overview** → คัดลอก **Directory (tenant) ID** → นี่คือ `tenantId`

### ขั้นตอนที่ 3: กำหนด Messaging Endpoint

1. ใน Azure Bot → **Configuration**
2. ตั้งค่า **Messaging endpoint** เป็น URL webhook ของคุณ:
   - โปรดักชัน: `https://your-domain.com/api/messages`
   - โลคอล dev: ใช้ tunnel (ดู [Local Development](#local-development-tunneling) ด้านล่าง)

### ขั้นตอนที่ 4: เปิดใช้งาน Teams Channel

1. ใน Azure Bot → **Channels**
2. คลิก **Microsoft Teams** → Configure → Save
3. ยอมรับข้อกำหนดการใช้งาน

## การพัฒนาในเครื่อง (Tunneling)

Teams ไม่สามารถเข้าถึง `localhost`. ใช้ tunnel สำหรับการพัฒนาในเครื่อง:

**ตัวเลือก A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**ตัวเลือก B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (ทางเลือก)

แทนการสร้าง ZIP manifest ด้วยตนเอง คุณสามารถใช้ [Teams Developer Portal](https://dev.teams.microsoft.com/apps):

1. คลิก **+ New app**
2. กรอกข้อมูลพื้นฐาน (ชื่อ คำอธิบาย ข้อมูลผู้พัฒนา)
3. ไปที่ **App features** → **Bot**
4. เลือก **Enter a bot ID manually** และวาง Azure Bot App ID
5. เลือกขอบเขต: **Personal**, **Team**, **Group Chat**
6. คลิก **Distribute** → **Download app package**
7. ใน Teams: **Apps** → **Manage your apps** → **Upload a custom app** → เลือก ZIP

มักง่ายกว่าการแก้ไข JSON manifest ด้วยมือ

## การทดสอบบอต

**ตัวเลือก A: Azure Web Chat (ยืนยัน webhook ก่อน)**

1. ใน Azure Portal → ทรัพยากร Azure Bot ของคุณ → **Test in Web Chat**
2. ส่งข้อความ — ควรเห็นการตอบกลับ
3. ยืนยันว่า endpoint webhook ทำงานก่อนตั้งค่า Teams

**ตัวเลือก B: Teams (หลังติดตั้งแอป)**

1. ติดตั้งแอป Teams (sideload หรือ org catalog)
2. ค้นหาบอตใน Teams และส่ง DM
3. ตรวจสอบล็อก Gateway สำหรับกิจกรรมที่เข้ามา

## การตั้งค่า (ข้อความล้วนขั้นต่ำ)

1. **ติดตั้งปลั๊กอิน Microsoft Teams**
   - จาก npm: `openclaw plugins install @openclaw/msteams`
   - จากโลคอล checkout: `openclaw plugins install ./extensions/msteams`

2. **ลงทะเบียนบอต**
   - สร้าง Azure Bot (ดูด้านบน) และบันทึก:
     - App ID
     - Client secret (App password)
     - Tenant ID (single-tenant)

3. **Manifest แอป Teams**
   - รวมรายการ `bot` พร้อม `botId = <App ID>`.
   - ขอบเขต: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (จำเป็นสำหรับการจัดการไฟล์ในขอบเขตส่วนตัว)
   - เพิ่มสิทธิ์ RSC (ด้านล่าง)
   - สร้างไอคอน: `outline.png` (32x32) และ `color.png` (192x192)
   - ซิปไฟล์ทั้งสาม: `manifest.json`, `outline.png`, `color.png`

4. **กำหนดค่า OpenClaw**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   คุณสามารถใช้ตัวแปรสภาพแวดล้อมแทนคีย์คอนฟิกได้:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Bot endpoint**
   - ตั้งค่า Azure Bot Messaging Endpoint เป็น:
     - `https://<host>:3978/api/messages` (หรือพาธ/พอร์ตที่คุณเลือก)

6. **รัน Gateway**
   - ช่องทาง Teams จะเริ่มอัตโนมัติเมื่อปลั๊กอินถูกติดตั้งและมีคอนฟิก `msteams` พร้อมข้อมูลรับรอง

## บริบทประวัติ

- `channels.msteams.historyLimit` ควบคุมจำนวนข้อความล่าสุดในช่องทาง/กลุ่มที่ถูกรวมเข้าในพรอมต์
- ย้อนกลับไปใช้ `messages.groupChat.historyLimit`. ตั้งค่า `0` เพื่อปิด (ค่าเริ่มต้น 50)
- ประวัติ DM สามารถจำกัดด้วย `channels.msteams.dmHistoryLimit` (จำนวนเทิร์นต่อผู้ใช้) การแทนที่ต่อผู้ใช้: `channels.msteams.dms["<user_id>"].historyLimit` `channels.signal.dmHistoryLimit`: ขีดจำกัดประวัติ DM ในรอบผู้ใช้ การเขียนทับต่อผู้ใช้: `channels.msteams.dms["<user_id>"].historyLimit`

## สิทธิ์ Teams RSC ปัจจุบัน (Manifest)

สิทธิ์ **resourceSpecific permissions** ที่มีอยู่ใน manifest แอป Teams ใช้ได้เฉพาะภายในทีม/แชทที่ติดตั้งแอป ใช้ได้เฉพาะภายในทีม/แชตที่ติดตั้งแอป

**สำหรับช่องทาง (ขอบเขตทีม):**

- `ChannelMessage.Read.Group` (Application) - รับข้อความช่องทางทั้งหมดโดยไม่ต้อง @mention
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**สำหรับแชทกลุ่ม:**

- `ChatMessage.Read.Chat` (Application) - รับข้อความแชทกลุ่มทั้งหมดโดยไม่ต้อง @mention

## ตัวอย่าง Teams Manifest (ปิดบังข้อมูล)

ตัวอย่างขั้นต่ำที่ถูกต้องพร้อมฟิลด์ที่จำเป็น แทนที่ ID และ URL แทนที่ IDs และ URLs

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### ข้อควรระวังของ Manifest (ฟิลด์ที่ต้องมี)

- `bots[].botId` **ต้อง** ตรงกับ Azure Bot App ID
- `webApplicationInfo.id` **ต้อง** ตรงกับ Azure Bot App ID
- `bots[].scopes` ต้องรวมพื้นผิวที่คุณจะใช้ (`personal`, `team`, `groupChat`)
- `bots[].supportsFiles: true` จำเป็นสำหรับการจัดการไฟล์ในขอบเขตส่วนตัว
- `authorization.permissions.resourceSpecific` ต้องรวมการอ่าน/ส่งในช่องทางหากต้องการทราฟฟิกช่องทาง

### การอัปเดตแอปที่มีอยู่

เพื่ออัปเดตแอป Teams ที่ติดตั้งแล้ว (เช่น เพิ่มสิทธิ์ RSC):

1. อัปเดต `manifest.json` ด้วยการตั้งค่าใหม่
2. **เพิ่มค่า `version`** (เช่น `1.0.0` → `1.1.0`)
3. **ซิปใหม่** พร้อมไอคอน (`manifest.json`, `outline.png`, `color.png`)
4. อัปโหลด zip ใหม่:
   - **ตัวเลือก A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → ค้นหาแอป → Upload new version
   - **ตัวเลือก B (Sideload):** ใน Teams → Apps → Manage your apps → Upload a custom app
5. **สำหรับช่องทางทีม:** ติดตั้งแอปใหม่ในแต่ละทีมเพื่อให้สิทธิ์ใหม่มีผล
6. **ปิดและเปิด Teams ใหม่ทั้งหมด** (ไม่ใช่แค่ปิดหน้าต่าง) เพื่อเคลียร์แคชเมทาดาทาแอป

## ความสามารถ: RSC เท่านั้น vs Graph

### ด้วย **Teams RSC เท่านั้น** (ติดตั้งแอป ไม่มีสิทธิ์ Graph API)

ทำงานได้:

- อ่านเนื้อหา **ข้อความ** ของข้อความช่องทาง
- ส่งเนื้อหา **ข้อความ** ในช่องทาง
- รับไฟล์แนบ **ส่วนตัว (DM)**

ไม่ทำงาน:

- **รูปภาพหรือไฟล์** ในช่องทาง/กลุ่ม (payload มีเพียง HTML stub)
- ดาวน์โหลดไฟล์แนบที่เก็บใน SharePoint/OneDrive
- อ่านประวัติข้อความ (นอกเหนือจากอีเวนต์ webhook แบบสด)

### ด้วย **Teams RSC + สิทธิ์ Microsoft Graph แบบ Application**

เพิ่ม:

- ดาวน์โหลดเนื้อหาที่โฮสต์ (รูปภาพที่วางในข้อความ)
- ดาวน์โหลดไฟล์แนบที่เก็บใน SharePoint/OneDrive
- อ่านประวัติข้อความช่องทาง/แชทผ่าน Graph

### RSC vs Graph API

| ความสามารถ                | สิทธิ์ RSC                            | Graph API                                  |
| ------------------------- | ------------------------------------- | ------------------------------------------ |
| **ข้อความเรียลไทม์**      | ใช่ (ผ่าน webhook) | ไม่ (โพลลิงเท่านั้น)    |
| **ข้อความย้อนหลัง**       | ไม่                                   | ใช่ (คิวรีประวัติได้)   |
| **ความซับซ้อนการตั้งค่า** | เฉพาะ manifest แอป                    | ต้องขอความยินยอมผู้ดูแล + โฟลว์โทเคน       |
| **ทำงานออฟไลน์**          | ไม่ (ต้องรันอยู่)  | ใช่ (คิวรีเมื่อใดก็ได้) |

**สรุป:** RSC สำหรับการฟังแบบเรียลไทม์; Graph API สำหรับการเข้าถึงย้อนหลัง หากต้องการดึงข้อความที่พลาดไปขณะออฟไลน์ ต้องใช้ Graph API พร้อม `ChannelMessage.Read.All` (ต้องขอความยินยอมผู้ดูแล) For catching up on missed messages while offline, you need Graph API with `ChannelMessage.Read.All` (requires admin consent).

## สื่อ + ประวัติที่เปิดด้วย Graph (จำเป็นสำหรับช่องทาง)

หากต้องการรูป/ไฟล์ใน **ช่องทาง** หรือดึง **ประวัติข้อความ** ต้องเปิดสิทธิ์ Microsoft Graph และขอความยินยอมผู้ดูแล

1. ใน Entra ID (Azure AD) **App Registration** เพิ่ม Microsoft Graph **Application permissions**:
   - `ChannelMessage.Read.All` (ไฟล์แนบช่องทาง + ประวัติ)
   - `Chat.Read.All` หรือ `ChatMessage.Read.All` (แชทกลุ่ม)
2. **ให้ความยินยอมผู้ดูแล** สำหรับ tenant
3. เพิ่มเวอร์ชัน **manifest** แอป Teams อัปโหลดใหม่ และ **ติดตั้งแอปใน Teams ใหม่**
4. **ปิดและเปิด Teams ใหม่ทั้งหมด** เพื่อเคลียร์แคชเมทาดาทาแอป

## ข้อจำกัดที่ทราบ

### เวลาหมดอายุของ Webhook

Teams ส่งข้อความผ่าน HTTP webhook Teams ส่งข้อความผ่าน HTTP webhook หากประมวลผลนานเกินไป (เช่น LLM ช้า) อาจพบ:

- Gateway timeout
- Teams ส่งซ้ำ (เกิดข้อความซ้ำ)
- การตอบกลับหลุดหาย

OpenClaw แก้ไขโดยตอบกลับอย่างรวดเร็วและส่งข้อความเชิงรุกภายหลัง แต่การตอบที่ช้ามากยังอาจเกิดปัญหาได้

### การจัดรูปแบบ

Markdown ของ Teams มีข้อจำกัดมากกว่า Slack หรือ Discord:

- การจัดรูปแบบพื้นฐานใช้ได้: **ตัวหนา**, _ตัวเอียง_, `code`, ลิงก์
- Markdown ซับซ้อน (ตาราง รายการซ้อน) อาจแสดงผลไม่ถูกต้อง
- รองรับ Adaptive Cards สำหรับโพลและการ์ดทั่วไป (ดูด้านล่าง)

## การกำหนดค่า

การตั้งค่าหลัก (ดู `/gateway/configuration` สำหรับแพตเทิร์นช่องทางร่วม):

- `channels.msteams.enabled`: เปิด/ปิดช่องทาง
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: ข้อมูลรับรองบอต
- `channels.msteams.webhook.port` (ค่าเริ่มต้น `3978`)
- `channels.msteams.webhook.path` (ค่าเริ่มต้น `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (ค่าเริ่มต้น: pairing)
- `channels.msteams.allowFrom`: รายการอนุญาต DM (AAD object IDs, UPNs หรือชื่อที่แสดง) วิซาร์ดจะแปลงชื่อเป็น ID ระหว่างตั้งค่าเมื่อมีสิทธิ์ Graph ตัวช่วย (wizard) จะแปลงชื่อเป็น ID ระหว่างการตั้งค่าเมื่อมีการเข้าถึง Graph
- `channels.msteams.textChunkLimit`: ขนาดชิ้นข้อความขาออก
- `channels.msteams.chunkMode`: `length` (ค่าเริ่มต้น) หรือ `newline` เพื่อแบ่งตามบรรทัดว่างก่อนแบ่งตามความยาว
- `channels.msteams.mediaAllowHosts`: รายการอนุญาตโฮสต์ไฟล์แนบขาเข้า (ค่าเริ่มต้นโดเมน Microsoft/Teams)
- `channels.msteams.mediaAuthAllowHosts`: รายการอนุญาตโฮสต์สำหรับแนบ Authorization header ระหว่าง retry สื่อ (ค่าเริ่มต้น Graph + Bot Framework)
- `channels.msteams.requireMention`: ต้อง @mention ในช่องทาง/กลุ่ม (ค่าเริ่มต้น true)
- `channels.msteams.replyStyle`: `thread | top-level` (ดู [รูปแบบการตอบ](#reply-style-threads-vs-posts))
- `channels.msteams.teams.<teamId>.replyStyle`: แทนที่ต่อทีม
- `channels.msteams.teams.<teamId>.requireMention`: แทนที่ต่อทีม
- `channels.msteams.teams.<teamId>.tools`: แทนที่นโยบายเครื่องมือเริ่มต้นต่อทีม (`allow`/`deny`/`alsoAllow`) เมื่อไม่มีการแทนที่ระดับช่องทาง
- `channels.msteams.teams.<teamId>.toolsBySender`: แทนที่นโยบายเครื่องมือต่อทีมต่อผู้ส่ง (`"*"` รองรับ wildcard)
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: แทนที่ต่อช่องทาง
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: แทนที่ต่อช่องทาง
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: แทนที่นโยบายเครื่องมือระดับช่องทาง (`allow`/`deny`/`alsoAllow`)
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: แทนที่นโยบายเครื่องมือระดับช่องทางต่อผู้ส่ง (`"*"` รองรับ wildcard)
- `channels.msteams.sharePointSiteId`: SharePoint site ID สำหรับอัปโหลดไฟล์ในแชทกลุ่ม/ช่องทาง (ดู [การส่งไฟล์ในแชทกลุ่ม](#sending-files-in-group-chats))

## การกำหนดเส้นทางและเซสชัน

- คีย์เซสชันเป็นไปตามรูปแบบเอเจนต์มาตรฐาน (ดู [/concepts/session](/concepts/session)):
  - DM ใช้เซสชันหลักร่วมกัน (`agent:<agentId>:<mainKey>`)
  - ข้อความช่องทาง/กลุ่มใช้ conversation id:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## รูปแบบการตอบ: Threads vs Posts

Teams เพิ่งเพิ่มสไตล์ UI ของช่องทางสองแบบบนโมเดลข้อมูลเดียวกัน:

| สไตล์                                        | คำอธิบาย                             | `replyStyle` ที่แนะนำ                     |
| -------------------------------------------- | ------------------------------------ | ----------------------------------------- |
| **Posts** (คลาสสิก)       | ข้อความเป็นการ์ดและมีเธรดตอบด้านล่าง | `thread` (ค่าเริ่มต้น) |
| **Threads** (คล้าย Slack) | ข้อความเรียงต่อเนื่องเหมือน Slack    | `top-level`                               |

**ปัญหา:** API ของ Teams ไม่เปิดเผยว่าสไตล์ใดถูกใช้ หากใช้ `replyStyle` ไม่ถูกต้อง: หากคุณใช้ `replyStyle` ผิด:

- `thread` ในช่องทางสไตล์ Threads → การตอบซ้อนดูแปลก
- `top-level` ในช่องทางสไตล์ Posts → การตอบกลายเป็นโพสต์ระดับบนสุดแยกจากเธรด

**ทางแก้:** กำหนดค่า `replyStyle` ต่อช่องทางตามการตั้งค่าจริง:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## ไฟล์แนบและรูปภาพ

**ข้อจำกัดปัจจุบัน:**

- **DMs:** รูปและไฟล์แนบทำงานผ่าน API ไฟล์ของบอต Teams
- **Channels/groups:** ไฟล์แนบจะอยู่ในที่เก็บ M365 (SharePoint/OneDrive) payload ของ webhook มีเพียง HTML stub ไม่ได้มีไบต์ของไฟล์จริง **ช่องทาง/กลุ่ม:** ไฟล์อยู่ใน M365 (SharePoint/OneDrive) payload ของ webhook มีเพียง HTML stub ไม่ใช่ไบต์ไฟล์จริง **ต้องใช้สิทธิ์ Graph API** เพื่อดาวน์โหลดไฟล์แนบในช่องทาง

หากไม่มีสิทธิ์ Graph ข้อความในช่องที่มีรูปภาพจะถูกส่งมาเป็นข้อความล้วน (บอทไม่สามารถเข้าถึงเนื้อหารูปภาพได้)
โดยค่าเริ่มต้น OpenClaw จะดาวน์โหลดสื่อเฉพาะจากโฮสต์ของ Microsoft/Teams เท่านั้น สามารถ override ด้วย `channels.msteams.mediaAllowHosts` (ใช้ `"["*"]"` เพื่ออนุญาตทุกโฮสต์)
หากไม่มีสิทธิ์ Graph ข้อความช่องทางที่มีรูปจะถูกรับเป็นข้อความล้วน (บอตไม่เข้าถึงเนื้อหารูป)
โดยค่าเริ่มต้น OpenClaw ดาวน์โหลดสื่อจากโฮสต์ Microsoft/Teams เท่านั้น แทนที่ด้วย `channels.msteams.mediaAllowHosts` (ใช้ `["*"]` เพื่ออนุญาตทุกโฮสต์)
Authorization header จะถูกแนบเฉพาะโฮสต์ใน `channels.msteams.mediaAuthAllowHosts` (ค่าเริ่มต้น Graph + Bot Framework) ควรรักษารายการนี้ให้เข้มงวด ควรรักษารายการนี้ให้เข้มงวด (หลีกเลี่ยง suffix แบบ multi-tenant)

## การส่งไฟล์ในแชทกลุ่ม

บอทสามารถส่งไฟล์ใน DM โดยใช้ขั้นตอน FileConsentCard (มีมาให้แล้ว) บอตสามารถส่งไฟล์ใน DM ด้วยโฟลว์ FileConsentCard (มีมาให้) อย่างไรก็ตาม **การส่งไฟล์ในแชทกลุ่ม/ช่องทาง** ต้องตั้งค่าเพิ่มเติม:

| บริบท                                    | วิธีส่งไฟล์                                 | การตั้งค่าที่ต้องใช้                      |
| ---------------------------------------- | ------------------------------------------- | ----------------------------------------- |
| **DMs**                                  | FileConsentCard → ผู้ใช้ยอมรับ → บอตอัปโหลด | ใช้งานได้ทันที                            |
| **แชทกลุ่ม/ช่องทาง**                     | อัปโหลดไป SharePoint → แชร์ลิงก์            | ต้องใช้ `sharePointSiteId` + สิทธิ์ Graph |
| **รูปภาพ (ทุกบริบท)** | แทรก inline แบบ Base64                      | ใช้งานได้ทันที                            |

### เหตุผลที่แชทกลุ่มต้องใช้ SharePoint

บอทไม่มี OneDrive ส่วนตัว (endpoint Graph API `/me/drive` ใช้ไม่ได้กับ application identities) บอตไม่มี OneDrive ส่วนตัว (endpoint Graph `/me/drive` ใช้ไม่ได้กับ application identities) การส่งไฟล์ในแชทกลุ่ม/ช่องทางจึงต้องอัปโหลดไปยัง **ไซต์ SharePoint** และสร้างลิงก์แชร์

### การตั้งค่า

1. **เพิ่มสิทธิ์ Graph API** ใน Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) - อัปโหลดไฟล์ไป SharePoint
   - `Chat.Read.All` (Application) - ไม่บังคับ เปิดใช้ลิงก์แชร์รายผู้ใช้

2. **ให้ความยินยอมผู้ดูแล** สำหรับ tenant

3. **รับ SharePoint site ID:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **กำหนดค่า OpenClaw:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### พฤติกรรมการแชร์

| สิทธิ์                                  | พฤติกรรมการแชร์                                                  |
| --------------------------------------- | ---------------------------------------------------------------- |
| `Sites.ReadWrite.All` เท่านั้น          | ลิงก์แชร์ทั้งองค์กร (ทุกคนในองค์กรเข้าถึงได้) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | ลิงก์แชร์รายผู้ใช้ (เฉพาะสมาชิกแชทเข้าถึงได้) |

การแชร์รายผู้ใช้ปลอดภัยกว่า เพราะมีเพียงผู้เข้าร่วมแชทเท่านั้นที่เข้าถึงไฟล์ได้ หากขาดสิทธิ์ `Chat.Read.All` บอตจะถอยกลับไปใช้การแชร์ทั้งองค์กร หากขาดสิทธิ์ `Chat.Read.All` บอทจะถอยกลับไปใช้การแชร์ระดับทั้งองค์กร

### พฤติกรรมสำรอง

| สถานการณ์                                    | ผลลัพธ์                                                               |
| -------------------------------------------- | --------------------------------------------------------------------- |
| แชทกลุ่ม + ไฟล์ + ตั้งค่า `sharePointSiteId` | อัปโหลด SharePoint และส่งลิงก์แชร์                                    |
| แชทกลุ่ม + ไฟล์ + ไม่มี `sharePointSiteId`   | พยายามอัปโหลด OneDrive (อาจล้มเหลว) ส่งข้อความล้วน |
| แชทส่วนตัว + ไฟล์                            | โฟลว์ FileConsentCard (ไม่ต้องใช้ SharePoint)      |
| ทุกบริบท + รูปภาพ                            | แทรก inline แบบ Base64 (ไม่ต้องใช้ SharePoint)     |

### ตำแหน่งจัดเก็บไฟล์

ไฟล์ที่อัปโหลดจะถูกเก็บในโฟลเดอร์ `/OpenClawShared/` ในไลบรารีเอกสารเริ่มต้นของไซต์ SharePoint ที่กำหนดค่าไว้

## โพล (Adaptive Cards)

OpenClaw ส่งโพล Teams เป็น Adaptive Cards (ไม่มี API โพลเนทีฟของ Teams)

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- คะแนนโหวตถูกบันทึกโดย Gateway ใน `~/.openclaw/msteams-polls.json`
- Gateway ต้องออนไลน์เพื่อบันทึกโหวต
- ยังไม่โพสต์สรุปผลอัตโนมัติ (ตรวจดูไฟล์สโตร์ได้หากจำเป็น)

## Adaptive Cards (ทั่วไป)

ส่ง JSON ของ Adaptive Card ใดๆ ไปยังผู้ใช้หรือบทสนทนา Teams ด้วยเครื่องมือหรือ CLI `message`

พารามิเตอร์ `card` รับอ็อบเจ็กต์ JSON ของ Adaptive Card เมื่อมี `card` ข้อความประกอบเป็นตัวเลือก เมื่อมีการระบุ `card` ข้อความสามารถไม่ต้องมีได้

**เครื่องมือเอเจนต์:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

ดู [เอกสาร Adaptive Cards](https://adaptivecards.io/) สำหรับสคีมาและตัวอย่าง สำหรับรายละเอียดรูปแบบเป้าหมาย ดู [Target formats](#target-formats) ด้านล่าง สำหรับรายละเอียดรูปแบบเป้าหมาย ดูที่ [Target formats](#target-formats) ด้านล่าง

## รูปแบบเป้าหมาย

เป้าหมาย MSTeams ใช้พรีฟิกซ์เพื่อแยกผู้ใช้กับบทสนทนา:

| ประเภทเป้าหมาย                         | รูปแบบ                           | ตัวอย่าง                                                         |
| -------------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| ผู้ใช้ (ตาม ID)     | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                      |
| ผู้ใช้ (ตามชื่อ)    | `user:<display-name>`            | `user:John Smith` (ต้องใช้ Graph API)         |
| กลุ่ม/ช่องทาง                          | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                         |
| กลุ่ม/ช่องทาง (ดิบ) | `<conversation-id>`              | `19:abc123...@thread.tacv2` (หากมี `@thread`) |

**ตัวอย่าง CLI:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**ตัวอย่างเครื่องมือเอเจนต์:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

หมายเหตุ: หากไม่มีพรีฟิกซ์ `user:` ชื่อจะถูกแก้ไขเป็นกลุ่ม/ทีมโดยปริยาย ใช้ `user:` เสมอเมื่อกำหนดเป้าหมายบุคคลตามชื่อที่แสดง ให้ใช้ `user:` เสมอเมื่อระบุเป้าหมายบุคคลด้วยชื่อที่แสดง

## การส่งข้อความเชิงรุก

- ข้อความเชิงรุกทำได้ **หลังจาก** ผู้ใช้โต้ตอบแล้วเท่านั้น เนื่องจากเราบันทึก conversation reference ณ จุดนั้น
- ดู `/gateway/configuration` สำหรับ `dmPolicy` และการกำหนดรายการอนุญาต

## Team และ Channel IDs (ข้อผิดพลาดที่พบบ่อย)

พารามิเตอร์คิวรี `groupId` ใน URL ของ Teams **ไม่ใช่** team ID ที่ใช้ในการกำหนดค่า ให้ดึง ID จากพาธของ URL แทน: ให้ดึง IDs จากพาธของ URL แทน:

**URL ทีม:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**URL ช่องทาง:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**สำหรับคอนฟิก:**

- Team ID = ส่วนพาธหลัง `/team/` (ถอดรหัส URL เช่น `19:Bk4j...@thread.tacv2`)
- Channel ID = ส่วนพาธหลัง `/channel/` (ถอดรหัส URL)
- **ละเว้น** พารามิเตอร์คิวรี `groupId`

## ช่องทางส่วนตัว

บอตรองรับช่องทางส่วนตัวได้จำกัด:

| ฟีเจอร์                                       | ช่องทางมาตรฐาน | ช่องทางส่วนตัว                    |
| --------------------------------------------- | -------------- | --------------------------------- |
| การติดตั้งบอต                                 | ใช่            | จำกัด                             |
| ข้อความเรียลไทม์ (webhook) | ใช่            | อาจไม่ทำงาน                       |
| สิทธิ์ RSC                                    | ใช่            | อาจทำงานต่างออกไป                 |
| @mentions                        | ใช่            | หากบอตเข้าถึงได้                  |
| ประวัติ Graph API                             | ใช่            | ใช่ (มีสิทธิ์) |

**วิธีแก้หากช่องทางส่วนตัวไม่ทำงาน:**

1. ใช้ช่องทางมาตรฐานสำหรับการโต้ตอบกับบอต
2. ใช้ DM — ผู้ใช้สามารถส่งข้อความถึงบอตได้โดยตรง
3. ใช้ Graph API สำหรับการเข้าถึงย้อนหลัง (ต้องใช้ `ChannelMessage.Read.All`)

## การแก้ไขปัญหา

### ปัญหาที่พบบ่อย

- **รูปไม่แสดงในช่องทาง:** ขาดสิทธิ์ Graph หรือการยินยอมผู้ดูแล ติดตั้งแอป Teams ใหม่และปิด/เปิด Teams ใหม่ทั้งหมด ติดตั้งแอป Teams ใหม่ และปิด/เปิด Teams ใหม่ทั้งหมด
- **ไม่มีการตอบในช่องทาง:** ค่าเริ่มต้นต้อง @mention; ตั้งค่า `channels.msteams.requireMention=false` หรือกำหนดต่อทีม/ช่องทาง
- **เวอร์ชันไม่ตรง (Teams ยังแสดง manifest เก่า):** ลบและเพิ่มแอปใหม่ แล้วปิด/เปิด Teams ใหม่ทั้งหมด
- **401 Unauthorized จาก webhook:** คาดว่าจะเกิดเมื่อทดสอบด้วยมือโดยไม่มี Azure JWT แปลว่า endpoint เข้าถึงได้แต่การยืนยันตัวตนล้มเหลว ใช้ Azure Web Chat เพื่อทดสอบอย่างถูกต้อง ใช้ Azure Web Chat เพื่อทดสอบอย่างถูกต้อง

### ข้อผิดพลาดอัปโหลด Manifest

- **"Icon file cannot be empty":** ไฟล์ไอคอนที่อ้างอิงใน manifest มีขนาด 0 ไบต์ **"Icon file cannot be empty":** อ้างอิงไฟล์ไอคอนขนาด 0 ไบต์ สร้าง PNG ที่ถูกต้อง (32x32 สำหรับ `outline.png`, 192x192 สำหรับ `color.png`)
- **"webApplicationInfo.Id already in use":** แอปยังติดตั้งอยู่ในทีม/แชทอื่น ถอนการติดตั้งก่อนหรือรอ 5-10 นาทีให้การกระจายเสร็จ ค้นหาและถอนการติดตั้งก่อน หรือรอ 5–10 นาทีเพื่อให้การเผยแพร่เสร็จสิ้น
- **"Something went wrong" ระหว่างอัปโหลด:** ลองอัปโหลดผ่าน [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) เปิด DevTools (F12) → แท็บ Network และตรวจดู response body สำหรับข้อผิดพลาดจริง
- **Sideload ล้มเหลว:** ลอง “Upload an app to your org's app catalog” แทน “Upload a custom app” ซึ่งมักข้ามข้อจำกัด sideload ได้

### สิทธิ์ RSC ไม่ทำงาน

1. ตรวจสอบว่า `webApplicationInfo.id` ตรงกับ App ID ของบอตทุกประการ
2. อัปโหลดแอปใหม่และติดตั้งใหม่ในทีม/แชท
3. ตรวจสอบว่าผู้ดูแลองค์กรบล็อกสิทธิ์ RSC หรือไม่
4. ยืนยันว่าใช้ขอบเขตถูกต้อง: `ChannelMessage.Read.Group` สำหรับทีม, `ChatMessage.Read.Chat` สำหรับแชทกลุ่ม

## อ้างอิง

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - คู่มือการตั้งค่า Azure Bot
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - สร้าง/จัดการแอป Teams
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (ช่องทาง/กลุ่มต้องใช้ Graph)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
