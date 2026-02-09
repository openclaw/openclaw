---
summary: "ปลั๊กอิน/ส่วนขยายของOpenClaw: การค้นหา การกำหนดค่า และความปลอดภัย"
read_when:
  - การเพิ่มหรือแก้ไขปลั๊กอิน/ส่วนขยาย
  - การจัดทำเอกสารกฎการติดตั้งหรือการโหลดปลั๊กอิน
title: "ปลั๊กอิน"
---

# ปลั๊กอิน(ส่วนขยาย)

## เริ่มต้นอย่างรวดเร็ว(ใหม่กับปลั๊กอิน?)

ปลั๊กอินคือ **โมดูลโค้ดขนาดเล็ก** ที่ขยายความสามารถของOpenClawด้วยฟีเจอร์เพิ่มเติม
(คำสั่ง เครื่องมือ และGatewayRPC)

โดยส่วนใหญ่คุณจะใช้ปลั๊กอินเมื่อคุณต้องการฟีเจอร์ที่ยังไม่ถูกรวมไว้ในOpenClawแกนหลัก
(หรือคุณต้องการแยกฟีเจอร์เสริมออกจากการติดตั้งหลัก)

ทางลัด:

1. ดูว่ามีอะไรถูกโหลดอยู่แล้ว:

```bash
openclaw plugins list
```

