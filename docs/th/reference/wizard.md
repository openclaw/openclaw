---
summary: "เอกสารอ้างอิงฉบับสมบูรณ์สำหรับวิซาร์ดการเริ่มต้นใช้งาน CLI: ทุกขั้นตอน แฟล็ก และฟิลด์คอนฟิก"
read_when:
  - เมื่อต้องการค้นหาขั้นตอนหรือแฟล็กเฉพาะของวิซาร์ด
  - เมื่อต้องการทำให้การเริ่มต้นใช้งานเป็นอัตโนมัติด้วยโหมดไม่โต้ตอบ
  - เมื่อต้องการดีบักพฤติกรรมของวิซาร์ด
title: "เอกสารอ้างอิงวิซาร์ดการเริ่มต้นใช้งาน"
sidebarTitle: "Wizard Reference"
x-i18n:
  source_path: reference/wizard.md
  source_hash: 05fac3786016d906
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:02Z
---

# เอกสารอ้างอิงวิซาร์ดการเริ่มต้นใช้งาน

นี่คือเอกสารอ้างอิงฉบับสมบูรณ์สำหรับวิซาร์ด CLI `openclaw onboard`  
สำหรับภาพรวมระดับสูง โปรดดู [Onboarding Wizard](/start/wizard)

## รายละเอียดโฟลว์(โหมดภายในเครื่อง)

