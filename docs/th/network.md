---
summary: "ฮับเครือข่าย: พื้นผิวGateway, การจับคู่, Discoveryและความปลอดภัย"
read_when:
  - คุณต้องการภาพรวมสถาปัตยกรรมเครือข่ายและความปลอดภัย
  - คุณกำลังแก้ไขปัญหาการเข้าถึงแบบlocalเทียบกับtailnetหรือการจับคู่
  - คุณต้องการรายการเอกสารเครือข่ายอย่างเป็นทางการ
title: "เครือข่าย"
---

# ฮับเครือข่าย

ฮับนี้เชื่อมโยงเอกสารหลักเกี่ยวกับวิธีที่ OpenClaw เชื่อมต่อ จับคู่ และรักษาความปลอดภัย
อุปกรณ์ผ่าน localhost, LAN และ tailnet

## โมเดลหลัก

- [สถาปัตยกรรมGateway](/concepts/architecture)
- [โปรโตคอลGateway](/gateway/protocol)
- [คู่มือปฏิบัติการGateway](/gateway)
- [พื้นผิวเว็บ + โหมดการ bind](/web)

## การจับคู่ + อัตลักษณ์

- [ภาพรวมการจับคู่(DM + โหนด)](/channels/pairing)
- [การจับคู่โหนดที่เป็นเจ้าของโดยGateway](/gateway/pairing)
- [Devices CLI (การจับคู่ + การหมุนเวียนโทเคน)](/cli/devices)
- [Pairing CLI (การอนุมัติDM)](/cli/pairing)

8. ความเชื่อถือภายในเครื่อง:

- การเชื่อมต่อภายในเครื่อง(loopbackหรือที่อยู่ tailnet ของโฮสต์Gatewayเอง)สามารถอนุมัติการจับคู่โดยอัตโนมัติเพื่อให้ประสบการณ์ใช้งานบนโฮสต์เดียวกันราบรื่น
- ไคลเอนต์ tailnet/LAN ที่ไม่ใช่ local ยังต้องการการอนุมัติการจับคู่แบบชัดเจน

## Discovery + ทรานสปอร์ต

- [Discoveryและทรานสปอร์ต](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [การเข้าถึงระยะไกล(SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## โหนด + ทรานสปอร์ต

- [ภาพรวมโหนด](/nodes)
- [โปรโตคอล Bridge (โหนดรุ่นเดิม)](/gateway/bridge-protocol)
- [คู่มือปฏิบัติการโหนด: iOS](/platforms/ios)
- [คู่มือปฏัติการโหนด: Android](/platforms/android)

## ความปลอดภัย

- [ภาพรวมความปลอดภัย](/gateway/security)
- [เอกสารอ้างอิงคอนฟิกGateway](/gateway/configuration)
- [การแก้ไขปัญหา](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
