---
summary: "รันบริดจ์ACPสำหรับการผสานรวมกับIDE"
read_when:
  - การตั้งค่าการผสานรวมIDEที่ใช้ACP
  - การดีบักการกำหนดเส้นทางเซสชันACPไปยังGateway
title: "acp"
x-i18n:
  source_path: cli/acp.md
  source_hash: 0c09844297da250b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:56Z
---

# acp

รันบริดจ์ACP (Agent Client Protocol) ที่สื่อสารกับ OpenClaw Gateway

คำสั่งนี้ใช้ACPผ่าน stdio สำหรับIDE และส่งต่อพรอมป์ไปยังGateway
ผ่าน WebSocket โดยจะคงการแมปเซสชันACPกับคีย์เซสชันของGateway

## Usage

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## ACP client (debug)

ใช้ACP client ที่มีมาในตัวเพื่อตรวจสอบความถูกต้องของบริดจ์โดยไม่ต้องใช้IDE
มันจะสปอว์นบริดจ์ACPและให้คุณพิมพ์พรอมป์แบบโต้ตอบได้

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## How to use this

ใช้ACPเมื่อIDE (หรือไคลเอนต์อื่น) รองรับAgent Client Protocol และคุณต้องการให้มันควบคุมเซสชันของOpenClaw Gateway

1. ตรวจสอบให้แน่ใจว่าGatewayกำลังทำงานอยู่ (ภายในเครื่องหรือระยะไกล)
2. กำหนดค่าเป้าหมายGateway (ผ่านคอนฟิกหรือแฟล็ก)
3. ชี้ให้IDEรัน `openclaw acp` ผ่าน stdio

ตัวอย่างคอนฟิก (บันทึกถาวร):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

ตัวอย่างการรันโดยตรง (ไม่เขียนคอนฟิก):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Selecting agents

ACPไม่เลือกเอเจนต์โดยตรง แต่จะกำหนดเส้นทางตามคีย์เซสชันของGateway

ใช้คีย์เซสชันที่ผูกกับเอเจนต์เพื่อกำหนดเป้าหมายเอเจนต์เฉพาะ:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

แต่ละเซสชันACPจะถูกแมปกับคีย์เซสชันของGatewayเพียงหนึ่งค่า เอเจนต์หนึ่งตัวสามารถมีหลายเซสชันได้; ACPจะใช้ค่าเริ่มต้นเป็นเซสชัน `acp:<uuid>` แบบแยกอิสระ เว้นแต่คุณจะโอเวอร์ไรด์คีย์หรือเลเบล

## Zed editor setup

เพิ่มเอเจนต์ACPแบบกำหนดเองใน `~/.config/zed/settings.json` (หรือใช้UIการตั้งค่าของZed):

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

เพื่อกำหนดเป้าหมายGatewayหรือเอเจนต์เฉพาะ:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

ในZed ให้เปิดแผงAgentและเลือก “OpenClaw ACP” เพื่อเริ่มเธรด

## Session mapping

โดยค่าเริ่มต้น เซสชันACPจะได้รับคีย์เซสชันของGatewayแบบแยกอิสระพร้อมคำนำหน้า `acp:`
หากต้องการใช้เซสชันที่ทราบอยู่แล้ว ให้ส่งคีย์เซสชันหรือเลเบล:

- `--session <key>`: ใช้คีย์เซสชันของGatewayที่ระบุ
- `--session-label <label>`: แก้ไขเซสชันที่มีอยู่ตามเลเบล
- `--reset-session`: สร้างรหัสเซสชันใหม่สำหรับคีย์นั้น (คีย์เดิม ทรานสคริปต์ใหม่)

หากACP clientของคุณรองรับเมตาดาตา คุณสามารถโอเวอร์ไรด์เป็นรายเซสชันได้:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

เรียนรู้เพิ่มเติมเกี่ยวกับคีย์เซสชันได้ที่ [/concepts/session](/concepts/session)

## Options

- `--url <url>`: URLของGateway WebSocket (ค่าเริ่มต้นคือ gateway.remote.url เมื่อมีการกำหนดค่า)
- `--token <token>`: โทเคนยืนยันตัวตนของGateway
- `--password <password>`: รหัสผ่านยืนยันตัวตนของGateway
- `--session <key>`: คีย์เซสชันเริ่มต้น
- `--session-label <label>`: เลเบลเซสชันเริ่มต้นสำหรับการแก้ไข
- `--require-existing`: ล้มเหลวหากคีย์/เลเบลเซสชันไม่มีอยู่
- `--reset-session`: รีเซ็ตคีย์เซสชันก่อนใช้งานครั้งแรก
- `--no-prefix-cwd`: ไม่ใส่คำนำหน้าพรอมป์ด้วยไดเรกทอรีทำงาน
- `--verbose, -v`: ล็อกแบบละเอียดไปยัง stderr

### `acp client` options

- `--cwd <dir>`: ไดเรกทอรีทำงานสำหรับเซสชันACP
- `--server <command>`: คำสั่งเซิร์ฟเวอร์ACP (ค่าเริ่มต้น: `openclaw`)
- `--server-args <args...>`: อาร์กิวเมนต์เพิ่มเติมที่ส่งให้เซิร์ฟเวอร์ACP
- `--server-verbose`: เปิดใช้การล็อกแบบละเอียดบนเซิร์ฟเวอร์ACP
- `--verbose, -v`: การล็อกฝั่งไคลเอนต์แบบละเอียด
