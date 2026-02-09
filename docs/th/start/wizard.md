---
summary: "วิซาร์ดเริ่มต้นใช้งานCLI: การตั้งค่าแบบมีคำแนะนำสำหรับเกตเวย์ เวิร์กสเปซ ช่องทาง และSkills"
read_when:
  - Onboarding Wizard (CLI)
  - เมื่อตั้งค่าเครื่องใหม่
title: "Onboarding Wizard (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# วิซาร์ดนี้ตั้งค่าเกตเวย์ภายในเครื่องหรือการเชื่อมต่อเกตเวย์ระยะไกล รวมถึงแชนเนล สกิล และค่าเริ่มต้นของ workspace ในขั้นตอนนำทางครั้งเดียว

วิซาร์ดเริ่มต้นใช้งานเป็นวิธีที่**แนะนำ**ในการตั้งค่า OpenClaw บน macOS,
Linux หรือ Windows (ผ่าน WSL2; แนะนำอย่างยิ่ง)
โดยจะกำหนดค่า Gateway ภายในเครื่องหรือการเชื่อมต่อ Gateway ระยะไกล รวมถึงช่องทาง Skills
และค่าเริ่มต้นของเวิร์กสเปซในโฟลว์แบบมีคำแนะนำเดียว
รัน
`openclaw dashboard` และแชตผ่านเบราว์เซอร์

```bash
openclaw onboard
```

<Info>

แชตแรกได้เร็วที่สุด: เปิด Control UI (ไม่ต้องตั้งค่าช่องทาง) รัน
`openclaw dashboard` แล้วแชตในเบราว์เซอร์ เอกสาร: [Dashboard](/web/dashboard).
 เอกสาร: [Dashboard](/web/dashboard) สำหรับสคริปต์ ให้ใช้ `--non-interactive`
</Info>

หากต้องการกำหนดค่าใหม่ภายหลัง:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>

`--json` ไม่ได้หมายความว่าเป็นโหมดไม่โต้ตอบ สำหรับสคริปต์ ให้ใช้ `--non-interactive`.
 เส้นทางที่ง่ายที่สุด: `openclaw configure --section web`
ซึ่งจะจัดเก็บค่า `tools.web.search.apiKey`
</Note>

<Tip>

แนะนำ: ตั้งค่า Brave Search API key เพื่อให้เอเจนต์สามารถใช้ `web_search`
(`web_fetch` ใช้งานได้โดยไม่ต้องมีคีย์) วิธีที่ง่ายที่สุด: `openclaw configure --section web`
ซึ่งจะจัดเก็บ `tools.web.search.apiKey` เอกสาร: [Web tools](/tools/web).
 เอกสาร: [Web tools](/tools/web) เลือกโมเดลเริ่มต้น
</Tip>

## QuickStart vs Advanced

วิซาร์ดเริ่มต้นด้วย **QuickStart** (ค่าเริ่มต้น) เทียบกับ **Advanced** (ควบคุมได้ครบถ้วน)

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Gateway ภายในเครื่อง (loopback)
    - ค่าเริ่มต้นเวิร์กสเปซ (หรือเวิร์กสเปซที่มีอยู่)
    - พอร์ต Gateway **18789**
    - การยืนยันตัวตน Gateway แบบ **Token** (สร้างอัตโนมัติ แม้บน loopback)
    - การเปิดเผยผ่าน Tailscale **ปิด**
    - Telegram + WhatsApp DMs ตั้งค่าเริ่มต้นเป็น **allowlist** (ระบบจะขอหมายเลขโทรศัพท์ของคุณ)
  </Tab>
  <Tab title="Advanced (full control)">
    - เปิดเผยทุกขั้นตอน (โหมด เวิร์กสเปซ เกตเวย์ ช่องทาง เดมอน Skills)
  </Tab>
</Tabs>

## สิ่งที่วิซาร์ดกำหนดค่า

**โหมดภายในเครื่อง (ค่าเริ่มต้น)** จะพาคุณผ่านขั้นตอนเหล่านี้:

1. **โมเดล/การยืนยันตัวตน** — Anthropic API key (แนะนำ), OAuth, OpenAI หรือผู้ให้บริการอื่น เลือกโมเดลเริ่มต้น Pick a default model.
2. **เวิร์กสเปซ** — ตำแหน่งสำหรับไฟล์เอเจนต์ (ค่าเริ่มต้น `~/.openclaw/workspace`) พร้อมสร้างไฟล์เริ่มต้น สร้างไฟล์บูตสแตรปจาก seeds
3. **Gateway** — พอร์ต ที่อยู่ bind โหมดการยืนยันตัวตน การเปิดเผยผ่าน Tailscale
4. **ช่องทาง** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles หรือ iMessage
5. **เดมอน** — ติดตั้ง LaunchAgent (macOS) หรือ systemd user unit (Linux/WSL2)
6. **ตรวจสุขภาพ** — เริ่ม Gateway และตรวจสอบว่าทำงานอยู่
7. **Skills** — ติดตั้ง Skills ที่แนะนำและไลบรารีเสริมแบบไม่บังคับ

<Note>
การรันวิซาร์ดซ้ำจะ **ไม่** ลบอะไรเลย เว้นแต่คุณจะเลือก **Reset** อย่างชัดเจน (หรือส่ง `--reset`)
หากคอนฟิกไม่ถูกต้องหรือมีคีย์แบบเดิม วิซาร์ดจะขอให้คุณรัน `openclaw doctor` ก่อน
</Note>

**โหมดระยะไกล** จะกำหนดค่าเฉพาะไคลเอนต์ภายในเครื่องเพื่อเชื่อมต่อไปยัง Gateway ที่อื่น
และจะ**ไม่**ติดตั้งหรือเปลี่ยนแปลงสิ่งใดบนโฮสต์ระยะไกล
มัน **ไม่** ติดตั้งหรือเปลี่ยนแปลงสิ่งใด ๆ บนโฮสต์ระยะไกล

## เพิ่มเอเจนต์อีกตัว

ใช้ `openclaw agents add <name>` เพื่อสร้างเอเจนต์แยกต่างหากที่มีเวิร์กสเปซ
เซสชัน และโปรไฟล์การยืนยันตัวตนของตนเอง การรันโดยไม่ใช้ `--workspace` จะเปิดวิซาร์ด การรันโดยไม่ใช้ `--workspace` จะเปิดวิซาร์ด

สิ่งที่ตั้งค่าให้:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

หมายเหตุ:

- เวิร์กสเปซเริ่มต้นเป็นไปตาม `~/.openclaw/workspace-<agentId>`
- เพิ่ม `bindings` เพื่อกำหนดเส้นทางข้อความขาเข้า (วิซาร์ดสามารถทำให้ได้)
- แฟล็กแบบไม่โต้ตอบ: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## อ้างอิงแบบเต็ม

สำหรับรายละเอียดทีละขั้นตอน การสคริปต์แบบไม่โต้ตอบ การตั้งค่า Signal,
RPC API และรายการฟิลด์คอนฟิกทั้งหมดที่วิซาร์ดเขียน โปรดดู
[Wizard Reference](/reference/wizard).

## เอกสารที่เกี่ยวข้อง

- อ้างอิงคำสั่งCLI: [`openclaw onboard`](/cli/onboard)
- การเริ่มต้นใช้งานแอปmacOS: [Onboarding](/start/onboarding)
- พิธีการรันครั้งแรกของเอเจนต์: [Agent Bootstrapping](/start/bootstrapping)
