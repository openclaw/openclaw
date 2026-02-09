---
summary: "การจับภาพจากกล้อง(โหนดiOS+แอปmacOS)สำหรับการใช้งานโดยเอเจนต์: รูปภาพ(jpg)และคลิปวิดีโอสั้น(mp4)"
read_when:
  - การเพิ่มหรือแก้ไขการจับภาพจากกล้องบนโหนดiOSหรือmacOS
  - การขยายเวิร์กโฟลว์ไฟล์ชั่วคราวMEDIAที่เอเจนต์เข้าถึงได้
title: "การจับภาพจากกล้อง"
---

# การจับภาพจากกล้อง (เอเจนต์)

OpenClaw รองรับ **การจับภาพจากกล้อง** สำหรับเวิร์กโฟลว์ของเอเจนต์:

- **โหนด iOS** (จับคู่ผ่าน Gateway): จับ **รูปภาพ** (`jpg`) หรือ **คลิปวิดีโอสั้น** (`mp4` พร้อมเสียงเสริม) ผ่าน `node.invoke`.
- **โหนด Android** (จับคู่ผ่าน Gateway): จับ **รูปภาพ** (`jpg`) หรือ **คลิปวิดีโอสั้น** (`mp4` พร้อมเสียงเสริม) ผ่าน `node.invoke`.
- **แอป macOS** (โหนดผ่าน Gateway): จับ **รูปภาพ** (`jpg`) หรือ **คลิปวิดีโอสั้น** (`mp4` พร้อมเสียงเสริม) ผ่าน `node.invoke`.

การเข้าถึงกล้องทั้งหมดถูกควบคุมด้วย **การตั้งค่าที่ผู้ใช้กำหนดได้**.

## โหนด iOS

### การตั้งค่าผู้ใช้ (ค่าเริ่มต้นเปิด)

- แท็บการตั้งค่า iOS → **Camera** → **Allow Camera** (`camera.enabled`)
  - ค่าเริ่มต้น: **เปิด** (หากไม่มีคีย์จะถือว่าเปิดใช้งาน)
  - เมื่อปิด: คำสั่ง `camera.*` จะส่งคืน `CAMERA_DISABLED`.

### คำสั่ง (ผ่าน Gateway `node.invoke`)

- `camera.list`
  - เพย์โหลดการตอบกลับ:
    - `devices`: อาร์เรย์ของ `{ id, name, position, deviceType }`

- `camera.snap`
  - 14. พารามิเตอร์:
    - `facing`: `front|back` (ค่าเริ่มต้น: `front`)
    - `maxWidth`: number (ไม่บังคับ; ค่าเริ่มต้น `1600` บนโหนด iOS)
    - `quality`: `0..1` (ไม่บังคับ; ค่าเริ่มต้น `0.9`)
    - `format`: ปัจจุบันคือ `jpg`
    - `delayMs`: number (ไม่บังคับ; ค่าเริ่มต้น `0`)
    - `deviceId`: string (ไม่บังคับ; จาก `camera.list`)
  - เพย์โหลดการตอบกลับ:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - ตัวป้องกันเพย์โหลด: รูปภาพจะถูกบีบอัดใหม่เพื่อให้เพย์โหลด base64 ต่ำกว่า 5 MB

- `camera.clip`
  - 15. พารามิเตอร์:
    - `facing`: `front|back` (ค่าเริ่มต้น: `front`)
    - `durationMs`: number (ค่าเริ่มต้น `3000` ถูกจำกัดไม่เกิน `60000`)
    - `includeAudio`: boolean (ค่าเริ่มต้น `true`)
    - `format`: ปัจจุบันคือ `mp4`
    - `deviceId`: string (ไม่บังคับ; จาก `camera.list`)
  - เพย์โหลดการตอบกลับ:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### 16. ข้อกำหนดโหมด Foreground

เช่นเดียวกับ `canvas.*` โหนด iOS อนุญาตให้ใช้คำสั่ง `camera.*` ได้เฉพาะใน **โฟร์กราวด์** เท่านั้น การเรียกใช้งานในเบื้องหลังจะส่งคืน `NODE_BACKGROUND_UNAVAILABLE`. 17. การเรียกใช้งานเบื้องหลังจะส่งคืน `NODE_BACKGROUND_UNAVAILABLE`

### ตัวช่วย CLI (ไฟล์ชั่วคราว + MEDIA)

