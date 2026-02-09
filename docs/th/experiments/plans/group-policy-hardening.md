---
summary: "Telegram allowlist hardening: prefix + whitespace normalization"
read_when:
  - ทบทวนการเปลี่ยนแปลงรายการอนุญาตTelegramในอดีต
title: "การเสริมความแข็งแกร่งของรายการอนุญาตTelegram"
---

# การเสริมความแข็งแกร่งของรายการอนุญาตTelegram

**วันที่**: 2026-01-05  
**สถานะ**: เสร็จสมบูรณ์  
**PR**: #216

## สรุป

รายการอนุญาตTelegramตอนนี้ยอมรับคำนำหน้า `telegram:` และ `tg:` โดยไม่คำนึงถึงตัวพิมพ์เล็กใหญ่ และทนต่อช่องว่างที่เกิดขึ้นโดยไม่ตั้งใจ การเปลี่ยนแปลงนี้ทำให้การตรวจสอบรายการอนุญาตขาเข้ามีความสอดคล้องกับการทำให้เป็นมาตรฐานของการส่งข้อความขาออก This aligns inbound allowlist checks with outbound send normalization.

## สิ่งที่เปลี่ยนแปลง

- คำนำหน้า `telegram:` และ `tg:` ถูกปฏิบัติเทียบเท่ากัน(ไม่คำนึงถึงตัวพิมพ์เล็กใหญ่)
- รายการในรายการอนุญาตจะถูกตัดช่องว่าง และรายการที่ว่างจะถูกละเว้น

## ตัวอย่าง

ทั้งหมดต่อไปนี้ได้รับการยอมรับว่าเป็นIDเดียวกัน:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## เหตุใดจึงสำคัญ

Copy/paste from logs or chat IDs often includes prefixes and whitespace. Normalizing avoids
false negatives when deciding whether to respond in DMs or groups.

## เอกสารที่เกี่ยวข้อง

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
