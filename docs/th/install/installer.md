---
summary: "วิธีการทำงานของสคริปต์ตัวติดตั้ง (install.sh, install-cli.sh, install.ps1), แฟล็ก และการทำงานอัตโนมัติ"
read_when:
  - คุณต้องการทำความเข้าใจ `openclaw.ai/install.sh`
  - คุณต้องการทำให้การติดตั้งเป็นอัตโนมัติ (CI / headless)
  - คุณต้องการติดตั้งจากการเช็คเอาต์ GitHub
title: "โครงสร้างภายในของตัวติดตั้ง"
---

# โครงสร้างภายในของตัวติดตั้ง

OpenClaw มาพร้อมสคริปต์ตัวติดตั้งสามตัว ซึ่งให้บริการจาก `openclaw.ai`.

| สคริปต์                            | แพลตฟอร์ม                               | ทำอะไรบ้าง                                                                                                                 |
| ---------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | ติดตั้ง Node หากจำเป็น ติดตั้ง OpenClaw ผ่าน npm (ค่าเริ่มต้น) หรือ git และสามารถรัน onboarding ได้     |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | ติดตั้ง Node + OpenClaw ลงใน prefix ภายในเครื่อง (`~/.openclaw`). ไม่ต้องใช้สิทธิ์ root |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | ติดตั้ง Node หากจำเป็น ติดตั้ง OpenClaw ผ่าน npm (ค่าเริ่มต้น) หรือ git และสามารถรัน onboarding ได้     |

## คำสั่งด่วน

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ````
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```
    ````

  </Tab>
</Tabs>

<Note>
หากการติดตั้งสำเร็จแต่ไม่พบ `openclaw` ในเทอร์มินัลใหม่ ให้ดูที่ [Node.js troubleshooting](/install/node#troubleshooting)
</Note>

---

## install.sh

<Tip>
แนะนำสำหรับการติดตั้งแบบโต้ตอบส่วนใหญ่บน macOS/Linux/WSL
</Tip>

### โฟลว์ (install.sh)

<Steps>
  <Step title="Detect OS">
    รองรับ macOS และ Linux (รวมถึง WSL) 
    รองรับ macOS และ Linux (รวมถึง WSL) หากตรวจพบ macOS จะติดตั้ง Homebrew หากยังไม่มี
  
  </Step>
  <Step title="Ensure Node.js 22+">
    ตรวจสอบเวอร์ชัน Node และติดตั้ง Node 22 หากจำเป็น (Homebrew บน macOS, สคริปต์ตั้งค่า NodeSource บน Linux apt/dnf/yum)
  </Step>
  <Step title="Ensure Git">
    ติดตั้ง Git หากยังไม่มี
  </Step>
  <Step title="Install OpenClaw">
    - วิธี `npm` (ค่าเริ่มต้น): ติดตั้ง npm แบบ global
    - วิธี `git`: clone/อัปเดตรีโป ติดตั้ง dependencies ด้วย pnpm, build แล้วติดตั้ง wrapper ที่ `~/.local/bin/openclaw`
  </Step>
  <Step title="Post-install tasks">
    - รัน `openclaw doctor --non-interactive` เมื่ออัปเกรดและการติดตั้งแบบ git (พยายามให้ดีที่สุด)
    - พยายามทำ onboarding เมื่อเหมาะสม (มี TTY, ไม่ได้ปิด onboarding และการตรวจสอบ bootstrap/คอนฟิกผ่าน)
    - ค่าเริ่มต้นเป็น `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### การตรวจจับซอร์สเช็คเอาต์

หากรันภายในเช็คเอาต์ของ OpenClaw (`package.json` + `pnpm-workspace.yaml`) สคริปต์จะเสนอให้:

- ใช้เช็คเอาต์ (`git`) หรือ
- ใช้การติดตั้งแบบ global (`npm`)

หากไม่มี TTY และไม่ได้ตั้งค่าวิธีติดตั้งไว้ ค่าเริ่มต้นจะเป็น `npm` และจะแสดงคำเตือน

สคริปต์จะออกด้วยโค้ด `2` เมื่อเลือกวิธีไม่ถูกต้องหรือค่า `--install-method` ไม่ถูกต้อง

