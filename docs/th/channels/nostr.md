---
summary: "ช่องทางDMของNostrผ่านข้อความที่เข้ารหัสด้วยNIP-04"
read_when:
  - คุณต้องการให้OpenClawรับDMผ่านNostr
  - คุณกำลังตั้งค่าการส่งข้อความแบบกระจายศูนย์
title: "Nostr"
---

# Nostr

**สถานะ:** ปลั๊กอินทางเลือก(ปิดใช้งานเป็นค่าเริ่มต้น)

Nostr เป็นโปรโตคอลแบบกระจายศูนย์สำหรับโซเชียลเน็ตเวิร์ก Nostrเป็นโปรโตคอลแบบกระจายศูนย์สำหรับเครือข่ายสังคม ช่องทางนี้ช่วยให้OpenClawรับและตอบกลับข้อความส่วนตัว(DMs)ที่เข้ารหัสผ่านNIP-04ได้

## ติดตั้ง(ตามต้องการ)

### การเริ่มต้นใช้งาน (แนะนำ)

- ตัวช่วยเริ่มต้น(`openclaw onboard`)และ`openclaw channels add`จะแสดงรายการปลั๊กอินช่องทางเสริม
- การเลือกNostrจะกระตุ้นให้คุณติดตั้งปลั๊กอินตามต้องการ

ค่าเริ่มต้นการติดตั้ง:

- **Dev channel + มีgit checkout:** ใช้พาธปลั๊กอินภายในเครื่อง
- **Stable/Beta:** ดาวน์โหลดจากnpm

คุณสามารถเปลี่ยนตัวเลือกนี้ได้เสมอในพรอมป์

### ติดตั้งด้วยตนเอง

```bash
openclaw plugins install @openclaw/nostr
```

ใช้checkoutภายในเครื่อง(เวิร์กโฟลว์ฝั่งdev):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

รีสตาร์ตGatewayหลังจากติดตั้งหรือเปิดใช้งานปลั๊กอิน

## ตั้งค่าอย่างรวดเร็ว

1. สร้างคีย์คู่ของNostr(หากยังไม่มี):

```bash
# Using nak
nak key generate
```

2. เพิ่มลงในคอนฟิก:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. เอ็กซ์พอร์ตคีย์:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. รีสตาร์ตGateway

## อ้างอิงการกำหนดค่า

| Key          | Type                                                         | Default                                     | Description                               |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------- |
| `privateKey` | string                                                       | required                                    | คีย์ส่วนตัวในรูปแบบ`nsec`หรือhex          |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | URLของRelay(WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | นโยบายการเข้าถึงDM                        |
| `allowFrom`  | string[] | `[]`                                        | pubkeyของผู้ส่งที่อนุญาต                  |
| `enabled`    | boolean                                                      | `true`                                      | เปิด/ปิดใช้งานช่องทาง                     |
| `name`       | string                                                       | -                                           | ชื่อที่แสดง                               |
| `profile`    | object                                                       | -                                           | เมทาดาทาโปรไฟล์NIP-01                     |

## เมทาดาทาโปรไฟล์

ข้อมูลโปรไฟล์ถูกเผยแพร่เป็นอีเวนต์ NIP-01 `kind:0` ข้อมูลโปรไฟล์จะถูกเผยแพร่เป็นอีเวนต์`kind:0`ของNIP-01 คุณสามารถจัดการได้จากControl UI(Channels -> Nostr -> Profile)หรือกำหนดโดยตรงในคอนฟิก

ตัวอย่าง:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

หมายเหตุ:

- URLของโปรไฟล์ต้องใช้`https://`
- การนำเข้าจากRelayจะผสานฟิลด์และคงค่าที่เขียนทับในเครื่องไว้

## การควบคุมการเข้าถึง

### นโยบายDM

- **pairing**(ค่าเริ่มต้น): ผู้ส่งที่ไม่รู้จักจะได้รับโค้ดการจับคู่
- **allowlist**: เฉพาะpubkeyใน`allowFrom`เท่านั้นที่ส่งDMได้
- **open**: รับDMขาเข้าจากสาธารณะ(ต้องใช้`allowFrom: ["*"]`)
- **disabled**: เพิกเฉยต่อDMขาเข้า

### ตัวอย่างAllowlist

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## รูปแบบคีย์

รูปแบบที่รองรับ:

- **คีย์ส่วนตัว:** `nsec...`หรือhexยาว64อักขระ
- **Pubkey(`allowFrom`):** `npub...`หรือhex

## Relay

ค่าเริ่มต้น: `relay.damus.io`และ`nos.lol`

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

เคล็ดลับ:

- ใช้Relay 2-3แห่งเพื่อความทนทาน
- หลีกเลี่ยงRelayมากเกินไป(หน่วงเวลา,ซ้ำซ้อน)
- Relayแบบเสียเงินช่วยเพิ่มความน่าเชื่อถือ
- Relayภายในเครื่องเหมาะสำหรับการทดสอบ(`ws://localhost:7777`)

## การรองรับโปรโตคอล

| NIP    | Status | Description                                |
| ------ | ------ | ------------------------------------------ |
| NIP-01 | รองรับ | รูปแบบอีเวนต์พื้นฐาน+เมทาดาทาโปรไฟล์       |
| NIP-04 | รองรับ | DMที่เข้ารหัส(`kind:4`) |
| NIP-17 | วางแผน | DMแบบGift-wrap                             |
| NIP-44 | วางแผน | การเข้ารหัสแบบมีเวอร์ชัน                   |

## การทดสอบ

### รีเลย์ภายในเครื่อง

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### ทดสอบด้วยตนเอง

1. บันทึกpubkeyของบอต(npub)จากล็อก
2. เปิดไคลเอนต์Nostr(Damus,Amethystฯลฯ)
3. ส่งDMไปยังpubkeyของบอต
4. ตรวจสอบการตอบกลับ

## การแก้ไขปัญหา

### ไม่ได้รับข้อความ

- ตรวจสอบว่าคีย์ส่วนตัวถูกต้อง
- ตรวจสอบว่าURLของRelayเข้าถึงได้และใช้`wss://`(หรือ`ws://`สำหรับภายในเครื่อง)
- ยืนยันว่า`enabled`ไม่ใช่`false`
- ตรวจสอบล็อกของGatewayสำหรับข้อผิดพลาดการเชื่อมต่อRelay

### ไม่ส่งการตอบกลับ

- ตรวจสอบว่าRelayยอมรับการเขียน
- ตรวจสอบการเชื่อมต่อขาออก
- เฝ้าดูการจำกัดอัตราจากRelay

### การตอบกลับซ้ำ

- เป็นสิ่งที่คาดหวังเมื่อใช้หลายRelay
- ข้อความจะถูกกำจัดซ้ำด้วยevent ID; เฉพาะการส่งมอบครั้งแรกเท่านั้นที่กระตุ้นการตอบกลับ

## ความปลอดภัย

- อย่าคอมมิตคีย์ส่วนตัว
- ใช้ตัวแปรสภาพแวดล้อมสำหรับคีย์
- พิจารณา`allowlist`สำหรับบอตในสภาพแวดล้อมโปรดักชัน

## ข้อจำกัด(MVP)

- รองรับเฉพาะข้อความส่วนตัว(ไม่รองรับแชตกลุ่ม)
- ไม่รองรับไฟล์สื่อแนบ
- รองรับเฉพาะNIP-04(วางแผนNIP-17แบบgift-wrap)