<Steps>
  <Step title="การตรวจจับคอนฟิกที่มีอยู่">
    - หากมี `~/.openclaw/openclaw.json` อยู่ ให้เลือก **เก็บไว้ / แก้ไข / รีเซ็ต**
    - การรันวิซาร์ดซ้ำจะ **ไม่** ลบสิ่งใด เว้นแต่คุณจะเลือก **รีเซ็ต** อย่างชัดเจน
      (หรือส่ง `--reset`)
    - หากคอนฟิกไม่ถูกต้องหรือมีคีย์แบบเดิม วิซาร์ดจะหยุดและขอให้คุณรัน
      `openclaw doctor` ก่อนดำเนินการต่อ
    - การรีเซ็ตใช้ `trash` (ไม่ใช้ `rm` เด็ดขาด) และมีขอบเขตให้เลือก:
      - คอนฟิกเท่านั้น
      - คอนฟิก + ข้อมูลรับรอง + เซสชัน
      - รีเซ็ตทั้งหมด(รวมถึงลบเวิร์กสเปซ)
  </Step>
  <Step title="โมเดล/การยืนยันตัวตน">
    - **Anthropic API key (แนะนำ)**: ใช้ `ANTHROPIC_API_KEY` หากมีอยู่ หรือถามหาคีย์ จากนั้นบันทึกไว้สำหรับการใช้งานของเดมอน
    - **Anthropic OAuth (Claude Code CLI)**: บน macOS วิซาร์ดจะตรวจสอบ Keychain item “Claude Code-credentials”(เลือก “Always Allow” เพื่อไม่ให้ launchd ถูกบล็อก); บน Linux/Windows จะนำ `~/.claude/.credentials.json` ที่มีอยู่มาใช้ซ้ำ
    - **Anthropic token (วาง setup-token)**: รัน `claude setup-token` บนเครื่องใดก็ได้ จากนั้นวางโทเคน(ตั้งชื่อได้; เว้นว่าง=ค่าเริ่มต้น)
    - **OpenAI Code (Codex) subscription (Codex CLI)**: หากมี `~/.codex/auth.json` อยู่ วิซาร์ดสามารถนำมาใช้ซ้ำได้
    - **OpenAI Code (Codex) subscription (OAuth)**: โฟลว์ผ่านเบราว์เซอร์; วาง `code#state`
      - ตั้งค่า `agents.defaults.model` เป็น `openai-codex/gpt-5.2` เมื่อยังไม่ตั้งค่าโมเดลหรือเป็น `openai/*`
    - **OpenAI API key**: ใช้ `OPENAI_API_KEY` หากมีอยู่ หรือถามหาคีย์ จากนั้นบันทึกไปยัง `~/.openclaw/.env` เพื่อให้ launchd อ่านได้
    - **xAI (Grok) API key**: ถามหา `XAI_API_KEY` และตั้งค่า xAI เป็นผู้ให้บริการโมเดล
    - **OpenCode Zen (พร็อกซีหลายโมเดล)**: ถามหา `OPENCODE_API_KEY` (หรือ `OPENCODE_ZEN_API_KEY` รับได้ที่ https://opencode.ai/auth)
    - **API key**: จัดเก็บคีย์ให้คุณ
    - **Vercel AI Gateway (พร็อกซีหลายโมเดล)**: ถามหา `AI_GATEWAY_API_KEY`
    - รายละเอียดเพิ่มเติม: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: ถามหา Account ID, Gateway ID และ `CLOUDFLARE_AI_GATEWAY_API_KEY`
    - รายละเอียดเพิ่มเติม: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: เขียนคอนฟิกอัตโนมัติ
    - รายละเอียดเพิ่มเติม: [MiniMax](/providers/minimax)
    - **Synthetic (เข้ากันได้กับ Anthropic)**: ถามหา `SYNTHETIC_API_KEY`
    - รายละเอียดเพิ่มเติม: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: เขียนคอนฟิกอัตโนมัติ
    - **Kimi Coding**: เขียนคอนฟิกอัตโนมัติ
    - รายละเอียดเพิ่มเติม: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **ข้าม**: ยังไม่ตั้งค่าการยืนยันตัวตน
    - เลือกโมเดลเริ่มต้นจากตัวเลือกที่ตรวจพบ(หรือป้อนผู้ให้บริการ/โมเดลด้วยตนเอง)
    - วิซาร์ดจะตรวจสอบโมเดลและแจ้งเตือนหากโมเดลที่ตั้งค่าไม่รู้จักหรือขาดการยืนยันตัวตน
    - ข้อมูลรับรอง OAuth อยู่ที่ `~/.openclaw/credentials/oauth.json`; โปรไฟล์การยืนยันตัวตนอยู่ที่ `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`(API keys + OAuth)
    - รายละเอียดเพิ่มเติม: [/concepts/oauth](/concepts/oauth)
    <Note>
    เคล็ดลับสำหรับโหมด headless/เซิร์ฟเวอร์: ทำ OAuth บนเครื่องที่มีเบราว์เซอร์ให้เสร็จ จากนั้นคัดลอก
    `~/.openclaw/credentials/oauth.json` (หรือ `$OPENCLAW_STATE_DIR/credentials/oauth.json`) ไปยัง
    โฮสต์Gateway
    </Note>
  </Step>
  <Step title="เวิร์กสเปซ">
    - ค่าเริ่มต้น `~/.openclaw/workspace`(ปรับได้)
    - เตรียมไฟล์เวิร์กสเปซที่จำเป็นสำหรับพิธีบูตสแตรปเอเจนต์
    - โครงสร้างเวิร์กสเปซเต็มรูปแบบ + คู่มือสำรองข้อมูล: [Agent workspace](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - พอร์ต การ bind โหมดการยืนยันตัวตน การเปิดให้เข้าถึงผ่าน Tailscale
    - คำแนะนำด้านการยืนยันตัวตน: ควรใช้ **Token** แม้กับ loopback เพื่อให้ไคลเอนต์ WS ภายในเครื่องต้องยืนยันตัวตน
    - ปิดการยืนยันตัวตนเฉพาะเมื่อคุณเชื่อถือทุกโปรเซสภายในเครื่องอย่างสมบูรณ์
    - การ bind ที่ไม่ใช่ loopback ยังต้องมีการยืนยันตัวตน
  </Step>
  <Step title="ช่องทาง">
    - [WhatsApp](/channels/whatsapp): เข้าสู่ระบบด้วย QR(ไม่บังคับ)
    - [Telegram](/channels/telegram): โทเคนบอต
    - [Discord](/channels/discord): โทเคนบอต
    - [Google Chat](/channels/googlechat): JSON ของ service account + audience ของ webhook
    - [Mattermost](/channels/mattermost)(ปลั๊กอิน): โทเคนบอต + base URL
    - [Signal](/channels/signal): ติดตั้ง `signal-cli` (ไม่บังคับ) + คอนฟิกบัญชี
    - [BlueBubbles](/channels/bluebubbles): **แนะนำสำหรับ iMessage**; URL เซิร์ฟเวอร์ + รหัสผ่าน + webhook
    - [iMessage](/channels/imessage): เส้นทาง CLI `imsg` แบบเดิม + การเข้าถึงฐานข้อมูล
    - ความปลอดภัย DM: ค่าเริ่มต้นคือการจับคู่ DM แรกจะส่งรหัส ให้อนุมัติผ่าน `openclaw pairing approve <channel> <code>` หรือใช้รายการอนุญาต
  </Step>
  <Step title="การติดตั้งเดมอน">
    - macOS: LaunchAgent
      - ต้องมีเซสชันผู้ใช้ที่ล็อกอินอยู่; สำหรับ headless ให้ใช้ LaunchDaemon แบบกำหนดเอง(ไม่มีจัดส่งมา)
    - Linux(และ Windows ผ่าน WSL2): systemd user unit
      - วิซาร์ดพยายามเปิด lingering ผ่าน `loginctl enable-linger <user>` เพื่อให้ Gateway ทำงานต่อหลังออกจากระบบ
      - อาจขอ sudo(เขียน `/var/lib/systemd/linger`); จะพยายามโดยไม่ใช้ sudo ก่อน
    - **การเลือกรันไทม์:** Node(แนะนำ; จำเป็นสำหรับ WhatsApp/Telegram) ไม่แนะนำ Bun
  </Step>
  <Step title="การตรวจสุขภาพ">
    - เริ่ม Gateway(หากจำเป็น) และรัน `openclaw health`
    - เคล็ดลับ: `openclaw status --deep` จะเพิ่มการตรวจสุขภาพ Gateway ในเอาต์พุตสถานะ(ต้องเข้าถึง Gateway ได้)
  </Step>
  <Step title="Skills(แนะนำ)">
    - อ่าน Skills ที่มีอยู่และตรวจสอบข้อกำหนด
    - ให้คุณเลือกตัวจัดการโหนด: **npm / pnpm** (ไม่แนะนำ bun)
    - ติดตั้งไลบรารีเสริม(บางรายการใช้ Homebrew บน macOS)
  </Step>
  <Step title="เสร็จสิ้น">
    - สรุป + ขั้นตอนถัดไป รวมถึงแอป iOS/Android/macOS สำหรับฟีเจอร์เพิ่มเติม
  </Step>
</Steps>

<Note>
หากไม่ตรวจพบ GUI วิซาร์ดจะแสดงคำแนะนำการทำ SSH port-forward สำหรับ Control UI แทนการเปิดเบราว์เซอร์
หากไม่มีไฟล์ assets ของ Control UI วิซาร์ดจะพยายามสร้างขึ้นใหม่; ทางเลือกสำรองคือ `pnpm ui:build`(ติดตั้งไลบรารี UI อัตโนมัติ)
</Note>

## โหมดไม่โต้ตอบ

ใช้ `--non-interactive` เพื่อทำให้การเริ่มต้นใช้งานเป็นอัตโนมัติหรือเขียนสคริปต์:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

เพิ่ม `--json` เพื่อรับสรุปแบบเครื่องอ่านได้

<Note>
`--json` **ไม่ได้** หมายถึงโหมดไม่โต้ตอบ ใช้ `--non-interactive`(และ `--workspace`) สำหรับสคริปต์
</Note>

<AccordionGroup>
  <Accordion title="ตัวอย่าง Gemini">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="ตัวอย่าง Z.AI">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="ตัวอย่าง Vercel AI Gateway">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="ตัวอย่าง Cloudflare AI Gateway">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="ตัวอย่าง Moonshot">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="ตัวอย่าง Synthetic">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="ตัวอย่าง OpenCode Zen">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### เพิ่มเอเจนต์(ไม่โต้ตอบ)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway wizard RPC

Gateway เปิดเผยโฟลว์ของวิซาร์ดผ่าน RPC(`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`)  
ไคลเอนต์(แอป macOS, Control UI)สามารถเรนเดอร์ขั้นตอนได้โดยไม่ต้องนำตรรกะการเริ่มต้นใช้งานไปทำใหม่

## การตั้งค่า Signal(signal-cli)

วิซาร์ดสามารถติดตั้ง `signal-cli` จาก GitHub releases:

- ดาวน์โหลดไฟล์ release ที่เหมาะสม
- จัดเก็บไว้ที่ `~/.openclaw/tools/signal-cli/<version>/`
- เขียน `channels.signal.cliPath` ลงในคอนฟิกของคุณ

หมายเหตุ:

- บิลด์ JVM ต้องใช้ **Java 21**
- ใช้บิลด์แบบ Native เมื่อมีให้ใช้
- Windows ใช้ WSL2; การติดตั้ง signal-cli จะเป็นไปตามโฟลว์ Linux ภายใน WSL

## สิ่งที่วิซาร์ดเขียนลงไป

ฟิลด์ทั่วไปใน `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`(หากเลือก Minimax)
- `gateway.*`(โหมด bind การยืนยันตัวตน tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- รายการอนุญาตของช่องทาง(Slack/Discord/Matrix/Microsoft Teams)เมื่อคุณเลือกเข้าระหว่างพรอมป์ต์(ชื่อจะถูกแปลงเป็น ID เมื่อเป็นไปได้)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` จะเขียน `agents.list[]` และ `bindings`(ไม่บังคับ)

ข้อมูลรับรอง WhatsApp จะอยู่ภายใต้ `~/.openclaw/credentials/whatsapp/<accountId>/`  
เซสชันจะถูกจัดเก็บภายใต้ `~/.openclaw/agents/<agentId>/sessions/`

บางช่องทางถูกจัดส่งในรูปแบบปลั๊กอิน เมื่อคุณเลือกช่องทางหนึ่งระหว่างการเริ่มต้นใช้งาน วิซาร์ด
จะขอให้ติดตั้งก่อน(npm หรือพาธภายในเครื่อง)จึงจะสามารถตั้งค่าได้

## เอกสารที่เกี่ยวข้อง

- ภาพรวมวิซาร์ด: [Onboarding Wizard](/start/wizard)
- การเริ่มต้นใช้งานแอป macOS: [Onboarding](/start/onboarding)
- เอกสารอ้างอิงคอนฟิก: [Gateway configuration](/gateway/configuration)
- ผู้ให้บริการ: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles)(iMessage), [iMessage](/channels/imessage)(แบบเดิม)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
