---
summary: "เอกสารอ้างอิงฉบับสมบูรณ์สำหรับโฟลว์การเริ่มต้นใช้งานผ่านCLIการตั้งค่าauth/โมเดลเอาต์พุตและโครงสร้างภายใน"
read_when:
  - คุณต้องการรายละเอียดพฤติกรรมของopenclaw onboard
  - คุณกำลังดีบักผลลัพธ์การเริ่มต้นใช้งานหรือผสานรวมไคลเอนต์การเริ่มต้นใช้งาน
title: "เอกสารอ้างอิงการเริ่มต้นใช้งานผ่านCLI"
sidebarTitle: "CLI reference"
---

# เอกสารอ้างอิงการเริ่มต้นใช้งานผ่านCLI

หน้านี้เป็นเอกสารอ้างอิงฉบับเต็มสำหรับ `openclaw onboard`
หน้านี้คือเอกสารอ้างอิงฉบับเต็มสำหรับ `openclaw onboard`  
สำหรับคู่มือฉบับย่อโปรดดู [Onboarding Wizard (CLI)](/start/wizard)

## สิ่งที่วิซาร์ดทำ

โหมดLocal(ค่าเริ่มต้น)จะพาคุณทำตามขั้นตอนต่อไปนี้:

- การตั้งค่าโมเดลและการยืนยันตัวตน(OpenAI Code subscription OAuth, Anthropic API keyหรือsetup tokenรวมถึงตัวเลือกMiniMax, GLM, MoonshotและAI Gateway)
- ตำแหน่งWorkspaceและไฟล์บูตสแตรป
- การตั้งค่าGateway(พอร์ตการbindการยืนยันตัวตนtailscale)
- ช่องทางและผู้ให้บริการ(Telegram, WhatsApp, Discord, Google Chat, Mattermost plugin, Signal)
- การติดตั้งเดมอน(LaunchAgentหรือsystemd user unit)
- การตรวจสุขภาพ
- การตั้งค่าSkills

โหมดRemoteจะกำหนดค่าเครื่องนี้ให้เชื่อมต่อกับGatewayที่อยู่อื่น  
โหมดนี้จะไม่ติดตั้งหรือแก้ไขสิ่งใดบนโฮสต์ระยะไกล
วิซาร์ดจะไม่ติดตั้งหรือแก้ไขสิ่งใด ๆ บนโฮสต์ระยะไกล

## รายละเอียดโฟลว์แบบLocal

<Steps>
  <Step title="Existing config detection">
    
    - หากมี `~/.openclaw/openclaw.json` ให้เลือก เก็บไว้, แก้ไข หรือ รีเซ็ต
    - การรันตัวช่วยซ้ำจะไม่ล้างข้อมูลใดๆเว้นแต่คุณเลือก รีเซ็ต อย่างชัดเจน(หรือส่ง `--reset`)
    - หากคอนฟิกไม่ถูกต้องหรือมีคีย์รุ่นเก่า ตัวช่วยจะหยุดและขอให้คุณรัน `openclaw doctor` ก่อนดำเนินการต่อ
    - การรีเซ็ตใช้ `trash` และมีขอบเขตให้เลือก:
      - เฉพาะคอนฟิก
      - คอนฟิก+ข้อมูลรับรอง+เซสชัน
      - รีเซ็ตทั้งหมด(ลบWorkspaceด้วย)
  
    - การรันวิซาร์ดซ้ำจะไม่ลบข้อมูลใด ๆ เว้นแต่คุณจะเลือก Reset อย่างชัดเจน (หรือส่ง `--reset`)
    - หากคอนฟิกไม่ถูกต้องหรือมีคีย์แบบเดิม (legacy) วิซาร์ดจะหยุดและขอให้คุณรัน `openclaw doctor` ก่อนดำเนินการต่อ
    - การ Reset ใช้ `trash` และมีขอบเขตให้เลือก:
      - เฉพาะคอนฟิก
      - คอนฟิก + ข้อมูลรับรอง + เซสชัน
      - รีเซ็ตทั้งหมด (ลบ workspace ด้วย)  
