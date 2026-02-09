---
summary: "คำสั่ง Slash: แบบข้อความเทียบกับแบบเนทีฟ การกำหนดค่า และคำสั่งที่รองรับ"
read_when:
  - การใช้งานหรือการกำหนดค่าคำสั่งแชต
  - การดีบักการกำหนดเส้นทางคำสั่งหรือสิทธิ์
title: "Slash Commands"
---

# Slash commands

Commands are handled by the Gateway. คำสั่งถูกจัดการโดย Gateway คำสั่งส่วนใหญ่ต้องถูกส่งเป็นข้อความ **เดี่ยว** ที่ขึ้นต้นด้วย `/`  
คำสั่งแชต bash สำหรับโฮสต์เท่านั้นใช้ `!
The host-only bash chat command uses `! <cmd>`(โดยมี`/bash <cmd>\` เป็นนามแฝง)

มีสองระบบที่เกี่ยวข้องกัน:

- **Commands**: ข้อความ `/...` แบบเดี่ยว
- **Directives**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`
  - Directives จะถูกตัดออกจากข้อความก่อนที่โมเดลจะเห็น
  - ในข้อความแชตปกติ(ไม่ใช่ directive-only) จะถูกมองเป็น “คำใบ้แบบอินไลน์” และ **ไม่** คงการตั้งค่าเซสชัน
  - ในข้อความแบบ directive-only(ข้อความมีเฉพาะ directives) จะคงอยู่ในเซสชันและตอบกลับด้วยการยืนยัน
  - Directives ใช้ได้เฉพาะกับ **authorized senders** (allowlist/การจับคู่ของช่องทางรวมถึง `commands.useAccessGroups`)  
    ผู้ส่งที่ไม่ได้รับอนุญาตจะเห็น directives ถูกปฏิบัติเหมือนข้อความธรรมดา
    Unauthorized senders see directives treated as plain text.

ยังมี **inline shortcuts** บางรายการ (เฉพาะผู้ส่งที่อยู่ใน allowlist/ได้รับอนุญาต): `/help`, `/commands`, `/status`, `/whoami` (`/id`)  
จะรันทันที ถูกตัดออกก่อนที่โมเดลจะเห็นข้อความ และข้อความที่เหลือจะดำเนินต่อไปตามโฟลว์ปกติ
They run immediately, are stripped before the model sees the message, and the remaining text continues through the normal flow.

## Config

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (ค่าเริ่มต้น `true`) เปิดการแยกวิเคราะห์ `/...` ในข้อความแชต
  - บนแพลตฟอร์มที่ไม่มีคำสั่งเนทีฟ(WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams) คำสั่งแบบข้อความยังใช้งานได้แม้ตั้งค่านี้เป็น `false`
- `commands.native` (ค่าเริ่มต้น `"auto"`) ลงทะเบียนคำสั่งเนทีฟ
  - Auto: เปิดสำหรับ Discord/Telegram; ปิดสำหรับ Slack(จนกว่าคุณจะเพิ่ม slash commands); ถูกละเลยสำหรับผู้ให้บริการที่ไม่รองรับเนทีฟ
  - ตั้งค่า `channels.discord.commands.native`, `channels.telegram.commands.native`, หรือ `channels.slack.commands.native` เพื่อ override รายผู้ให้บริการ (bool หรือ `"auto"`)
  - `false` clears previously registered commands on Discord/Telegram at startup. `false` ล้างคำสั่งที่เคยลงทะเบียนไว้ก่อนหน้าบน Discord/Telegram ตอนเริ่มต้น Slack commands จัดการในแอป Slack และจะไม่ถูกลบอัตโนมัติ
