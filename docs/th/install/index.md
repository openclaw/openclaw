---
summary: "ติดตั้ง OpenClaw — สคริปต์ติดตั้ง, npm/pnpm, จากซอร์ส, Docker และอื่นๆ"
read_when:
  - คุณต้องการวิธีติดตั้งที่แตกต่างจาก Getting Started แบบเริ่มต้นอย่างรวดเร็ว
  - คุณต้องการดีพลอยไปยังแพลตฟอร์มคลาวด์
  - คุณต้องการอัปเดต ย้ายระบบ หรือถอนการติดตั้ง
title: "ติดตั้ง"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:26Z
---

# ติดตั้ง

เคยทำตาม [Getting Started](/start/getting-started) แล้วหรือยัง? ถ้าใช่ก็พร้อมใช้งานแล้ว — หน้านี้สำหรับวิธีติดตั้งทางเลือก คำแนะนำเฉพาะแพลตฟอร์ม และการบำรุงรักษา

## ข้อกำหนดของระบบ

- **[Node 22+](/install/node)** (สคริปต์ติดตั้งใน [วิธีติดตั้ง](#install-methods) จะติดตั้งให้หากยังไม่มี)
- macOS, Linux หรือ Windows
- `pnpm` เฉพาะกรณีที่คุณ build จากซอร์ส

<Note>
บน Windows เราขอแนะนำอย่างยิ่งให้รัน OpenClaw ภายใต้ [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install)
</Note>

## วิธีติดตั้ง

<Tip>
**สคริปต์ติดตั้ง** เป็นวิธีที่แนะนำในการติดตั้ง OpenClaw โดยจะจัดการการตรวจพบ Node การติดตั้ง และการเริ่มต้นใช้งานในขั้นตอนเดียว
</Tip>

<AccordionGroup>
  <Accordion title="สคริปต์ติดตั้ง" icon="rocket" defaultOpen>
    ดาวน์โหลด CLI ติดตั้งแบบ global ผ่าน npm และเปิดตัวช่วยเริ่มต้นใช้งาน

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    เท่านี้ก็เรียบร้อย — สคริปต์จะจัดการการตรวจพบ Node การติดตั้ง และการเริ่มต้นใช้งานให้ทั้งหมด

    หากต้องการข้ามการเริ่มต้นใช้งานและติดตั้งเฉพาะไบนารี:

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>

    สำหรับแฟล็ก ตัวแปรสภาพแวดล้อม และตัวเลือก CI/อัตโนมัติทั้งหมด ดูที่ [Installer internals](/install/installer)

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    หากคุณมี Node 22+ อยู่แล้วและต้องการจัดการการติดตั้งเอง:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="เกิดข้อผิดพลาดการ build ของ sharp?">
          หากคุณติดตั้ง libvips แบบ global (พบบ่อยบน macOS ผ่าน Homebrew) และ `sharp` ล้มเหลว ให้บังคับใช้ไบนารีแบบ prebuilt:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          หากคุณเห็น `sharp: Please add node-gyp to your dependencies` ให้ติดตั้งเครื่องมือสำหรับ build (macOS: Xcode CLT + `npm install -g node-gyp`) หรือใช้ตัวแปรสภาพแวดล้อมด้านบน
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm ต้องการการอนุมัติอย่างชัดเจนสำหรับแพ็กเกจที่มีสคริปต์ build หลังจากการติดตั้งครั้งแรกแสดงคำเตือน "Ignored build scripts" ให้รัน `pnpm approve-builds -g` และเลือกแพ็กเกจที่แสดงรายการ
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="จากซอร์ส" icon="github">
    สำหรับผู้มีส่วนร่วม หรือผู้ที่ต้องการรันจากเช็กเอาต์ในเครื่อง

    <Steps>
      <Step title="โคลนและ build">
        โคลน [รีโป OpenClaw](https://github.com/openclaw/openclaw) และ build:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="ลิงก์ CLI">
        ทำให้คำสั่ง `openclaw` ใช้งานได้แบบ global:

        ```bash
        pnpm link --global
        ```

        หรือจะข้ามการลิงก์และรันคำสั่งผ่าน `pnpm openclaw ...` จากภายในรีโปก็ได้
      </Step>
      <Step title="รันการเริ่มต้นใช้งาน">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    สำหรับเวิร์กโฟลว์การพัฒนาที่ลึกขึ้น ดูที่ [การตั้งค่า](/start/setup)

  </Accordion>
</AccordionGroup>

## วิธีติดตั้งอื่นๆ

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    การดีพลอยแบบคอนเทนเนอร์หรือแบบ headless
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    การติดตั้งเชิงประกาศผ่าน Nix
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    การจัดเตรียมฟลีตอัตโนมัติ
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    การใช้งานเฉพาะ CLI ผ่านรันไทม์ Bun
  </Card>
</CardGroup>

## หลังการติดตั้ง

ตรวจสอบว่าทุกอย่างทำงานได้ตามปกติ:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## การแก้ไขปัญหา: ไม่พบ `openclaw`

<Accordion title="การวินิจฉัยและแก้ไข PATH">
  การวินิจฉัยอย่างรวดเร็ว:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

หาก `$(npm prefix -g)/bin` (macOS/Linux) หรือ `$(npm prefix -g)` (Windows) **ไม่** อยู่ใน `$PATH` ของคุณ เชลล์จะไม่สามารถค้นหาไบนารี npm แบบ global ได้ (รวมถึง `openclaw`)

วิธีแก้ไข — เพิ่มเข้าไปในไฟล์เริ่มต้นของเชลล์ (`~/.zshrc` หรือ `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

บน Windows ให้เพิ่มเอาต์พุตของ `npm prefix -g` ลงใน PATH ของคุณ

จากนั้นเปิดเทอร์มินัลใหม่ (หรือ `rehash` ใน zsh / `hash -r` ใน bash)
</Accordion>

## อัปเดต / ถอนการติดตั้ง

<CardGroup cols={3}>
  <Card title="การอัปเดต" href="/install/updating" icon="refresh-cw">
    อัปเดต OpenClaw ให้เป็นเวอร์ชันล่าสุด
  </Card>
  <Card title="การย้ายระบบ" href="/install/migrating" icon="arrow-right">
    ย้ายไปยังเครื่องใหม่
  </Card>
  <Card title="ถอนการติดตั้ง" href="/install/uninstall" icon="trash-2">
    ลบ OpenClaw ออกทั้งหมด
  </Card>
</CardGroup>