2. ติดตั้งปลั๊กอินทางการ(ตัวอย่าง: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. รีสตาร์ตGateway（เกตเวย์） จากนั้นกำหนดค่าภายใต้ `plugins.entries.<id>.config`.

ดู [Voice Call](/plugins/voice-call) เพื่อเป็นตัวอย่างปลั๊กอินแบบเป็นรูปธรรม

## ปลั๊กอินที่มีให้ใช้งาน(ทางการ)

- Microsoft Teams เป็นแบบปลั๊กอินเท่านั้นตั้งแต่ 2026.1.15; ติดตั้ง `@openclaw/msteams` หากคุณใช้ Teams
- Memory(Core) — ปลั๊กอินค้นหาหน่วยความจำที่มาพร้อมแพ็กเกจ(เปิดใช้งานเป็นค่าเริ่มต้นผ่าน `plugins.slots.memory`)
- Memory(LanceDB) — ปลั๊กอินหน่วยความจำระยะยาวที่มาพร้อมแพ็กเกจ(เรียกคืน/บันทึกอัตโนมัติ; ตั้งค่า `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth(การยืนยันตัวตนผู้ให้บริการ) — มาพร้อมแพ็กเกจเป็น `google-antigravity-auth`(ปิดใช้งานเป็นค่าเริ่มต้น)
- Gemini CLI OAuth(การยืนยันตัวตนผู้ให้บริการ) — มาพร้อมแพ็กเกจเป็น `google-gemini-cli-auth`(ปิดใช้งานเป็นค่าเริ่มต้น)
- Qwen OAuth(การยืนยันตัวตนผู้ให้บริการ) — มาพร้อมแพ็กเกจเป็น `qwen-portal-auth`(ปิดใช้งานเป็นค่าเริ่มต้น)
- Copilot Proxy(การยืนยันตัวตนผู้ให้บริการ) — บริดจ์ Copilot Proxy ของ VS Code แบบโลคัล; แยกจากการล็อกอินอุปกรณ์ `github-copilot` ที่มีมาในตัว(มาพร้อมแพ็กเกจ ปิดใช้งานเป็นค่าเริ่มต้น)

ปลั๊กอินของOpenClawเป็น **โมดูลTypeScript** ที่โหลดขณะรันผ่าน jiti **การตรวจสอบคอนฟิกจะไม่รันโค้ดปลั๊กอิน**; จะใช้ไฟล์แมนิฟेस्टของปลั๊กอินและJSON Schemaแทน ดู [Plugin manifest](/plugins/manifest) **การตรวจสอบความถูกต้องของคอนฟิกจะไม่รันโค้ดของปลั๊กอิน**; แต่จะใช้ plugin manifest และ JSON Schema แทน ดูที่ [Plugin manifest](/plugins/manifest)

ปลั๊กอินสามารถลงทะเบียนได้:

- เมธอดGatewayRPC
- แฮนด์เลอร์GatewayHTTP
- เครื่องมือเอเจนต์
- คำสั่งCLI
- บริการเบื้องหลัง
- การตรวจสอบคอนฟิก (ไม่บังคับ)
- **Skills** (โดยระบุไดเรกทอรี `skills` ในแมนิฟেস্টของปลั๊กอิน)
- **คำสั่งตอบกลับอัตโนมัติ** (รันโดยไม่เรียกเอเจนต์AI)

ปลั๊กอินรัน **ในโปรเซสเดียว** กับGateway（เกตเวย์） ดังนั้นควรมองว่าเป็นโค้ดที่เชื่อถือได้
คู่มือการเขียนเครื่องมือ: [Plugin agent tools](/plugins/agent-tools)
คู่มือการเขียนเครื่องมือ: [Plugin agent tools](/plugins/agent-tools)

## ตัวช่วยขณะรันไทม์

ปลั๊กอินสามารถเข้าถึงตัวช่วยแกนหลักที่คัดเลือกแล้วผ่าน `api.runtime`. สำหรับTTSด้านโทรศัพท์:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

หมายเหตุ:

- ใช้คอนฟิก `messages.tts` ของแกนหลัก(OpenAI หรือ ElevenLabs)
- คืนค่าเป็นบัฟเฟอร์เสียงPCM + อัตราการสุ่มตัวอย่าง ปลั๊กอินต้องรีแซมเปิล/เข้ารหัสให้ผู้ให้บริการ ปลั๊กอินต้องทำการ resample/encode สำหรับผู้ให้บริการ
- ไม่รองรับ Edge TTS สำหรับงานโทรศัพท์

## การค้นหาและลำดับความสำคัญ

OpenClawจะสแกนตามลำดับ:

1. เส้นทางคอนฟิก

- `plugins.load.paths`(ไฟล์หรือไดเรกทอรี)

2. ส่วนขยายเวิร์กสเปซ

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. ส่วนขยายส่วนกลาง

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. ส่วนขยายที่มาพร้อมแพ็กเกจ(ส่งมากับOpenClaw, **ปิดใช้งานเป็นค่าเริ่มต้น**)

- `<openclaw>/extensions/*`

ปลั๊กอินที่มาพร้อมแพ็กเกจต้องเปิดใช้งานอย่างชัดเจนผ่าน `plugins.entries.<id>.enabled`
หรือ `openclaw plugins enable <id>`. ปลั๊กอินที่ติดตั้งแล้วจะเปิดใช้งานเป็นค่าเริ่มต้น
แต่สามารถปิดได้ด้วยวิธีเดียวกัน

ปลั๊กอินแต่ละตัวต้องมีไฟล์ `openclaw.plugin.json` อยู่ที่ราก หากเส้นทางชี้ไปที่ไฟล์
รากของปลั๊กอินคือไดเรกทอรีของไฟล์นั้นและต้องมีแมนิฟেস্ট หากพาธชี้ไปที่ไฟล์ รากของปลั๊กอินคือไดเรกทอรีของไฟล์นั้น และต้องมี manifest อยู่ภายใน

หากมีหลายปลั๊กอินที่ได้idเดียวกัน ตัวที่พบก่อนตามลำดับข้างต้นจะชนะ
และสำเนาที่มีลำดับความสำคัญต่ำกว่าจะถูกละเว้น

### แพ็กเกจแพ็ก

ไดเรกทอรีปลั๊กอินอาจมี `package.json` พร้อม `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

แต่ละรายการจะกลายเป็นปลั๊กอินหนึ่งตัว แต่ละรายการจะกลายเป็นปลั๊กอิน หากแพ็กระบุส่วนขยายหลายรายการ idของปลั๊กอิน
จะเป็น `name/<fileBase>`.

หากปลั๊กอินของคุณนำเข้าdepsจากnpm ให้ติดตั้งไว้ในไดเรกทอรีนั้นเพื่อให้
`node_modules` ใช้งานได้ (`npm install` / `pnpm install`).

### เมทาดาทาแคตตาล็อกช่องทาง

ปลั๊กอินช่องทางสามารถโฆษณาเมทาดาทาการเริ่มต้นใช้งานผ่าน `openclaw.channel` และ
คำแนะนำการติดตั้งผ่าน `openclaw.install`. วิธีนี้ทำให้แกนหลักไม่ต้องเก็บข้อมูลแคตตาล็อก

ตัวอย่าง:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

OpenClawยังสามารถผสาน **แคตตาล็อกช่องทางภายนอก** ได้(เช่น เอ็กซ์พอร์ตจากรีจิสทรีMPM)
วางไฟล์JSONไว้ที่หนึ่งในตำแหน่ง: วางไฟล์ JSON ไว้ที่หนึ่งในตำแหน่งต่อไปนี้:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

หรือชี้ `OPENCLAW_PLUGIN_CATALOG_PATHS`(หรือ `OPENCLAW_MPM_CATALOG_PATHS`) ไปที่
ไฟล์JSONหนึ่งไฟล์หรือมากกว่า(คั่นด้วยคอมมา/เซมิโคลอน/`PATH`). แต่ละไฟล์ควร
มี `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## IDของปลั๊กอิน

idเริ่มต้นของปลั๊กอิน:

- แพ็กเกจแพ็ก: `package.json` `name`
- ไฟล์เดี่ยว: ชื่อฐานของไฟล์(`~/.../voice-call.ts` → `voice-call`)

หากปลั๊กอินเอ็กซ์พอร์ต `id` OpenClawจะใช้ค่าเหล่านั้นแต่จะเตือนเมื่อไม่ตรงกับ
idที่กำหนดค่าไว้

## คอนฟิก

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

ฟิลด์:

- `enabled`: สวิตช์หลัก(ค่าเริ่มต้น: true)
- `allow`: allowlist(ไม่บังคับ)
- `deny`: denylist(ไม่บังคับ; denyมีสิทธิ์เหนือกว่า)
- `load.paths`: ไฟล์/ไดเรกทอรีปลั๊กอินเพิ่มเติม
- `entries.<id>`: สวิตช์ต่อปลั๊กอิน + คอนฟิก

การเปลี่ยนคอนฟิก **ต้องรีสตาร์ตGateway（เกตเวย์）**.

กฎการตรวจสอบ(เข้มงวด):

- idปลั๊กอินที่ไม่รู้จักใน `entries`, `allow`, `deny`, หรือ `slots` เป็น **ข้อผิดพลาด**.
- คีย์ `channels.<id>` ที่ไม่รู้จักเป็น **ข้อผิดพลาด** เว้นแต่แมนิฟেস্টของปลั๊กอินจะประกาศ
  idของช่องทาง
- คอนฟิกของปลั๊กอินถูกตรวจสอบด้วยJSON Schemaที่ฝังอยู่ใน
  `openclaw.plugin.json`(`configSchema`).
- หากปลั๊กอินถูกปิดใช้งาน คอนฟิกจะถูกเก็บไว้และจะมี **คำเตือน**.

## สล็อตปลั๊กอิน(หมวดหมู่แบบเอกสิทธิ์)

หมวดหมู่ปลั๊กอินบางประเภทเป็นแบบ **เอกสิทธิ์**(เปิดใช้งานได้ครั้งละหนึ่ง) ใช้
`plugins.slots` เพื่อเลือกว่าปลั๊กอินใดเป็นเจ้าของสล็อต: ใช้ `plugins.slots` เพื่อเลือกว่าปลั๊กอินใดเป็นเจ้าของสล็อต:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

หากมีหลายปลั๊กอินประกาศ `kind: "memory"` จะโหลดเฉพาะตัวที่ถูกเลือก ตัวอื่นจะถูกปิดใช้งาน
พร้อมการวินิจฉัย ตัวอื่น ๆ จะถูกปิดใช้งานพร้อมการวินิจฉัย

## Control UI(schema + ป้ายกำกับ)

Control UIใช้ `config.schema`(JSON Schema + `uiHints`) เพื่อเรนเดอร์ฟอร์มที่ดีขึ้น

OpenClawจะเสริม `uiHints` ขณะรันไทม์ตามปลั๊กอินที่ค้นพบ:

- เพิ่มป้ายกำกับต่อปลั๊กอินสำหรับ `plugins.entries.<id>` / `.enabled` / `.config`
- ผสานคำใบ้ฟิลด์คอนฟิกที่ปลั๊กอินให้มาแบบไม่บังคับภายใต้:
  `plugins.entries.<id>.config.<field>`

หากคุณต้องการให้ฟิลด์คอนฟิกของปลั๊กอินแสดงป้ายกำกับ/placeholderที่ดี(และทำเครื่องหมายความลับเป็นข้อมูลอ่อนไหว)
ให้จัดเตรียม `uiHints` ควบคู่กับJSON Schemaในแมนิฟেস্টของปลั๊กอิน

ตัวอย่าง:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` ใช้งานได้เฉพาะการติดตั้งnpmที่ถูกติดตามภายใต้ `plugins.installs`.

ปลั๊กอินยังสามารถลงทะเบียนคำสั่งระดับบนของตนเองได้(ตัวอย่าง: `openclaw voicecall`).

## Plugin API(ภาพรวม)

ปลั๊กอินเอ็กซ์พอร์ตอย่างใดอย่างหนึ่ง:

- ฟังก์ชัน: `(api) => { ... }`
- อ็อบเจ็กต์: `{ id, name, configSchema, register(api) { ... } }`

## ฮุคของปลั๊กอิน

ปลั๊กอินสามารถส่ง hook มาและลงทะเบียนได้ในขณะรันไทม์ ปลั๊กอินสามารถบรรจุฮุคและลงทะเบียนขณะรันไทม์ได้ วิธีนี้ทำให้ปลั๊กอินรวมระบบอัตโนมัติแบบขับเคลื่อนด้วยอีเวนต์โดยไม่ต้องติดตั้งแพ็กฮุคแยกต่างหาก

### ตัวอย่าง

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

หมายเหตุ:

- ไดเรกทอรีฮุคเป็นไปตามโครงสร้างฮุคปกติ(`HOOK.md` + `handler.ts`).
- กฎคุณสมบัติของฮุคยังคงมีผล(ข้อกำหนดOS/bin/env/config).
- ฮุคที่ปลั๊กอินจัดการจะแสดงใน `openclaw hooks list` พร้อม `plugin:<id>`.
- คุณไม่สามารถเปิด/ปิดฮุคที่ปลั๊กอินจัดการผ่าน `openclaw hooks`; ให้เปิด/ปิดปลั๊กอินแทน

## ปลั๊กอินผู้ให้บริการ(การยืนยันตัวตนโมเดล)

ปลั๊กอินสามารถลงทะเบียนโฟลว์ **การยืนยันตัวตนผู้ให้บริการโมเดล** เพื่อให้ผู้ใช้รันOAuthหรือการตั้งค่าAPI-keyภายในOpenClawได้(ไม่ต้องใช้สคริปต์ภายนอก)

ลงทะเบียนผู้ให้บริการผ่าน `api.registerProvider(...)`. ผู้ให้บริการแต่ละรายเปิดเผยวิธีการยืนยันตัวตนหนึ่งอย่างหรือมากกว่า(OAuth, API key, device code ฯลฯ) วิธีเหล่านี้ขับเคลื่อน: เมธอดเหล่านี้ขับเคลื่อน:

- `openclaw models auth login --provider <id> [--method <id>]`

ตัวอย่าง:

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // Run OAuth flow and return auth profiles.
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
});
```

หมายเหตุ:

- `run` รับ `ProviderAuthContext` ที่มีตัวช่วย `prompter`, `runtime`,
  `openUrl`, และ `oauth.createVpsAwareHandlers`.
- คืนค่า `configPatch` เมื่อคุณต้องเพิ่มโมเดลเริ่มต้นหรือคอนฟิกผู้ให้บริการ
- คืนค่า `defaultModel` เพื่อให้ `--set-default` อัปเดตค่าเริ่มต้นของเอเจนต์

### ลงทะเบียนช่องทางข้อความ

ปลั๊กอินสามารถลงทะเบียน **ปลั๊กอินช่องทาง** ที่ทำงานเหมือนช่องทางที่มีมาในตัว
(WhatsApp, Telegram เป็นต้น) คอนฟิกช่องทางอยู่ภายใต้ `channels.<id> คอนฟิกของช่องอยู่ภายใต้ `channels.<id>\`\` และถูกตรวจสอบโดยโค้ดปลั๊กอินช่องทางของคุณ

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

หมายเหตุ:

- วางคอนฟิกไว้ภายใต้ `channels.<id>`(ไม่ใช่ `plugins.entries`).
- `meta.label` ใช้เป็นป้ายกำกับในรายการCLI/UI
- `meta.aliases` เพิ่มidทางเลือกสำหรับการทำ normalization และอินพุตCLI
- `meta.preferOver` ระบุidช่องทางที่ให้ข้ามการเปิดใช้งานอัตโนมัติเมื่อทั้งคู่ถูกกำหนดค่า
- `meta.detailLabel` และ `meta.systemImage` ช่วยให้UIแสดงป้ายกำกับ/ไอคอนช่องทางที่สมบูรณ์ยิ่งขึ้น

### เขียนช่องทางข้อความใหม่(ทีละขั้นตอน)

ใช้เมื่อคุณต้องการ **พื้นผิวแชตใหม่**(“ช่องทางข้อความ”) ไม่ใช่ผู้ให้บริการโมเดล
เอกสารผู้ให้บริการโมเดลอยู่ภายใต้ `/providers/*`.
เอกสารผู้ให้บริการโมเดลอยู่ที่ `/providers/*`

1. เลือกid + รูปแบบคอนฟิก

- คอนฟิกช่องทางทั้งหมดอยู่ภายใต้ `channels.<id>`.
- แนะนำ `channels.<id>.accounts.<accountId>` สำหรับการตั้งค่าหลายบัญชี

2. กำหนดเมทาดาทาช่องทาง

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` ควบคุมรายการCLI/UI
- `meta.docsPath` ควรชี้ไปที่หน้าเอกสารอย่าง `/channels/<id>`
- `meta.preferOver` ให้ปลั๊กอินแทนที่ช่องทางอื่น(การเปิดใช้งานอัตโนมัติจะให้ความสำคัญ)
- `meta.detailLabel` และ `meta.systemImage` ใช้โดยUIสำหรับข้อความรายละเอียด/ไอคอน

3. ติดตั้งอะแดปเตอร์ที่จำเป็น

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities`(ชนิดแชต สื่อ เธรด ฯลฯ)
- `outbound.deliveryMode` + `outbound.sendText`(สำหรับการส่งพื้นฐาน)

4. เพิ่มอะแดปเตอร์เสริมตามต้องการ

- `setup`(วิซาร์ด), `security`(นโยบายDM), `status`(สุขภาพ/การวินิจฉัย)
- `gateway`(เริ่ม/หยุด/ล็อกอิน), `mentions`, `threading`, `streaming`
- `actions`(การกระทำข้อความ), `commands`(พฤติกรรมคำสั่งแบบเนทีฟ)

5. ลงทะเบียนช่องทางในปลั๊กอินของคุณ

- `api.registerChannel({ plugin })`

ตัวอย่างคอนฟิกขั้นต่ำ:

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

ปลั๊กอินช่องทางขั้นต่ำ(ส่งออกอย่างเดียว):

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

โหลดปลั๊กอิน(ไดเรกทอรีส่วนขยายหรือ `plugins.load.paths`), รีสตาร์ตGateway（เกตเวย์）
จากนั้นกำหนดค่า `channels.<id>` ในคอนฟิกของคุณ

### เครื่องมือเอเจนต์

ดูคู่มือเฉพาะ: [Plugin agent tools](/plugins/agent-tools).

### ลงทะเบียนเมธอดGatewayRPC

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### ลงทะเบียนคำสั่งCLI

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### ลงทะเบียนคำสั่งตอบกลับอัตโนมัติ

ปลั๊กอินสามารถลงทะเบียนคำสั่งสแลชแบบกำหนดเองที่รัน **โดยไม่เรียกเอเจนต์AI** เหมาะสำหรับคำสั่งสลับสถานะ การตรวจสอบสถานะ หรือการกระทำด่วนที่ไม่ต้องประมวลผลด้วยLLM สิ่งนี้มีประโยชน์สำหรับคำสั่งสลับ สถานะเช็ก หรือการกระทำด่วนที่ไม่ต้องการการประมวลผลจาก LLM

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

บริบทของตัวจัดการคำสั่ง:

- `senderId`: IDของผู้ส่ง(ถ้ามี)
- `channel`: ช่องทางที่ส่งคำสั่ง
- `isAuthorizedSender`: ผู้ส่งเป็นผู้ใช้ที่ได้รับอนุญาตหรือไม่
- `args`: อาร์กิวเมนต์ที่ส่งหลังคำสั่ง(ถ้า `acceptsArgs: true`)
- `commandBody`: ข้อความคำสั่งเต็ม
- `config`: คอนฟิกOpenClawปัจจุบัน

ตัวเลือกคำสั่ง:

- `name`: ชื่อคำสั่ง(ไม่รวม `/` นำหน้า)
- `description`: ข้อความช่วยเหลือที่แสดงในรายการคำสั่ง
- `acceptsArgs`: คำสั่งรับอาร์กิวเมนต์หรือไม่(ค่าเริ่มต้น: false) หากเป็น false และมีการส่งอาร์กิวเมนต์ คำสั่งจะไม่ตรงและข้อความจะถูกส่งต่อไปยังตัวจัดการอื่น หากเป็น false และมีการส่งอาร์กิวเมนต์ คำสั่งจะไม่ตรงและข้อความจะถูกส่งต่อไปยังตัวจัดการอื่น
- `requireAuth`: ต้องการผู้ส่งที่ได้รับอนุญาตหรือไม่(ค่าเริ่มต้น: true)
- `handler`: ฟังก์ชันที่คืนค่า `{ text: string }`(อาจเป็น async)

ตัวอย่างที่มีการยืนยันตัวตนและอาร์กิวเมนต์:

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

หมายเหตุ:

- คำสั่งของปลั๊กอินจะถูกประมวลผล **ก่อน** คำสั่งที่มีมาในตัวและเอเจนต์AI
- คำสั่งถูกลงทะเบียนแบบส่วนกลางและใช้งานได้ทุกช่องทาง
- ชื่อคำสั่งไม่สนใจตัวพิมพ์เล็กใหญ่(`/MyStatus` ตรงกับ `/mystatus`)
- ชื่อคำสั่งต้องขึ้นต้นด้วยตัวอักษรและมีได้เฉพาะตัวอักษร ตัวเลข ขีดกลาง และขีดล่าง
- ชื่อคำสั่งที่สงวนไว้(เช่น `help`, `status`, `reset` เป็นต้น) ไม่สามารถถูกแทนที่โดยปลั๊กอินได้ ไม่สามารถถูก override โดยปลั๊กอินได้
- การลงทะเบียนคำสั่งซ้ำกันข้ามปลั๊กอินจะล้มเหลวพร้อมข้อผิดพลาดการวินิจฉัย

### ลงทะเบียนบริการเบื้องหลัง

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## หลักเกณฑ์การตั้งชื่อ

- เมธอดGateway: `pluginId.action`(ตัวอย่าง: `voicecall.status`)
- เครื่องมือ: `snake_case`(ตัวอย่าง: `voice_call`)
- คำสั่งCLI: แบบkebabหรือcamel แต่หลีกเลี่ยงการชนกับคำสั่งแกนหลัก

## Skills

ปลั๊กอินสามารถบรรจุสกิลไว้ในรีโป(`skills/<name>/SKILL.md`).
เปิดใช้งานด้วย `plugins.entries.<id>.enabled`(หรือเงื่อนไขคอนฟิกอื่น) และตรวจสอบให้แน่ใจว่า
มีอยู่ในตำแหน่งสกิลของเวิร์กสเปซ/ที่จัดการ

## การแจกจ่าย(npm)

แพ็กเกจที่แนะนำ:

- แพ็กเกจหลัก: `openclaw`(รีโปนี้)
- ปลั๊กอิน: แพ็กเกจnpmแยกภายใต้ `@openclaw/*`(ตัวอย่าง: `@openclaw/voice-call`)

สัญญาการเผยแพร่:

- `package.json` ของปลั๊กอินต้องมี `openclaw.extensions` พร้อมไฟล์เริ่มต้นอย่างน้อยหนึ่งไฟล์
- ไฟล์เริ่มต้นอาจเป็น `.js` หรือ `.ts`(jitiโหลดTSขณะรันไทม์)
- `openclaw plugins install <npm-spec>` ใช้ `npm pack` แตกไฟล์ไปยัง `~/.openclaw/extensions/<id>/` และเปิดใช้งานในคอนฟิก
- ความเสถียรของคีย์คอนฟิก: แพ็กเกจที่มีสโคปจะถูกทำให้เป็นมาตรฐานเป็นid **ไม่ติดสโคป** สำหรับ `plugins.entries.*`

## ปลั๊กอินตัวอย่าง: Voice Call

รีโปนี้มีปลั๊กอินโทรด้วยเสียง(Twilioหรือโหมดสำรองแบบบันทึก):

- ซอร์ส: `extensions/voice-call`
- สกิล: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- เครื่องมือ: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- คอนฟิก(twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from`(ไม่บังคับ `statusCallbackUrl`, `twimlUrl`)
- คอนฟิก(dev): `provider: "log"`(ไม่ใช้เครือข่าย)

ดู [Voice Call](/plugins/voice-call) และ `extensions/voice-call/README.md` สำหรับการตั้งค่าและการใช้งาน

## หมายเหตุด้านความปลอดภัย

ปลั๊กอินทำงานแบบ in-process ร่วมกับ Gateway ให้ปฏิบัติกับมันเสมือนเป็นโค้ดที่เชื่อถือได้:

- ติดตั้งเฉพาะปลั๊กอินที่คุณเชื่อถือ
- แนะนำให้ใช้ allowlist `plugins.allow`
- รีสตาร์ตGateway（เกตเวย์）หลังการเปลี่ยนแปลง

## การทดสอบปลั๊กอิน

ปลั๊กอินสามารถ(และควร)มีการทดสอบ:

- ปลั๊กอินในรีโปสามารถเก็บการทดสอบVitestไว้ภายใต้ `src/**`(ตัวอย่าง: `src/plugins/voice-call.plugin.test.ts`).
- ปลั๊กอินที่เผยแพร่แยกควรรันCIของตนเอง(lint/build/test) และตรวจสอบว่า `openclaw.extensions` ชี้ไปยังเอ็นทรีพอยต์ที่บิลด์แล้ว(`dist/index.js`).