- `commands.nativeSkills` (ค่าเริ่มต้น `"auto"`) ลงทะเบียนคำสั่ง **skill** แบบเนทีฟเมื่อรองรับ
  - Auto: เปิดสำหรับ Discord/Telegram; ปิดสำหรับ Slack(Slack ต้องสร้าง slash command ต่อหนึ่ง skill)
  - ตั้งค่า `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, หรือ `channels.slack.commands.nativeSkills` เพื่อ override รายผู้ให้บริการ (bool หรือ `"auto"`)
- `commands.bash` (ค่าเริ่มต้น `false`) เปิดใช้งาน `! <cmd>` เพื่อรันคำสั่งเชลล์ของโฮสต์ (`/bash <cmd>` เป็นนามแฝง; ต้องมี allowlist ของ `tools.elevated`)
- `commands.bashForegroundMs` (ค่าเริ่มต้น `2000`) ควบคุมระยะเวลาที่ bash รอก่อนสลับเป็นโหมดพื้นหลัง (`0` จะทำงานพื้นหลังทันที)
- `commands.config` (ค่าเริ่มต้น `false`) เปิดใช้งาน `/config` (อ่าน/เขียน `openclaw.json`)
- `commands.debug` (ค่าเริ่มต้น `false`) เปิดใช้งาน `/debug` (override เฉพาะขณะรัน)
- `commands.useAccessGroups` (ค่าเริ่มต้น `true`) บังคับใช้ allowlists/นโยบายสำหรับคำสั่ง

## Command list

Text + native(เมื่อเปิดใช้งาน):

- `/help`
- `/commands`
- `/skill <name> [input]` (รัน skill ตามชื่อ)
- `/status` (แสดงสถานะปัจจุบัน; รวมการใช้งาน/โควตาของผู้ให้บริการสำหรับผู้ให้บริการโมเดลปัจจุบันเมื่อมี)
- `/allowlist` (แสดง/เพิ่ม/ลบรายการ allowlist)
- `/approve <id> allow-once|allow-always|deny` (แก้ไขพรอมต์การอนุมัติการรันคำสั่ง)
- `/context [list|detail|json]` (อธิบาย “context”; `detail` แสดงขนาดต่อไฟล์+ต่อเครื่องมือ+ต่อ skill+system prompt)
- `/whoami` (แสดง sender id ของคุณ; นามแฝง: `/id`)
- `/subagents list|stop|log|info|send` (ตรวจสอบ หยุด บันทึก หรือส่งข้อความถึงการรัน sub-agent สำหรับเซสชันปัจจุบัน)
- `/config show|get|set|unset` (บันทึกคอนฟิกลงดิสก์ เฉพาะเจ้าของ; ต้องมี `commands.config: true`)
- `/debug show|set|unset|reset` (override ระหว่างรัน เฉพาะเจ้าของ; ต้องมี `commands.debug: true`)
- `/usage off|tokens|full|cost` (ส่วนท้ายการใช้งานต่อการตอบหนึ่งครั้งหรือสรุปค่าใช้จ่ายในเครื่อง)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (ควบคุม TTS; ดู [/tts](/tts))
  - Discord: คำสั่งเนทีฟคือ `/voice` (Discord สงวน `/tts`); ข้อความ `/tts` ยังใช้งานได้
- `/stop`
- `/restart`
- `/dock-telegram` (นามแฝง: `/dock_telegram`) (สลับการตอบไปยัง Telegram)
- `/dock-discord` (นามแฝง: `/dock_discord`) (สลับการตอบไปยัง Discord)
- `/dock-slack` (นามแฝง: `/dock_slack`) (สลับการตอบไปยัง Slack)
- `/activation mention|always` (เฉพาะกลุ่ม)
- `/send on|off|inherit` (เฉพาะเจ้าของ)
- `/reset` หรือ `/new [model]` (คำใบ้โมเดลไม่บังคับ; ส่วนที่เหลือจะถูกส่งต่อ)
- `/think <off|minimal|low|medium|high|xhigh>` (ตัวเลือกแบบไดนามิกตามโมเดล/ผู้ให้บริการ; นามแฝง: `/thinking`, `/t`)
- `/verbose on|full|off` (นามแฝง: `/v`)
- `/reasoning on|off|stream` (นามแฝง: `/reason`; เมื่อเปิด จะส่งข้อความแยกที่ขึ้นต้นด้วย `Reasoning:`; `stream` = เฉพาะ Telegram draft)
- `/elevated on|off|ask|full` (นามแฝง: `/elev`; `full` ข้ามการอนุมัติการรันคำสั่ง)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (ส่ง `/exec` เพื่อแสดงค่าปัจจุบัน)
- `/model <name>` (นามแฝง: `/models`; หรือ `/<alias>` จาก `agents.defaults.models.*.alias`)
- `/queue <mode>` (พร้อมตัวเลือกเช่น `debounce:2s cap:25 drop:summarize`; ส่ง `/queue` เพื่อดูการตั้งค่าปัจจุบัน)
- `/bash <command>` (เฉพาะโฮสต์; นามแฝงของ `! <command>`; ต้องมี allowlist ของ `commands.bash: true` + `tools.elevated`)

Text-only:

- `/compact [instructions]` (ดู [/concepts/compaction](/concepts/compaction))
- `! <command>` (เฉพาะโฮสต์; ครั้งละหนึ่งงาน; ใช้ `!poll` + `!stop` สำหรับงานที่ใช้เวลานาน)
- `!poll` (ตรวจสอบเอาต์พุต/สถานะ; รับ `sessionId` แบบไม่บังคับ; `/bash poll` ก็ใช้ได้)
- `!stop` (หยุดงาน bash ที่กำลังรัน; รับ `sessionId` แบบไม่บังคับ; `/bash stop` ก็ใช้ได้)

Notes:

- คำสั่งรับ `:` แบบไม่บังคับระหว่างคำสั่งกับอาร์กิวเมนต์ (เช่น `/think: high`, `/send: on`, `/help:`)
- `/new <model>` รับนามแฝงโมเดล `provider/model` หรือชื่อผู้ให้บริการ(จับคู่แบบคลุมเครือ); หากไม่ตรงกัน ข้อความจะถูกมองเป็นเนื้อหาข้อความ
- สำหรับรายละเอียดการใช้งานผู้ให้บริการแบบเต็ม ให้ใช้ `openclaw status --usage`
- `/allowlist add|remove` ต้องมี `commands.config=true` และเคารพ `configWrites` ของช่องทาง
- `/usage` ควบคุมส่วนท้ายการใช้งานต่อการตอบ; `/usage cost` พิมพ์สรุปค่าใช้จ่ายในเครื่องจากบันทึกเซสชัน OpenClaw
- `/restart` ปิดใช้งานเป็นค่าเริ่มต้น; ตั้งค่า `commands.restart: true` เพื่อเปิดใช้งาน
- `/verbose` มีไว้เพื่อการดีบักและการมองเห็นเพิ่มเติม; ควรปิดไว้ในการใช้งานปกติ
- `/reasoning` (และ `/verbose`) มีความเสี่ยงในบริบทกลุ่ม: อาจเปิดเผยเหตุผลภายในหรือเอาต์พุตเครื่องมือที่คุณไม่ตั้งใจเปิดเผย แนะนำให้ปิดไว้ โดยเฉพาะในแชตกลุ่ม Prefer leaving them off, especially in group chats.
- **Fast path:** ข้อความที่เป็นคำสั่งล้วนจากผู้ส่งที่อยู่ใน allowlist จะถูกจัดการทันที(ข้ามคิว+โมเดล)
- **Group mention gating:** ข้อความคำสั่งล้วนจากผู้ส่งที่อยู่ใน allowlist จะข้ามข้อกำหนดการเมนชัน
- **Inline shortcuts (เฉพาะผู้ส่งใน allowlist):** คำสั่งบางรายการใช้งานได้เมื่อฝังอยู่ในข้อความปกติและจะถูกตัดออกก่อนที่โมเดลจะเห็นข้อความที่เหลือ
  - ตัวอย่าง: `hey /status` กระตุ้นการตอบสถานะ และข้อความที่เหลือจะดำเนินต่อไปตามโฟลว์ปกติ
- ปัจจุบัน: `/help`, `/commands`, `/status`, `/whoami` (`/id`)
- ข้อความคำสั่งล้วนจากผู้ที่ไม่ได้รับอนุญาตจะถูกเพิกเฉยอย่างเงียบๆ และโทเคน `/...` แบบอินไลน์จะถูกมองเป็นข้อความธรรมดา
- **Skill commands:** `user-invocable` skills ถูกเปิดเผยเป็น slash commands ชื่อจะถูกทำความสะอาดเป็น `a-z0-9_` (สูงสุด 32 อักขระ); ชื่อซ้ำจะได้ต่อท้ายด้วยตัวเลข (เช่น `_2`) Names are sanitized to `a-z0-9_` (max 32 chars); collisions get numeric suffixes (e.g. `_2`).
  - `/skill <name> [input]` รัน skill ตามชื่อ(มีประโยชน์เมื่อข้อจำกัดคำสั่งเนทีฟไม่เอื้อให้มีคำสั่งต่อ skill)
  - ค่าเริ่มต้น คำสั่ง skill จะถูกส่งต่อไปยังโมเดลเป็นคำขอปกติ
  - Skills อาจประกาศ `command-dispatch: tool` เพื่อกำหนดเส้นทางคำสั่งไปยังเครื่องมือโดยตรง(กำหนดผลแน่นอน ไม่ใช้โมเดล)
  - ตัวอย่าง: `/prose` (ปลั๊กอิน OpenProse) — ดู [OpenProse](/prose)
- **Native command arguments:** Discord ใช้ autocomplete สำหรับตัวเลือกแบบไดนามิก(และเมนูปุ่มเมื่อคุณละเว้นอาร์กิวเมนต์ที่จำเป็น) Telegram และ Slack จะแสดงเมนูปุ่มเมื่อคำสั่งรองรับตัวเลือกและคุณละเว้นอาร์กิวเมนต์ Telegram and Slack show a button menu when a command supports choices and you omit the arg.

## Usage surfaces (what shows where)

- **การใช้งาน/โควตาของผู้ให้บริการ** (ตัวอย่าง: “Claude เหลือ 80%”) แสดงใน `/status` สำหรับผู้ให้บริการโมเดลปัจจุบันเมื่อเปิดการติดตามการใช้งาน
- **โทเคน/ค่าใช้จ่ายต่อการตอบ** ถูกควบคุมโดย `/usage off|tokens|full` (ต่อท้ายการตอบปกติ)
- `/model status` เกี่ยวกับ **โมเดล/การยืนยันตัวตน/เอ็นด์พอยต์** ไม่ใช่การใช้งาน

## Model selection (`/model`)

`/model` ถูกนำไปใช้ในรูปแบบ directive

Examples:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Notes:

- `/model` และ `/model list` แสดงตัวเลือกแบบย่อที่มีหมายเลข(ตระกูลโมเดล+ผู้ให้บริการที่มี)
- `/model <#>` เลือกจากตัวเลือกนั้น(และจะเลือกผู้ให้บริการปัจจุบันก่อนเมื่อเป็นไปได้)
- `/model status` แสดงมุมมองรายละเอียด รวมถึงเอ็นด์พอยต์ผู้ให้บริการที่กำหนดค่าไว้ (`baseUrl`) และโหมด API (`api`) เมื่อมี

