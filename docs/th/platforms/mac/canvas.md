---
summary: "แผงCanvasที่ควบคุมโดยเอเจนต์ ฝังผ่าน WKWebView + สคีม URL แบบกำหนดเอง"
read_when:
  - การพัฒนาแผงCanvasบน macOS
  - การเพิ่มการควบคุมเอเจนต์สำหรับเวิร์กสเปซแบบภาพ
  - การดีบักการโหลดCanvasด้วย WKWebView
title: "Canvas"
---

# Canvas (แอปmacOS)

แอปmacOS ฝัง **แผงCanvas** ที่ควบคุมโดยเอเจนต์โดยใช้ `WKWebView` โดยเป็นเวิร์กสเปซแบบภาพน้ำหนักเบาสำหรับ HTML/CSS/JS, A2UI และพื้นผิว UI แบบโต้ตอบขนาดเล็ก มันเป็นพื้นที่ทำงานเชิงภาพน้ำหนักเบาสำหรับ HTML/CSS/JS, A2UI และพื้นผิว UI แบบโต้ตอบขนาดเล็ก

## Canvas อยู่ที่ไหน

สถานะของCanvas ถูกจัดเก็บภายใต้ Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

แผงCanvas ให้บริการไฟล์เหล่านั้นผ่าน **สคีม URL แบบกำหนดเอง**:

- `openclaw-canvas://<session>/<path>`

ตัวอย่าง:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

หากไม่มี `index.html` อยู่ที่ราก แอปจะแสดง **หน้า scaffold ที่มีมาในตัว**

## พฤติกรรมของแผง

- แผงไร้กรอบ ปรับขนาดได้ ยึดตำแหน่งใกล้แถบเมนู (หรือเคอร์เซอร์เมาส์)
- จดจำขนาด/ตำแหน่งต่อเซสชัน
- รีโหลดอัตโนมัติเมื่อไฟล์Canvasในเครื่องมีการเปลี่ยนแปลง
- แสดงแผงCanvasได้เพียงหนึ่งแผงในเวลาเดียว (สลับเซสชันตามความจำเป็น)

สามารถปิดCanvasได้จาก การตั้งค่า → **Allow Canvas** เมื่อปิดใช้งาน คำสั่งโหนดของCanvas จะส่งกลับ `CANVAS_DISABLED`. เมื่อปิดใช้งาน คำสั่งโหนดของ canvas จะคืนค่า `CANVAS_DISABLED`

## พื้นผิว API ของเอเจนต์

Canvas ถูกเปิดเผยผ่าน **Gateway WebSocket** ดังนั้นเอเจนต์สามารถ:

- แสดง/ซ่อนแผง
- นำทางไปยังพาธหรือ URL
- ประเมินผล JavaScript
- จับภาพสแนปช็อต

ตัวอย่าง CLI:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

หมายเหตุ:

- `canvas.navigate` รองรับ **พาธCanvasในเครื่อง**, URL `http(s)` และ URL `file://`.
- หากส่ง `"/"` Canvas จะแสดง scaffold ในเครื่องหรือ `index.html`.

## A2UI ใน Canvas

A2UI ถูกโฮสต์โดยโฮสต์ canvas ของ Gateway และเรนเดอร์ภายในแผง Canvas
A2UI ถูกโฮสต์โดยโฮสต์CanvasของGateway และเรนเดอร์ภายในแผงCanvas เมื่อGateway โฆษณาโฮสต์Canvas แอปmacOS จะนำทางไปยังหน้าโฮสต์ A2UI โดยอัตโนมัติเมื่อเปิดครั้งแรก

URL โฮสต์ A2UI ค่าเริ่มต้น:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### คำสั่ง A2UI (v0.8)

ปัจจุบันCanvas รองรับข้อความเซิร์ฟเวอร์→ไคลเอนต์ของ **A2UI v0.8**:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) ยังไม่รองรับ

ตัวอย่าง CLI:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

การตรวจสอบด่วน:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## การทริกเกอร์การรันเอเจนต์จาก Canvas

Canvas สามารถทริกเกอร์การรันเอเจนต์ใหม่ผ่าน deep link ได้:

- `openclaw://agent?...`

ตัวอย่าง (ใน JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

แอปจะขอการยืนยัน เว้นแต่จะมีการระบุคีย์ที่ถูกต้อง

## หมายเหตุด้านความปลอดภัย

- สคีมCanvas บล็อกการไต่ไดเรกทอรี; ไฟล์ต้องอยู่ภายใต้รากของเซสชัน
- เนื้อหาCanvasในเครื่องใช้สคีมแบบกำหนดเอง (ไม่จำเป็นต้องมีเซิร์ฟเวอร์ loopback)
- URL `http(s)` ภายนอก อนุญาตเฉพาะเมื่อมีการนำทางอย่างชัดเจนเท่านั้น
