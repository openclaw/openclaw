---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw plugins` (แสดงรายการ, ติดตั้ง, เปิดใช้งาน/ปิดใช้งาน, ตรวจสอบ)"
read_when:
  - คุณต้องการติดตั้งหรือจัดการปลั๊กอินGatewayแบบทำงานภายในโปรเซส
  - คุณต้องการดีบักความล้มเหลวในการโหลดปลั๊กอิน
title: "plugins"
x-i18n:
  source_path: cli/plugins.md
  source_hash: 60476e0a9b7247bd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:59Z
---

# `openclaw plugins`

จัดการปลั๊กอิน/ส่วนขยายของGateway（เกตเวย์）(โหลดแบบทำงานภายในโปรเซส)

ที่เกี่ยวข้อง:

- ระบบปลั๊กอิน: [Plugins](/tools/plugin)
- แมนิฟেস্টปลั๊กอิน+สคีมา: [Plugin manifest](/plugins/manifest)
- การเสริมความแข็งแกร่งด้านความปลอดภัย: [Security](/gateway/security)

## Commands

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

ปลั๊กอินที่มากับOpenClawจะถูกปิดใช้งานไว้ก่อน ใช้ `plugins enable` เพื่อ
เปิดใช้งาน

ปลั๊กอินทั้งหมดต้องมีไฟล์ `openclaw.plugin.json` พร้อม JSON Schema แบบฝังในตัว
(`configSchema` แม้จะว่างเปล่าก็ตาม) หากแมนิฟেস্টหรือสคีมาขาดหาย/ไม่ถูกต้อง
ปลั๊กอินจะไม่สามารถโหลดได้และการตรวจสอบคอนฟิกจะล้มเหลว

### Install

```bash
openclaw plugins install <path-or-spec>
```

หมายเหตุด้านความปลอดภัย: ปฏิบัติต่อการติดตั้งปลั๊กอินเหมือนการรันโค้ด แนะนำให้ใช้เวอร์ชันที่ปักหมุดไว้

อาร์ไคฟ์ที่รองรับ: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

ใช้ `--link` เพื่อหลีกเลี่ยงการคัดลอกไดเรกทอรีภายในเครื่อง (จะเพิ่มไปยัง `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

### Update

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

การอัปเดตจะมีผลเฉพาะปลั๊กอินที่ติดตั้งจาก npm เท่านั้น (ติดตามอยู่ใน `plugins.installs`).