### ตัวอย่าง (install.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Skip onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Dry run">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| แฟล็ก                             | คำอธิบาย                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | เลือกวิธีติดตั้ง (ค่าเริ่มต้น: `npm`). นามแฝง: `--method`       |
| `--npm`                           | ทางลัดสำหรับวิธี npm                                                                                                               |
| `--git`                           | ทางลัดสำหรับวิธี git นามแฝง: `--github` นามแฝง: `--github`                                         |
| `--version <version\\|dist-tag>` | เวอร์ชัน npm หรือ dist-tag (ค่าเริ่มต้น: `latest`)                                              |
| `--beta`                          | ใช้ beta dist-tag หากมี มิฉะนั้นจะ fallback เป็น `latest`                                                                          |
| `--git-dir <path>`                | ไดเรกทอรีเช็คเอาต์ (ค่าเริ่มต้น: `~/openclaw`). นามแฝง: `--dir` |
| `--no-git-update`                 | ข้าม `git pull` สำหรับเช็คเอาต์ที่มีอยู่                                                                                           |
| `--no-prompt`                     | ปิดการแสดงพรอมป์ต์                                                                                                                 |
| `--no-onboard`                    | ข้าม onboarding                                                                                                                    |
| `--onboard`                       | เปิดใช้งาน onboarding                                                                                                              |
| `--dry-run`                       | แสดงการกระทำโดยไม่ใช้การเปลี่ยนแปลงจริง                                                                                            |
| `--verbose`                       | เปิดเอาต์พุตดีบัก (`set -x`, ล็อกระดับ notice ของ npm)                                                          |
| `--help`                          | แสดงวิธีใช้ (`-h`)                                                                                              |

  </Accordion>

  <Accordion title="Environment variables reference">

