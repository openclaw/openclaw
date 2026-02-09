---
summary: "เอกสารอ้างอิงฉบับสมบูรณ์สำหรับวิซาร์ดการเริ่มต้นใช้งาน CLI: ทุกขั้นตอน แฟล็ก และฟิลด์คอนฟิก"
read_when:
  - เมื่อต้องการค้นหาขั้นตอนหรือแฟล็กเฉพาะของวิซาร์ด
  - เมื่อต้องการทำให้การเริ่มต้นใช้งานเป็นอัตโนมัติด้วยโหมดไม่โต้ตอบ
  - 43. การดีบักพฤติกรรมของวิซาร์ด
title: "เอกสารอ้างอิงวิซาร์ดการเริ่มต้นใช้งาน"
sidebarTitle: "Wizard Reference"
---

# reference/wizard.md

นี่คือเอกสารอ้างอิงฉบับสมบูรณ์สำหรับวิซาร์ด CLI `openclaw onboard`  
สำหรับภาพรวมระดับสูง โปรดดู [Onboarding Wizard](/start/wizard)
44. สำหรับภาพรวมระดับสูง ดู [Onboarding Wizard](/start/wizard)

## รายละเอียดโฟลว์(โหมดภายในเครื่อง)

<Steps>
  <Step title="Existing config detection">
    
    - หากมี `~/.openclaw/openclaw.json` อยู่ ให้เลือก **เก็บไว้ / แก้ไข / รีเซ็ต**
    - การรันวิซาร์ดซ้ำจะ **ไม่** ลบสิ่งใด เว้นแต่คุณจะเลือก **รีเซ็ต** อย่างชัดเจน
      (หรือส่ง `--reset`)
    - หากคอนฟิกไม่ถูกต้องหรือมีคีย์แบบเดิม วิซาร์ดจะหยุดและขอให้คุณรัน
      `openclaw doctor` ก่อนดำเนินการต่อ
    - การรีเซ็ตใช้ `trash` (ไม่ใช้ `rm` เด็ดขาด) และมีขอบเขตให้เลือก:
      - คอนฟิกเท่านั้น
      - คอนฟิก + ข้อมูลรับรอง + เซสชัน
      - รีเซ็ตทั้งหมด(รวมถึงลบเวิร์กสเปซ)
  
    45. - การรันวิซาร์ดซ้ำจะ **ไม่** ลบสิ่งใด เว้นแต่คุณจะเลือก **Reset** อย่างชัดเจน
      (หรือส่ง `--reset`)
    46. - หากการตั้งค่าไม่ถูกต้องหรือมีคีย์แบบเดิม วิซาร์ดจะหยุดและขอให้คุณรัน
      `openclaw doctor` ก่อนดำเนินการต่อ
    47. - Reset ใช้ `trash` (ไม่ใช้ `rm` เด็ดขาด) และมีขอบเขตให้เลือก:
      - เฉพาะ config
      - Config + credentials + sessions
      - รีเซ็ตทั้งหมด (รวมถึงลบ workspace)  
</Step>
  <Step title="Model/Auth">
    48. - **Anthropic API key (แนะนำ)**: ใช้ `ANTHROPIC_API_KEY` หากมีอยู่ หรือจะขอให้ป้อนคีย์ จากนั้นบันทึกไว้สำหรับการใช้งานของดีมอน
    49. - **Anthropic OAuth (Claude Code CLI)**: บน macOS วิซาร์ดจะตรวจสอบรายการ Keychain "Claude Code-credentials" (เลือก "Always Allow" เพื่อไม่ให้การเริ่มต้นด้วย launchd ถูกบล็อก); บน Linux/Windows จะนำ `~/.claude/.credentials.json` มาใช้ซ้ำหากมีอยู่
    50. - **Anthropic token (วาง setup-token)**: รัน `claude setup-token` บนเครื่องใดก็ได้ จากนั้นวางโทเคน (คุณสามารถตั้งชื่อได้; เว้นว่าง = ค่าเริ่มต้น)
    - **OpenAI Code (Codex) subscription (Codex CLI)**: if `~/.codex/auth.json` exists, the wizard can reuse it.
    - **OpenAI Code (Codex) subscription (OAuth)**: browser flow; paste the `code#state`.
      - Sets `agents.defaults.model` to `openai-codex/gpt-5.2` when model is unset or `openai/*`.
    - **OpenAI API key**: uses `OPENAI_API_KEY` if present or prompts for a key, then saves it to `~/.openclaw/.env` so launchd can read it.
    - **xAI (Grok) API key**: prompts for `XAI_API_KEY` and configures xAI as a model provider.
    - **OpenCode Zen (multi-model proxy)**: prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`, get it at https://opencode.ai/auth).
    - **API key**: stores the key for you.
    - **Vercel AI Gateway (multi-model proxy)**: prompts for `AI_GATEWAY_API_KEY`.
    - More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: prompts for Account ID, Gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: config is auto-written.
    - More detail: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: prompts for `SYNTHETIC_API_KEY`.
    - More detail: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config is auto-written.
    - **Kimi Coding**: config is auto-written.
    - More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: no auth configured yet.
    - Pick a default model from detected options (or enter provider/model manually).
    - Wizard runs a model check and warns if the configured model is unknown or missing auth.
    - OAuth credentials live in `~/.openclaw/credentials/oauth.json`; auth profiles live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`(API keys + OAuth)
    - รายละเอียดเพิ่มเติม: [/concepts/oauth](/concepts/oauth)
    
    - รายละเอียดเพิ่มเติม: [/concepts/oauth](/concepts/oauth)    