</Step>
  <Step title="Model and auth">
    - เมทริกซ์ตัวเลือกแบบเต็มอยู่ที่ [Auth and model options](#auth-and-model-options)
  </Step>
  <Step title="Workspace">
    - ค่าเริ่มต้นคือ `~/.openclaw/workspace` (สามารถปรับได้)
    - สร้างไฟล์ workspace ที่จำเป็นสำหรับพิธี bootstrap ครั้งแรก
    
    - ค่าเริ่มต้น `~/.openclaw/workspace`(ปรับได้)
    - สร้างไฟล์Workspaceที่จำเป็นสำหรับพิธีบูตสแตรปครั้งแรก
    - โครงสร้างWorkspace: [Agent workspace](/concepts/agent-workspace)
  
  </Step>
  <Step title="Gateway">
    - ถามค่า port, bind, โหมดการยืนยันตัวตน และการเปิดใช้งานผ่าน Tailscale
    - แนะนำ: คงการยืนยันตัวตนด้วยโทเคนไว้ แม้จะเป็น loopback เพื่อให้ไคลเอนต์ WS ภายในเครื่องต้องยืนยันตัวตน
    - ปิดการยืนยันตัวตนเฉพาะเมื่อคุณเชื่อถือทุกโปรเซสภายในเครื่องอย่างสมบูรณ์
    - การ bind ที่ไม่ใช่ loopback ยังคงต้องมีการยืนยันตัวตน
  </Step>
  <Step title="Channels">
    
    - [WhatsApp](/channels/whatsapp): การล็อกอินด้วยQRแบบไม่บังคับ
    - [Telegram](/channels/telegram): โทเคนบอต
    - [Discord](/channels/discord): โทเคนบอต
    - [Google Chat](/channels/googlechat): service account JSON+audienceของwebhook
    - [Mattermost](/channels/mattermost) plugin: โทเคนบอต+base URL
    - [Signal](/channels/signal): การติดตั้ง `signal-cli` แบบไม่บังคับ+การตั้งค่าบัญชี
    - [BlueBubbles](/channels/bluebubbles): แนะนำสำหรับiMessage; server URL+รหัสผ่าน+webhook
    - [iMessage](/channels/imessage): เส้นทางCLIรุ่นเก่า `imsg`+การเข้าถึงDB
    - ความปลอดภัยของDM: ค่าเริ่มต้นคือการจับคู่ DMแรกจะส่งโค้ด อนุมัติผ่าน
      `openclaw pairing approve  DM ครั้งแรกจะส่งโค้ดมา; อนุมัติผ่าน
      `openclaw pairing approve
17. <code>` หรือใช้ allowlist <channel><code>` หรือใช้allowlists
  </Step>- Linux และ Windows ผ่าน WSL2: systemd user unit
      - วิซาร์ดพยายามรัน `loginctl enable-linger <user>` เพื่อให้เกตเวย์ยังทำงานหลังจากล็อกเอาต์
  <code>` หรือใช้allowlists
  </Step>
  <Step title="การติดตั้งเดมอน">
    - macOS: LaunchAgent
      - ต้องมีเซสชันผู้ใช้ที่ล็อกอินอยู่; สำหรับheadlessให้ใช้LaunchDaemonแบบกำหนดเอง(ไม่ได้จัดส่ง)
    - LinuxและWindowsผ่านWSL2: systemd user unit
      - ตัวช่วยพยายาม `loginctl enable-linger <user>` เพื่อให้Gatewayทำงานต่อหลังออกจากระบบ
      - อาจขอsudo(เขียน `/var/lib/systemd/linger`); จะพยายามโดยไม่ใช้sudoก่อน
    - การเลือกรันไทม์: Node(แนะนำ; จำเป็นสำหรับWhatsAppและTelegram) ไม่แนะนำBun
  </Step>
  <Step title="การตรวจสุขภาพ">
    - เริ่มGateway(หากจำเป็น)และรัน `openclaw health`
    - `openclaw status --deep` เพิ่มโพรบสุขภาพของGatewayในเอาต์พุตสถานะ
  </Step>
  <Step title="Skills">
    - อ่านSkillsที่มีและตรวจข้อกำหนด
    - ให้เลือกตัวจัดการแพ็กเกจNode: npmหรือpnpm(ไม่แนะนำbun)
    - ติดตั้งไลบรารีเสริมแบบไม่บังคับ(บางรายการใช้HomebrewบนmacOS)
  </Step>
  <Step title="เสร็จสิ้น">
    - สรุปและขั้นตอนถัดไปรวมถึงตัวเลือกแอปiOS, AndroidและmacOS
  </Step>

    - อาจขอ sudo (เขียนไปที่ `/var/lib/systemd/linger`); จะลองโดยไม่ใช้ sudo ก่อน
      - การเลือกระบบรันไทม์: Node (แนะนำ; จำเป็นสำหรับ WhatsApp และ Telegram)
    Bun ไม่แนะนำ </Step>
  <Step title="Health check">
    - เริ่มเกตเวย์ (ถ้าจำเป็น) และรัน `openclaw health`
  - `openclaw status --deep` จะเพิ่ม health probe ของเกตเวย์ลงในผลลัพธ์สถานะ
    </Step>
  <Step title="Skills">
    - อ่านสกิลที่มีและตรวจสอบข้อกำหนด
  - ให้คุณเลือกตัวจัดการแพ็กเกจ Node: npm หรือ pnpm (ไม่แนะนำ bun)
    - ติดตั้ง dependency เสริม (บางรายการใช้ Homebrew บน macOS)
    </Step>
  <Step title="Finish">
    - สรุปและขั้นตอนถัดไป รวมถึงตัวเลือกแอป iOS, Android และ macOS
  </Step>
  หากไม่พบ Control UI assets วิซาร์ดจะพยายามสร้างให้; ทางเลือกสำรองคือ `pnpm ui:build` (ติดตั้ง UI deps อัตโนมัติ)
</Steps>

<Note>

หากไม่ตรวจพบGUIตัวช่วยจะพิมพ์คำแนะนำการทำSSH port-forwardสำหรับControl UIแทนการเปิดเบราว์เซอร์  
หากไม่มีแอสเซ็ตของControl UIตัวช่วยจะพยายามสร้างให้; ทางเลือกสำรองคือ `pnpm ui:build`(ติดตั้งไลบรารีUIอัตโนมัติ)

- คำแนะนำการค้นหา:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## รายละเอียดโหมดRemote

โหมดRemoteจะกำหนดค่าเครื่องนี้ให้เชื่อมต่อกับGatewayที่อยู่อื่น

<Info>
โหมดRemoteจะไม่ติดตั้งหรือแก้ไขสิ่งใดบนโฮสต์ระยะไกล
</Info>

สิ่งที่คุณตั้งค่า:

- URLของRemote Gateway(`ws://...`)
- โทเคนหากGatewayระยะไกลต้องการการยืนยันตัวตน(แนะนำ)

<Note>

- หากGatewayเป็นloopbackเท่านั้นให้ใช้การทำอุโมงค์SSHหรือtailnet
- คำใบ้Discovery:
  - macOS: Bonjour(`dns-sd`)
  - Linux: Avahi(`avahi-browse`)

คุณสามารถตั้งชื่อได้; เว้นว่างจะใช้ค่าเริ่มต้น
</Note>

## ตัวเลือกการยืนยันตัวตนและโมเดล

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    ใช้ `ANTHROPIC_API_KEY` หากมีอยู่หรือจะขอคีย์จากนั้นบันทึกไว้เพื่อใช้กับเดมอน
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: ตรวจรายการKeychainชื่อ "Claude Code-credentials"
    - LinuxและWindows: ใช้ `~/.claude/.credentials.json` ซ้ำหากมีอยู่

    ```
    บนmacOSให้เลือก "Always Allow" เพื่อไม่ให้การเริ่มต้นlaunchdถูกบล็อก
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    
    รัน `claude setup-token` บนเครื่องใดก็ได้แล้ววางโทเคน  
    คุณสามารถตั้งชื่อได้; เว้นว่างจะใช้ค่าเริ่มต้น
  
    ถามค่า `OPENCODE_API_KEY` (หรือ `OPENCODE_ZEN_API_KEY`)
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    หากมี `~/.codex/auth.json` ตัวช่วยสามารถนำมาใช้ซ้ำได้
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    โฟลว์ผ่านเบราว์เซอร์; วาง `code#state`

    ```
    ตั้งค่า `agents.defaults.model` เป็น `openai-codex/gpt-5.3-codex` เมื่อยังไม่ได้ตั้งค่าโมเดลหรือเป็น `openai/*`
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    ใช้ `OPENAI_API_KEY` หากมีอยู่หรือจะขอคีย์จากนั้นบันทึกไปที่
    `~/.openclaw/.env` เพื่อให้launchdอ่านได้

    ```
    ตั้งค่า `agents.defaults.model` เป็น `openai/gpt-5.1-codex` เมื่อยังไม่ได้ตั้งค่าโมเดลเป็น `openai/*` หรือ `openai-codex/*`
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    ขอ `XAI_API_KEY` และกำหนดค่าxAIเป็นผู้ให้บริการโมเดล
  </Accordion>
  <Accordion title="OpenCode Zen">
    ถามค่า `AI_GATEWAY_API_KEY`
    
    ขอ `OPENCODE_API_KEY`(หรือ `OPENCODE_ZEN_API_KEY`)  
    URLการตั้งค่า: [opencode.ai/auth](https://opencode.ai/auth).
  
  </Accordion>
  <Accordion title="API key (generic)">
    จัดเก็บคีย์ให้คุณ
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    รายละเอียดเพิ่มเติม: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    
    ขอ `AI_GATEWAY_API_KEY`  
    รายละเอียดเพิ่มเติม: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    
    ขอaccount ID, gateway IDและ `CLOUDFLARE_AI_GATEWAY_API_KEY`  
    รายละเอียดเพิ่มเติม: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  
    คอนฟิกจะถูกเขียนให้อัตโนมัติ
  </Accordion>
  <Accordion title="MiniMax M2.1">
    ถามค่า `SYNTHETIC_API_KEY`
    
    เขียนคอนฟิกอัตโนมัติ  
    รายละเอียดเพิ่มเติม: [MiniMax](/providers/minimax).
  
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    คอนฟิกของ Moonshot (Kimi K2) และ Kimi Coding จะถูกเขียนให้อัตโนมัติ
    
    ขอ `SYNTHETIC_API_KEY`  
    รายละเอียดเพิ่มเติม: [Synthetic](/providers/synthetic).
  
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    เซสชันถูกเก็บไว้ที่ `~/.openclaw/agents/<agentId>/sessions/`
    
    คอนฟิกของMoonshot(Kimi K2)และKimi Codingจะถูกเขียนอัตโนมัติ  
    รายละเอียดเพิ่มเติม: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  
  </Accordion>
  <Accordion title="Skip">
    ปล่อยให้การยืนยันตัวตนยังไม่ถูกกำหนดค่า
  </Accordion>
</AccordionGroup>

พฤติกรรมของโมเดล:

- เลือกโมเดลเริ่มต้นจากตัวเลือกที่ตรวจพบหรือกรอกผู้ให้บริการและโมเดลด้วยตนเอง
- ตัวช่วยจะรันการตรวจสอบโมเดลและเตือนหากโมเดลที่ตั้งค่าไม่รู้จักหรือขาดการยืนยันตัวตน

พาธของข้อมูลรับรองและโปรไฟล์:

- ข้อมูลรับรองOAuth: `~/.openclaw/credentials/oauth.json`
- โปรไฟล์การยืนยันตัวตน(API keys+OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
เคล็ดลับสำหรับเครื่องไม่มีจอและเซิร์ฟเวอร์: ทำOAuthบนเครื่องที่มีเบราว์เซอร์ก่อนแล้วคัดลอก
`~/.openclaw/credentials/oauth.json`(หรือ `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
ไปยังโฮสต์Gateway
</Note>

## เอาต์พุตและโครงสร้างภายใน

ฟิลด์ทั่วไปใน `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`(หากเลือกMinimax)
- `gateway.*`(โหมด, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- allowlistsของช่องทาง(Slack, Discord, Matrix, Microsoft Teams)เมื่อคุณเลือกเข้าร่วมระหว่างการถาม(ชื่อจะถูกแปลงเป็นIDเมื่อเป็นไปได้)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` จะเขียน `agents.list[]` และ `bindings` แบบไม่บังคับ

ข้อมูลรับรองของWhatsAppจะอยู่ภายใต้ `~/.openclaw/credentials/whatsapp/<accountId>/`  
เซสชันถูกจัดเก็บภายใต้ `~/.openclaw/agents/<agentId>/sessions/`
บางแชนเนลถูกส่งมาในรูปแบบปลั๊กอิน

<Note>
ใช้ native build เมื่อมีให้ใช้งาน 
บางช่องทางถูกส่งมอบเป็นปลั๊กอิน เมื่อเลือกในระหว่างการเริ่มต้นใช้งานตัวช่วย
จะถามให้ติดตั้งปลั๊กอิน(npmหรือพาธภายในเครื่อง)ก่อนการกำหนดค่าช่องทาง

</Note>

Gateway wizard RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

ไคลเอนต์(แอปmacOSและControl UI)สามารถเรนเดอร์ขั้นตอนโดยไม่ต้องนำตรรกะการเริ่มต้นใช้งานไปเขียนใหม่

พฤติกรรมการตั้งค่าSignal:

- ดาวน์โหลดแอสเซ็ตรีลีสที่เหมาะสม
- จัดเก็บไว้ที่ `~/.openclaw/tools/signal-cli/<version>/`
- เขียน `channels.signal.cliPath` ในคอนฟิก
- บิลด์แบบJVMต้องใช้Java 21
- การรันหรือการตั้งค่าวิซาร์ดการเริ่มต้นใช้งาน
- Windowsใช้WSL2และทำตามโฟลว์signal-cliของLinuxภายในWSL

## เอกสารที่เกี่ยวข้อง

- ศูนย์รวมการเริ่มต้นใช้งาน: [Onboarding Wizard (CLI)](/start/wizard)
- ระบบอัตโนมัติและสคริปต์: [CLI Automation](/start/wizard-cli-automation)
- เอกสารอ้างอิงคำสั่ง: [`openclaw onboard`](/cli/onboard)