| ตัวแปร                                          | คำอธิบาย                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | วิธีติดตั้ง                                                                        |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | เวอร์ชัน npm หรือ dist-tag                                                         |
| `OPENCLAW_BETA=0\\|1`                          | ใช้ beta หากมี                                                                     |
| `OPENCLAW_GIT_DIR=<path>`                       | ไดเรกทอรีเช็คเอาต์                                                                 |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | เปิด/ปิดการอัปเดต git                                                              |
| `OPENCLAW_NO_PROMPT=1`                          | ปิดการแสดงพรอมป์ต์                                                                 |
| `OPENCLAW_NO_ONBOARD=1`                         | ข้าม onboarding                                                                    |
| `OPENCLAW_DRY_RUN=1`                            | โหมด dry run                                                                       |
| `OPENCLAW_VERBOSE=1`                            | โหมดดีบัก                                                                          |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | ระดับล็อก npm                                                                      |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | ควบคุมพฤติกรรม sharp/libvips (ค่าเริ่มต้น: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
ออกแบบมาสำหรับสภาพแวดล้อมที่ต้องการให้ทุกอย่างอยู่ภายใต้ prefix ภายในเครื่อง (ค่าเริ่มต้น `~/.openclaw`) และไม่พึ่งพา Node ของระบบ
</Info>

### โฟลว์ (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    ดาวน์โหลด Node tarball (ค่าเริ่มต้น `22.22.0`) ไปที่ `<prefix>/tools/node-v<version>` และตรวจสอบ SHA-256
  </Step>
  <Step title="Ensure Git">
    หากไม่มี Git จะพยายามติดตั้งผ่าน apt/dnf/yum บน Linux หรือ Homebrew บน macOS
  </Step>
  <Step title="Install OpenClaw under prefix">
    ติดตั้งด้วย npm โดยใช้ `--prefix <prefix>` จากนั้นเขียน wrapper ไปที่ `<prefix>/bin/openclaw`
  </Step>
</Steps>

### ตัวอย่าง (install-cli.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Custom prefix + version">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Automation JSON output">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Run onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| แฟล็ก                  | คำอธิบาย                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `--prefix <path>`      | prefix สำหรับติดตั้ง (ค่าเริ่มต้น: `~/.openclaw`)       |
| `--version <ver>`      | เวอร์ชัน OpenClaw หรือ dist-tag (ค่าเริ่มต้น: `latest`) |
| `--node-version <ver>` | เวอร์ชัน Node (ค่าเริ่มต้น: `22.22.0`)                  |
| `--json`               | ส่งอีเวนต์ NDJSON                                                                          |
| `--onboard`            | รัน `openclaw onboard` หลังการติดตั้ง                                                      |
| `--no-onboard`         | ข้าม onboarding (ค่าเริ่มต้น)                                           |
| `--set-npm-prefix`     | บน Linux บังคับให้ npm prefix เป็น `~/.npm-global` หาก prefix ปัจจุบันเขียนไม่ได้          |
| `--help`               | แสดงวิธีใช้ (`-h`)                                                      |

  </Accordion>

  <Accordion title="Environment variables reference">

| ตัวแปร                                          | คำอธิบาย                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `OPENCLAW_PREFIX=<path>`                        | prefix สำหรับติดตั้ง                                                                             |
| `OPENCLAW_VERSION=<ver>`                        | เวอร์ชัน OpenClaw หรือ dist-tag                                                                  |
| `OPENCLAW_NODE_VERSION=<ver>`                   | เวอร์ชัน Node                                                                                    |
| `OPENCLAW_NO_ONBOARD=1`                         | ข้าม onboarding                                                                                  |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | ระดับล็อก npm                                                                                    |
| `OPENCLAW_GIT_DIR=<path>`                       | พาธค้นหาการล้างข้อมูลแบบ legacy (ใช้เมื่อลบเช็คเอาต์ซับโมดูล `Peekaboo` เก่า) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | ควบคุมพฤติกรรม sharp/libvips (ค่าเริ่มต้น: `1`)               |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### โฟลว์ (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    ต้องใช้ PowerShell 5+.
  </Step>
  <Step title="Ensure Node.js 22+">
    หากไม่มี จะพยายามติดตั้งผ่าน winget จากนั้น Chocolatey แล้วจึง Scoop
  </Step>
  <Step title="Install OpenClaw">
    - วิธี `npm` (ค่าเริ่มต้น): ติดตั้ง npm แบบ global โดยใช้ `-Tag` ที่เลือก
    - วิธี `git`: clone/อัปเดตรีโป ติดตั้ง/บิลด์ด้วย pnpm และติดตั้ง wrapper ที่ `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Post-install tasks">
    เพิ่มไดเรกทอรี bin ที่จำเป็นลงใน PATH ของผู้ใช้เมื่อเป็นไปได้ จากนั้นรัน `openclaw doctor --non-interactive` เมื่ออัปเกรดและการติดตั้งแบบ git (พยายามให้ดีที่สุด)
  </Step>
</Steps>

### ตัวอย่าง (install.ps1)

<Tabs>
  <Tab title="Default">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git install">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Custom git directory">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Dry run">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| แฟล็ก                       | คำอธิบาย                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | วิธีติดตั้ง (ค่าเริ่มต้น: `npm`)                            |
| `-Tag <tag>`                | npm dist-tag (ค่าเริ่มต้น: `latest`)                        |
| `-GitDir <path>`            | ไดเรกทอรีเช็คเอาต์ (ค่าเริ่มต้น: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | ข้าม onboarding                                                                                |
| `-NoGitUpdate`              | ข้าม `git pull`                                                                                |
| `-DryRun`                   | แสดงการกระทำเท่านั้น                                                                           |

  </Accordion>

  <Accordion title="Environment variables reference">

| ตัวแปร                               | คำอธิบาย           |
| ------------------------------------ | ------------------ |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | วิธีติดตั้ง        |
| `OPENCLAW_GIT_DIR=<path>`            | ไดเรกทอรีเช็คเอาต์ |
| `OPENCLAW_NO_ONBOARD=1`              | ข้าม onboarding    |
| `OPENCLAW_GIT_UPDATE=0`              | ปิดการ git pull    |
| `OPENCLAW_DRY_RUN=1`                 | โหมด dry run       |

  </Accordion>
</AccordionGroup>

<Note>
หากใช้ `-InstallMethod git` และไม่มี Git สคริปต์จะออกและพิมพ์ลิงก์ Git for Windows
</Note>

---

## CI และการทำงานอัตโนมัติ

ใช้แฟล็ก/ตัวแปรสภาพแวดล้อมแบบไม่โต้ตอบเพื่อให้ได้ผลลัพธ์ที่คาดเดาได้

<Tabs>
  <Tab title="install.sh (non-interactive npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (non-interactive git)">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh (JSON)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1 (skip onboarding)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## การแก้ไขปัญหา

<AccordionGroup>
  <Accordion title="Why is Git required?">
    จำเป็นต้องใช้ Git สำหรับวิธีติดตั้งแบบ `git`. สำหรับการติดตั้งแบบ `npm` ยังมีการตรวจสอบ/ติดตั้ง Git เพื่อหลีกเลี่ยงความล้มเหลวของ `spawn git ENOENT` เมื่อ dependencies ใช้ URL แบบ git
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    การตั้งค่า Linux บางแบบชี้ npm global prefix ไปยังพาธที่ root เป็นเจ้าของ 
    การตั้งค่า Linux บางแบบชี้ npm global prefix ไปยังพาธที่เป็นของ root `install.sh` สามารถสลับ prefix ไปที่ `~/.npm-global` และผนวกการ export PATH ลงในไฟล์ rc ของเชลล์ (เมื่อไฟล์เหล่านั้นมีอยู่)
  
  </Accordion>

  <Accordion title="sharp/libvips issues">
    
    สคริปต์ตั้งค่า `SHARP_IGNORE_GLOBAL_LIBVIPS=1` เป็นค่าเริ่มต้นเพื่อหลีกเลี่ยงการบิลด์ sharp กับ libvips ของระบบ หากต้องการ override: เพื่อเขียนทับ:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    ติดตั้ง Git for Windows ปิดแล้วเปิด PowerShell ใหม่ จากนั้นรันตัวติดตั้งอีกครั้ง
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    รัน `npm config get prefix` ผนวก `\bin` เพิ่มไดเรกทอรีนั้นลงใน PATH ของผู้ใช้ แล้วเปิด PowerShell ใหม่
  </Accordion>

  <Accordion title="openclaw not found after install">
    โดยปกติเป็นปัญหาเกี่ยวกับ PATH 
    โดยทั่วไปเป็นปัญหา PATH ดูที่ [Node.js troubleshooting](/install/node#troubleshooting)
  
  </Accordion>
</AccordionGroup>
