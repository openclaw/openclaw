---
summary: "เสริมความแข็งแกร่งการจัดการอินพุตของ cron.add ปรับสคีมาให้สอดคล้อง และปรับปรุงเครื่องมือ cron ของ UI/เอเจนต์"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "การเสริมความแข็งแกร่งของ Cron Add"
---

# การเสริมความแข็งแกร่งของ Cron Add และการปรับสคีมาให้สอดคล้อง

## บริบท

Recent gateway logs show repeated `cron.add` failures with invalid parameters (missing `sessionTarget`, `wakeMode`, `payload`, and malformed `schedule`). This indicates that at least one client (likely the agent tool call path) is sending wrapped or partially specified job payloads. Separately, there is drift between cron provider enums in TypeScript, gateway schema, CLI flags, and UI form types, plus a UI mismatch for `cron.status` (expects `jobCount` while gateway returns `jobs`).

## เป้าหมาย

- หยุดสแปม INVALID_REQUEST ของ `cron.add` โดยทำให้เพย์โหลดที่ถูกห่อทั่วไปเป็นรูปแบบปกติและอนุมานฟิลด์ `kind` ที่ขาดหาย
- ทำให้รายการผู้ให้บริการ cron สอดคล้องกันในสคีมาของ Gateway（เกตเวย์）, ชนิด cron, เอกสาร CLI และฟอร์ม UI
- ทำให้สคีมาเครื่องมือ cron ของเอเจนต์ชัดเจน เพื่อให้ LLM สร้างเพย์โหลดงานที่ถูกต้อง
- แก้ไขการแสดงผลจำนวนงานสถานะ cron ใน Control UI
- เพิ่มการทดสอบเพื่อครอบคลุมการทำให้เป็นรูปแบบปกติและพฤติกรรมของเครื่องมือ

## Non-goals

- เปลี่ยนความหมายการตั้งเวลา cron หรือพฤติกรรมการรันงาน
- เพิ่มชนิดตารางเวลาใหม่หรือการพาร์ส cron expression
- ปรับโฉม UI/UX ของ cron เกินกว่าการแก้ไขฟิลด์ที่จำเป็น

## ผลการค้นพบ (ช่องว่างปัจจุบัน)

- `CronPayloadSchema` ใน Gateway（เกตเวย์）ไม่รวม `signal` + `imessage` ขณะที่ชนิด TS รวมไว้
- CronStatus ของ Control UI คาดหวัง `jobCount` แต่ Gateway（เกตเวย์）ส่งกลับ `jobs`
- สคีมาเครื่องมือ cron ของเอเจนต์อนุญาตอ็อบเจ็กต์ `job` ใดๆ ทำให้เกิดอินพุตที่ผิดรูปแบบได้
- Gateway（เกตเวย์）ตรวจสอบ `cron.add` อย่างเคร่งครัดโดยไม่มีการทำให้เป็นรูปแบบปกติ จึงทำให้เพย์โหลดที่ถูกห่อล้มเหลว

## สิ่งที่เปลี่ยนไป

- `cron.add` และ `cron.update` ทำการทำให้รูปแบบการห่อทั่วไปเป็นรูปแบบปกติและอนุมานฟิลด์ `kind` ที่ขาดหาย
- สคีมาเครื่องมือ cron ของเอเจนต์ตรงกับสคีมาของ Gateway（เกตเวย์） ซึ่งช่วยลดเพย์โหลดที่ไม่ถูกต้อง
- enum ของผู้ให้บริการถูกทำให้สอดคล้องกันทั่วทั้ง Gateway（เกตเวย์）, CLI, UI และตัวเลือกบน macOS
- Control UI ใช้ฟิลด์นับ `jobs` ของ Gateway（เกตเวย์）สำหรับสถานะ

## พฤติกรรมปัจจุบัน

- **การทำให้เป็นรูปแบบปกติ:** เพย์โหลด `data`/`job` ที่ถูกห่อจะถูกแกะออก; `schedule.kind` และ `payload.kind` จะถูกอนุมานเมื่อปลอดภัย
- **ค่าเริ่มต้น:** ใช้ค่าเริ่มต้นที่ปลอดภัยสำหรับ `wakeMode` และ `sessionTarget` เมื่อขาดหาย
- **ผู้ให้บริการ:** Discord/Slack/Signal/iMessage แสดงอย่างสอดคล้องกันทั่วทั้ง CLI/UI

ดู [Cron jobs](/automation/cron-jobs) สำหรับรูปแบบที่ทำให้เป็นปกติและตัวอย่าง

## การยืนยันผล

- เฝ้าดูบันทึกล็อกของ Gateway（เกตเวย์）เพื่อยืนยันว่าข้อผิดพลาด INVALID_REQUEST ของ `cron.add` ลดลง
- ยืนยันว่า Control UI แสดงจำนวนงานสถานะ cron หลังรีเฟรช

## Optional Follow-ups

- ทดสอบ Control UI แบบ smoke ด้วยตนเอง: เพิ่มงาน cron ต่อผู้ให้บริการหนึ่งรายการ + ตรวจสอบจำนวนงานสถานะ

## คำถามที่เปิดอยู่

- ควรให้ `cron.add` ยอมรับ `state` แบบระบุชัดจากไคลเอนต์หรือไม่ (ปัจจุบันไม่อนุญาตโดยสคีมา)?
- ควรอนุญาต `webchat` เป็นผู้ให้บริการการส่งมอบแบบระบุชัดหรือไม่ (ปัจจุบันถูกกรองในขั้นตอนการแก้ไขการส่งมอบ)?