<Note>
    เคล็ดลับสำหรับโหมด headless/เซิร์ฟเวอร์: ทำ OAuth บนเครื่องที่มีเบราว์เซอร์ให้เสร็จ จากนั้นคัดลอก
    `~/.openclaw/credentials/oauth.json` (หรือ `$OPENCLAW_STATE_DIR/credentials/oauth.json`) ไปยัง
    โฮสต์Gateway
    </Note>
  </Step>
  <Step title="Workspace">
    - Default `~/.openclaw/workspace` (configurable).
    - Seeds the workspace files needed for the agent bootstrap ritual.
    
    - ค่าเริ่มต้น `~/.openclaw/workspace`(ปรับได้)
    - เตรียมไฟล์เวิร์กสเปซที่จำเป็นสำหรับพิธีบูตสแตรปเอเจนต์
    - โครงสร้างเวิร์กสเปซเต็มรูปแบบ + คู่มือสำรองข้อมูล: [Agent workspace](/concepts/agent-workspace)
    
</Step>
  <Step title="Gateway">
    - Port, bind, auth mode, tailscale exposure.
    
    - พอร์ต การ bind โหมดการยืนยันตัวตน การเปิดให้เข้าถึงผ่าน Tailscale
    - คำแนะนำด้านการยืนยันตัวตน: ควรใช้ **Token** แม้กับ loopback เพื่อให้ไคลเอนต์ WS ภายในเครื่องต้องยืนยันตัวตน
    - ปิดการยืนยันตัวตนเฉพาะเมื่อคุณเชื่อถือทุกโปรเซสภายในเครื่องอย่างสมบูรณ์
    - การ bind ที่ไม่ใช่ loopback ยังต้องมีการยืนยันตัวตน
  
    - Disable auth only if you fully trust every local process.
    - Non‑loopback binds still require auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login.
    - [Telegram](/channels/telegram): bot token.
    - [Discord](/channels/discord): bot token.
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience.
    - [Mattermost](/channels/mattermost) (plugin): bot token + base URL.
    - [Signal](/channels/signal): optional `signal-cli` install + account config.
    - [BlueBubbles](/channels/bluebubbles): **recommended for iMessage**; server URL + password + webhook.
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access.
    - DM security: default is pairing. First DM sends a code; approve via `openclaw pairing approve <channel><code>` หรือใช้รายการอนุญาต
  </Step><code>` or use allowlists.
  <code>` หรือใช้รายการอนุญาต
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

    - Linux (and Windows via WSL2): systemd user unit
      - Wizard attempts to enable lingering via `loginctl enable-linger <user>` so the Gateway stays up after logout.
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
    - **Runtime selection:** Node (recommended; required for WhatsApp/Telegram). Bun is **not recommended**.
  </Step>
  <Step title="Health check">
    - Starts the Gateway (if needed) and runs `openclaw health`.
    - Tip: `openclaw status --deep` adds gateway health probes to status output (requires a reachable gateway).
  </Step>
  <Step title="Skills (recommended)">
    - Reads the available skills and checks requirements.
    - Lets you choose a node manager: **npm / pnpm** (bun not recommended).
    - Installs optional dependencies (some use Homebrew on macOS).
  </Step>
  <Step title="Finish">
    - Summary + next steps, including iOS/Android/macOS apps for extra features.
  </Step>
</Steps>

<Note>

หากไม่ตรวจพบ GUI วิซาร์ดจะแสดงคำแนะนำการทำ SSH port-forward สำหรับ Control UI แทนการเปิดเบราว์เซอร์
หากไม่มีไฟล์ assets ของ Control UI วิซาร์ดจะพยายามสร้างขึ้นใหม่; ทางเลือกสำรองคือ `pnpm ui:build`(ติดตั้งไลบรารี UI อัตโนมัติ)

If the Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
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
 Use `--non-interactive` (and `--workspace`) for scripts.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
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
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
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

The Gateway exposes the wizard flow over RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
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
Sessions are stored under `~/.openclaw/agents/<agentId>/sessions/`.

Some channels are delivered as plugins. บางช่องทางถูกจัดส่งในรูปแบบปลั๊กอิน เมื่อคุณเลือกช่องทางหนึ่งระหว่างการเริ่มต้นใช้งาน วิซาร์ด
จะขอให้ติดตั้งก่อน(npm หรือพาธภายในเครื่อง)จึงจะสามารถตั้งค่าได้

## เอกสารที่เกี่ยวข้อง

- ภาพรวมวิซาร์ด: [Onboarding Wizard](/start/wizard)
- การเริ่มต้นใช้งานแอป macOS: [Onboarding](/start/onboarding)
- เอกสารอ้างอิงคอนฟิก: [Gateway configuration](/gateway/configuration)
- ผู้ให้บริการ: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles)(iMessage), [iMessage](/channels/imessage)(แบบเดิม)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
