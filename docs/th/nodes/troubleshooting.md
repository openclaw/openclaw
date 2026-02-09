---
summary: "แก้ไขปัญหาการจับคู่โหนด ข้อกำหนดการทำงานเบื้องหน้า สิทธิ์ และความล้มเหลวของเครื่องมือ"
read_when:
  - โหนดเชื่อมต่อแล้วแต่เครื่องมือ camera/canvas/screen/exec ใช้งานไม่ได้
  - คุณต้องการทำความเข้าใจโมเดลการจับคู่โหนดเทียบกับการอนุมัติ
title: "การแก้ไขปัญหาโหนด"
---

# การแก้ไขปัญหาโหนด

ใช้หน้านี้เมื่อโหนดแสดงว่าเชื่อมต่ออยู่ในสถานะ แต่เครื่องมือของโหนดทำงานล้มเหลว

## ลำดับขั้นคำสั่ง

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

จากนั้นรันการตรวจสอบเฉพาะโหนด:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

40. สัญญาณความสมบูรณ์:

- โหนดเชื่อมต่อและจับคู่แล้วสำหรับบทบาท `node`.
- `nodes describe` มีความสามารถที่คุณเรียกใช้อยู่
- การอนุมัติการรันคำสั่งแสดงโหมด/รายการอนุญาตตามที่คาดหวัง

## ข้อกำหนดการทำงานเบื้องหน้า

`canvas.*`, `camera.*`, และ `screen.*` ใช้งานได้เฉพาะเมื่ออยู่เบื้องหน้าบนโหนด iOS/Android

ตรวจสอบและแก้ไขอย่างรวดเร็ว:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

หากคุณเห็น `NODE_BACKGROUND_UNAVAILABLE` ให้นำแอปโหนดขึ้นมาอยู่เบื้องหน้าแล้วลองใหม่

## 41. เมทริกซ์สิทธิ์

| ความสามารถ                   | iOS                                                | Android                                                    | แอปโหนด macOS                                        | รหัสความล้มเหลวที่พบบ่อย       |
| ---------------------------- | -------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | กล้อง(+ไมค์สำหรับเสียงคลิป)     | กล้อง(+ไมค์สำหรับเสียงคลิป)             | กล้อง(+ไมค์สำหรับเสียงคลิป)       | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | การบันทึกหน้าจอ(+ไมค์ไม่บังคับ) | พรอมป์ต์การจับภาพหน้าจอ(+ไมค์ไม่บังคับ) | การบันทึกหน้าจอ                                      | `*_PERMISSION_REQUIRED`        |
| `location.get`               | ขณะใช้งานหรือเสมอ(ขึ้นกับโหมด)  | ตำแหน่งเบื้องหน้า/เบื้องหลังตามโหมด                        | สิทธิ์ตำแหน่ง                                        | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a(พาธโฮสต์โหนด)               | n/a(พาธโฮสต์โหนด)                       | 42. ต้องการการอนุมัติการ Exec | `SYSTEM_RUN_DENIED`            |

## การจับคู่เทียบกับการอนุมัติ

สิ่งเหล่านี้เป็นด่านที่ต่างกัน:

1. **การจับคู่อุปกรณ์**: โหนดนี้เชื่อมต่อกับ Gatewayได้หรือไม่?
2. **การอนุมัติการรันคำสั่ง**: โหนดนี้สามารถรันคำสั่งเชลล์เฉพาะได้หรือไม่?

การตรวจสอบอย่างรวดเร็ว:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

43. หากยังไม่ได้จับคู่ ให้อนุมัติอุปกรณ์โหนดก่อน
    หากยังไม่มีการจับคู่ ให้อนุมัติอุปกรณ์โหนดก่อน
    หากการจับคู่ปกติแต่ `system.run` ล้มเหลว ให้แก้ไขการอนุมัติการรันคำสั่ง/รายการอนุญาต

## รหัสข้อผิดพลาดของโหนดที่พบบ่อย

- `NODE_BACKGROUND_UNAVAILABLE` → แอปทำงานอยู่เบื้องหลัง; นำขึ้นมาอยู่เบื้องหน้า
- `CAMERA_DISABLED` → ปิดสวิตช์กล้องในค่าตั้งค่าโหนด
- `*_PERMISSION_REQUIRED` → ขาดสิทธิ์ของระบบปฏิบัติการหรือถูกปฏิเสธ
- `LOCATION_DISABLED` → โหมดตำแหน่งปิดอยู่
- `LOCATION_PERMISSION_REQUIRED` → ไม่ได้รับโหมดตำแหน่งที่ร้องขอ
- `LOCATION_BACKGROUND_UNAVAILABLE` → แอปอยู่เบื้องหลังแต่มีเพียงสิทธิ์ขณะใช้งานเท่านั้น
- `SYSTEM_RUN_DENIED: approval required` → คำขอ exec ต้องการการอนุมัติแบบชัดเจน
- `SYSTEM_RUN_DENIED: allowlist miss` → คำสั่งถูกบล็อกโดยโหมดรายการอนุญาต

## ลูปการกู้คืนอย่างรวดเร็ว

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

หากยังติดขัด:

- อนุมัติการจับคู่อุปกรณ์ใหม่
- เปิดแอปโหนดใหม่(ให้อยู่เบื้องหน้า)
- อนุญาตสิทธิ์ของระบบปฏิบัติการใหม่
- สร้างหรือปรับนโยบายการอนุมัติการรันคำสั่งใหม่

เกี่ยวข้อง:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