วิธีที่ง่ายที่สุดในการรับไฟล์แนบคือผ่านตัวช่วย CLI ซึ่งจะเขียนสื่อที่ถอดรหัสแล้วลงไฟล์ชั่วคราวและพิมพ์ `MEDIA:<path>`.

ตัวอย่าง:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

หมายเหตุ:

- `nodes camera snap` มีค่าเริ่มต้นเป็น **ทั้งคู่** เพื่อให้เอเจนต์ได้ทั้งสองมุมมอง
- ไฟล์เอาต์พุตเป็นไฟล์ชั่วคราว(ในไดเรกทอรีชั่วคราวของระบบปฏิบัติการ)เว้นแต่คุณจะสร้างตัวห่อของคุณเอง

## โหนด Android

### การตั้งค่าผู้ใช้ Android (ค่าเริ่มต้นเปิด)

- แผ่นการตั้งค่า Android → **Camera** → **Allow Camera** (`camera.enabled`)
  - ค่าเริ่มต้น: **เปิด** (หากไม่มีคีย์จะถือว่าเปิดใช้งาน)
  - เมื่อปิด: คำสั่ง `camera.*` จะส่งคืน `CAMERA_DISABLED`.

### สิทธิ์

- Android ต้องการสิทธิ์ขณะรัน:
  - `CAMERA` สำหรับทั้ง `camera.snap` และ `camera.clip`.
  - `RECORD_AUDIO` สำหรับ `camera.clip` เมื่อ `includeAudio=true`.

หากขาดสิทธิ์ แอปจะถามเมื่อเป็นไปได้; หากถูกปฏิเสธ คำขอ `camera.*` จะล้มเหลวพร้อมข้อผิดพลาด
`*_PERMISSION_REQUIRED`.

### ข้อกำหนดโฟร์กราวด์ของ Android

เช่นเดียวกับ `canvas.*` โหนด Android อนุญาตให้ใช้คำสั่ง `camera.*` ได้เฉพาะใน **โฟร์กราวด์** เท่านั้น การเรียกใช้งานในเบื้องหลังจะส่งคืน `NODE_BACKGROUND_UNAVAILABLE`. 18. การเรียกใช้งานเบื้องหลังจะส่งคืน `NODE_BACKGROUND_UNAVAILABLE`

### ตัวป้องกันเพย์โหลด

รูปภาพจะถูกบีบอัดใหม่เพื่อให้เพย์โหลด base64 ต่ำกว่า 5 MB.

## แอป macOS

### การตั้งค่าผู้ใช้ (ค่าเริ่มต้นปิด)

แอปคู่หูบน macOS มีช่องทำเครื่องหมาย:

- **Settings → General → Allow Camera** (`openclaw.cameraEnabled`)
  - ค่าเริ่มต้น: **ปิด**
  - เมื่อปิด: คำขอกล้องจะส่งคืน “Camera disabled by user”.

### ตัวช่วย CLI (เรียกโหนด)

ใช้ CLI หลัก `openclaw` เพื่อเรียกคำสั่งกล้องบนโหนด macOS.

ตัวอย่าง:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

หมายเหตุ:

- `openclaw nodes camera snap` มีค่าเริ่มต้นเป็น `maxWidth=1600` เว้นแต่จะถูกแทนที่
- บน macOS `camera.snap` จะรอ `delayMs` (ค่าเริ่มต้น 2000ms) หลังจากอุ่นเครื่อง/การรับแสงนิ่งแล้วจึงจับภาพ
- เพย์โหลดรูปภาพจะถูกบีบอัดใหม่เพื่อให้ base64 ต่ำกว่า 5 MB

## ความปลอดภัย + ข้อจำกัดเชิงปฏิบัติ

- การเข้าถึงกล้องและไมโครโฟนจะเรียกพรอมต์สิทธิ์ตามปกติของระบบปฏิบัติการ(และต้องมีสตริงการใช้งานใน Info.plist)
- คลิปวิดีโอถูกจำกัดความยาว(ปัจจุบัน `<= 60s`)เพื่อหลีกเลี่ยงเพย์โหลดโหนดที่มีขนาดใหญ่เกินไป(โอเวอร์เฮดของ base64 + ข้อจำกัดของข้อความ)

## วิดีโอหน้าจอ macOS (ระดับระบบปฏิบัติการ)

สำหรับวิดีโอ _หน้าจอ_ (ไม่ใช่กล้อง) ให้ใช้แอปคู่หูบน macOS:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

หมายเหตุ:

- ต้องการสิทธิ์ **Screen Recording** ของ macOS (TCC)
