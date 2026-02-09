---
summary: "เอกสารอ้างอิงCLIสำหรับ`openclaw dns`(ตัวช่วยDiscoveryแบบเครือข่ายกว้าง)"
read_when:
  - คุณต้องการDiscoveryแบบเครือข่ายกว้าง(DNS-SD)ผ่านTailscale+CoreDNS
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
---

# `openclaw dns`

ตัวช่วย DNS สำหรับการค้นหาในเครือข่ายกว้าง (Tailscale + CoreDNS). ตัวช่วยDNSสำหรับDiscoveryแบบเครือข่ายกว้าง(Tailscale+CoreDNS)ปัจจุบันมุ่งเน้นที่macOS+Homebrew CoreDNS

เกี่ยวข้อง:

- Gateway discovery: [Discovery(การค้นหาอัตโนมัติ)](/gateway/discovery)
- คอนฟิกDiscoveryแบบเครือข่ายกว้าง: [การกำหนดค่า](/gateway/configuration)

## การตั้งค่า

```bash
openclaw dns setup
openclaw dns setup --apply
```
