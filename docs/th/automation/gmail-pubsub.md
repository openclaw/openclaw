---
summary: "การเชื่อมต่อ Gmail Pub/Sub push เข้ากับเว็บฮุคของ OpenClaw ผ่าน gogcli"
read_when:
  - การเชื่อมทริกเกอร์กล่องจดหมาย Gmail เข้ากับ OpenClaw
  - การตั้งค่า Pub/Sub push สำหรับปลุกเอเจนต์
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

เป้าหมาย: Gmail watch -> Pub/Sub push -> `gog gmail watch serve` -> เว็บฮุคของ OpenClaw

## Prereqs

- ติดตั้งและล็อกอิน `gcloud` แล้ว ([คู่มือการติดตั้ง](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- ติดตั้งและอนุญาต `gog` (gogcli) สำหรับบัญชี Gmail ([gogcli.sh](https://gogcli.sh/)).
- เปิดใช้งาน OpenClaw hooks (ดู [Webhooks](/automation/webhook)).
- ล็อกอิน `tailscale` แล้ว ([tailscale.com](https://tailscale.com/)). การตั้งค่าที่รองรับใช้ Tailscale Funnel สำหรับเอ็นด์พอยต์ HTTPS สาธารณะ
  บริการอุโมงค์อื่นสามารถใช้ได้ แต่เป็นแบบ DIY/ไม่รองรับ และต้องเดินสายเองด้วยตนเอง
  ปัจจุบันเรารองรับเฉพาะ Tailscale
  Other tunnel services can work, but are DIY/unsupported and require manual wiring.
  Right now, Tailscale is what we support.

ตัวอย่างคอนฟิกของ hook (เปิดใช้การแมป preset สำหรับ Gmail):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

หากต้องการส่งสรุปจาก Gmail ไปยังพื้นผิวแชต ให้ override preset ด้วยการแมป
ที่ตั้งค่า `deliver` + ตัวเลือกเสริม `channel`/`to`:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

If you want a fixed channel, set `channel` + `to`. หากต้องการช่องทางคงที่ ให้ตั้งค่า `channel` + `to` มิฉะนั้น `channel: "last"`
จะใช้เส้นทางการส่งล่าสุด (สำรองไปที่ WhatsApp)

หากต้องการบังคับใช้โมเดลที่ประหยัดกว่าสำหรับการรันจาก Gmail ให้ตั้งค่า `model` ในการแมป
(`provider/model` หรือ alias) หากคุณบังคับใช้ `agents.defaults.models` ให้รวมไว้ที่นั่นด้วย If you enforce `agents.defaults.models`, include it there.

หากต้องการตั้งค่าโมเดลเริ่มต้นและระดับการคิดเฉพาะสำหรับ Gmail hooks ให้เพิ่ม
`hooks.gmail.model` / `hooks.gmail.thinking` ในคอนฟิกของคุณ:

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

หมายเหตุ:

- ค่า `model`/`thinking` ต่อ hook ในการแมปจะยังคง override ค่าเริ่มต้นเหล่านี้
- ลำดับ fallback: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → หลัก (auth/rate-limit/timeouts)
- หากตั้งค่า `agents.defaults.models` โมเดล Gmail ต้องอยู่ใน allowlist
- เนื้อหา hook ของ Gmail จะถูกครอบด้วยขอบเขตความปลอดภัยของเนื้อหาภายนอกเป็นค่าเริ่มต้น
  หากต้องการปิด (อันตราย) ให้ตั้งค่า `hooks.gmail.allowUnsafeExternalContent: true`
  To disable (dangerous), set `hooks.gmail.allowUnsafeExternalContent: true`.

หากต้องการปรับแต่งการจัดการ payload เพิ่มเติม ให้เพิ่ม `hooks.mappings` หรือโมดูลแปลง JS/TS
ภายใต้ `hooks.transformsDir` (ดู [Webhooks](/automation/webhook))

## Wizard (recommended)

ใช้ตัวช่วยของ OpenClaw เพื่อเชื่อมทุกอย่างเข้าด้วยกัน (ติดตั้ง dependencies บน macOS ผ่าน brew):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

ค่าเริ่มต้น:

- ใช้ Tailscale Funnel สำหรับเอ็นด์พอยต์ push สาธารณะ
- เขียนคอนฟิก `hooks.gmail` สำหรับ `openclaw webhooks gmail run`
- เปิดใช้ preset ของ Gmail hook (`hooks.presets: ["gmail"]`)

หมายเหตุเกี่ยวกับพาธ: เมื่อเปิดใช้งาน `tailscale.mode` แล้ว OpenClaw จะตั้งค่า
`hooks.gmail.serve.path` เป็น `/` โดยอัตโนมัติ และคงพาธสาธารณะไว้ที่
`hooks.gmail.tailscale.path` (ค่าเริ่มต้น `/gmail-pubsub`) เนื่องจาก Tailscale
จะตัด prefix ของ set-path ออกก่อนทำ proxy
หากต้องการให้แบ็กเอนด์รับพาธที่มี prefix ให้ตั้งค่า
`hooks.gmail.tailscale.target` (หรือ `--tailscale-target`) เป็น URL เต็ม เช่น
`http://127.0.0.1:8788/gmail-pubsub` และให้ตรงกับ `hooks.gmail.serve.path`
If you need the backend to receive the prefixed path, set
`hooks.gmail.tailscale.target` (or `--tailscale-target`) to a full URL like
`http://127.0.0.1:8788/gmail-pubsub` and match `hooks.gmail.serve.path`.

ต้องการเอ็นด์พอยต์แบบกำหนดเองหรือไม่? ใช้ `--push-endpoint <url>` หรือ `--tailscale off`

หมายเหตุแพลตฟอร์ม: บน macOS ตัวช่วยจะติดตั้ง `gcloud`, `gogcli` และ `tailscale`
ผ่าน Homebrew; บน Linux ให้ติดตั้งด้วยตนเองก่อน

การเริ่ม Gateway อัตโนมัติ (แนะนำ):

- เมื่อกำหนด `hooks.enabled=true` และ `hooks.gmail.account` แล้ว Gateway จะเริ่ม
  `gog gmail watch serve` ตอนบูตและต่ออายุ watch อัตโนมัติ
- ตั้งค่า `OPENCLAW_SKIP_GMAIL_WATCHER=1` เพื่อยกเลิก (มีประโยชน์หากคุณรันเดมอนเอง)
- อย่ารันเดมอนแบบแมนนวลพร้อมกัน มิฉะนั้นจะเกิด
  `listen tcp 127.0.0.1:8788: bind: address already in use`

เดมอนแบบแมนนวล (เริ่ม `gog gmail watch serve` + ต่ออายุอัตโนมัติ):

```bash
openclaw webhooks gmail run
```

## การตั้งค่าแบบครั้งเดียว

1. เลือกโปรเจ็กต์ GCP **ที่เป็นเจ้าของ OAuth client** ที่ใช้โดย `gog`

```bash
gcloud auth login
gcloud config set project <project-id>
```

หมายเหตุ: Gmail watch ต้องให้หัวข้อ Pub/Sub อยู่ในโปรเจ็กต์เดียวกับ OAuth client

2. เปิดใช้งาน APIs:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. สร้างหัวข้อ:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. อนุญาตให้ Gmail push ทำการ publish:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## เริ่ม watch

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

บันทึกค่า `history_id` จากเอาต์พุต (สำหรับการดีบัก)

## รันตัวจัดการ push

ตัวอย่างแบบโลคัล (การยืนยันตัวตนด้วยโทเคนที่แชร์):

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

หมายเหตุ:

- `--token` ปกป้องเอ็นด์พอยต์ push (`x-gog-token` หรือ `?token=`)
- `--hook-url` ชี้ไปที่ OpenClaw `/hooks/gmail` (มีการแมป; รันแบบแยก + ส่งสรุปไปยังหลัก)
- `--include-body` และ `--max-bytes` ควบคุมสไนเพ็ตของบอดีที่ส่งไปยัง OpenClaw

แนะนำ: `openclaw webhooks gmail run` ครอบโฟลว์เดียวกันและต่ออายุ watch อัตโนมัติ

## เปิดเผยตัวจัดการ (ขั้นสูง, ไม่รองรับ)

หากต้องการอุโมงค์ที่ไม่ใช่ Tailscale ให้เดินสายเองและใช้ URL สาธารณะใน push
subscription (ไม่รองรับ, ไม่มีการ์ดเรล):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

ใช้ URL ที่สร้างขึ้นเป็นเอ็นด์พอยต์ push:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

สำหรับโปรดักชัน: ใช้เอ็นด์พอยต์ HTTPS ที่เสถียรและกำหนดค่า Pub/Sub OIDC JWT จากนั้นรัน:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## ทดสอบ

ส่งข้อความไปยังกล่องจดหมายที่ถูก watch:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

ตรวจสอบสถานะ watch และประวัติ:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## การแก้ไขปัญหา

- `Invalid topicName`: โปรเจ็กต์ไม่ตรงกัน (หัวข้อไม่อยู่ในโปรเจ็กต์ของ OAuth client)
- `User not authorized`: ขาด `roles/pubsub.publisher` บนหัวข้อ
- ข้อความว่าง: Gmail push ให้เพียง `historyId`; ให้ดึงผ่าน `gog gmail history`

## การล้างค่า

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
