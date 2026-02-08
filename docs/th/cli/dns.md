---
summary: "เอกสารอ้างอิงCLIสำหรับ`openclaw dns`(ตัวช่วยDiscoveryแบบเครือข่ายกว้าง)"
read_when:
  - คุณต้องการDiscoveryแบบเครือข่ายกว้าง(DNS-SD)ผ่านTailscale+CoreDNS
  - คุณกำลังตั้งค่าsplit DNSสำหรับโดเมนDiscoveryแบบกำหนดเอง(ตัวอย่าง: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:54Z
---

# `openclaw dns`

ตัวช่วยDNSสำหรับDiscoveryแบบเครือข่ายกว้าง(Tailscale+CoreDNS)ปัจจุบันมุ่งเน้นที่macOS+Homebrew CoreDNS

เกี่ยวข้อง:

- Gateway discovery: [Discovery(การค้นหาอัตโนมัติ)](/gateway/discovery)
- คอนฟิกDiscoveryแบบเครือข่ายกว้าง: [การกำหนดค่า](/gateway/configuration)

## การตั้งค่า

```bash
openclaw dns setup
openclaw dns setup --apply
```