## Debug overrides

`/debug` ช่วยให้คุณตั้งค่า override คอนฟิกแบบ **เฉพาะขณะรัน** (อยู่ในหน่วยความจำ ไม่เขียนดิสก์) เฉพาะเจ้าของ ปิดใช้งานเป็นค่าเริ่มต้น; เปิดด้วย `commands.debug: true` Owner-only. Disabled by default; enable with `commands.debug: true`.

Examples:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notes:

- Overrides มีผลทันทีต่อการอ่านคอนฟิกใหม่ แต่ **ไม่** เขียนไปที่ `openclaw.json`
- ใช้ `/debug reset` เพื่อล้าง overrides ทั้งหมดและกลับไปใช้คอนฟิกบนดิสก์

## Config updates

`/config` เขียนไปยังคอนฟิกบนดิสก์ของคุณ (`openclaw.json`) เฉพาะเจ้าของ ปิดใช้งานเป็นค่าเริ่มต้น; เปิดด้วย `commands.config: true` Owner-only. Disabled by default; enable with `commands.config: true`.

Examples:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Notes:

- คอนฟิกจะถูกตรวจสอบก่อนเขียน การเปลี่ยนแปลงที่ไม่ถูกต้องจะถูกปฏิเสธ
- `/config` การอัปเดตจะคงอยู่ข้ามการรีสตาร์ต

## Surface notes

- **Text commands** รันในเซสชันแชตปกติ (DMs ใช้ `main` ร่วมกัน กลุ่มมีเซสชันของตนเอง)
- **Native commands** ใช้เซสชันที่แยกต่างหาก:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (ตั้งค่าพรีฟิกซ์ได้ผ่าน `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (กำหนดเป้าหมายไปยังเซสชันแชตผ่าน `CommandTargetSessionKey`)
- **`/stop`** กำหนดเป้าหมายไปยังเซสชันแชตที่กำลังใช้งาน เพื่อให้สามารถยกเลิกการรันปัจจุบันได้
- **Slack:** `channels.slack.slashCommand` ยังรองรับสำหรับคำสั่งแบบ `/openclaw` เพียงรายการเดียว หากคุณเปิด `commands.native` คุณต้องสร้าง Slack slash command หนึ่งรายการต่อคำสั่งที่มีมาให้ในตัว(ชื่อเดียวกับ `/help`) เมนูอาร์กิวเมนต์คำสั่งสำหรับ Slack จะถูกส่งเป็นปุ่ม Block Kit แบบชั่วคราว If you enable `commands.native`, you must create one Slack slash command per built-in command (same names as `/help`). Command argument menus for Slack are delivered as ephemeral Block Kit buttons.
