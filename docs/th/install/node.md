---
title: "Node.js"
summary: "ติดตั้งและกำหนดค่า Node.js สำหรับ OpenClaw — ข้อกำหนดเวอร์ชัน ตัวเลือกการติดตั้ง และการแก้ไขปัญหา PATH"
read_when:
  - "คุณต้องติดตั้ง Node.js ก่อนติดตั้ง OpenClaw"
  - "คุณติดตั้ง OpenClaw แล้วแต่ขึ้นว่าไม่พบคำสั่ง `openclaw`"
  - "`npm install -g` ล้มเหลวเนื่องจากปัญหาสิทธิ์หรือ PATH"
x-i18n:
  source_path: install/node.md
  source_hash: f848d6473a183090
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:21Z
---

# Node.js

OpenClaw ต้องใช้ **Node 22 หรือใหม่กว่า** [สคริปต์ตัวติดตั้ง](/install#install-methods) จะตรวจจับและติดตั้ง Node ให้อัตโนมัติ — หน้านี้มีไว้สำหรับกรณีที่คุณต้องการตั้งค่า Node ด้วยตนเองและตรวจสอบให้แน่ใจว่าทุกอย่างเชื่อมต่อถูกต้อง (เวอร์ชัน, PATH, การติดตั้งแบบ global)

## ตรวจสอบเวอร์ชันของคุณ

```bash
node -v
```

หากแสดง `v22.x.x` หรือสูงกว่า แสดงว่าใช้งานได้ หากยังไม่ได้ติดตั้ง Node หรือเวอร์ชันเก่าเกินไป ให้เลือกวิธีการติดตั้งด้านล่าง

## ติดตั้ง Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (แนะนำ):

    ```bash
    brew install node
    ```

    หรือดาวน์โหลดตัวติดตั้ง macOS จาก [nodejs.org](https://nodejs.org/)

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL:**

    ```bash
    sudo dnf install nodejs
    ```

    หรือใช้ตัวจัดการเวอร์ชัน (ดูด้านล่าง)

  </Tab>
  <Tab title="Windows">
    **winget** (แนะนำ):

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    หรือดาวน์โหลดตัวติดตั้ง Windows จาก [nodejs.org](https://nodejs.org/)

  </Tab>
</Tabs>

<Accordion title="การใช้ตัวจัดการเวอร์ชัน (nvm, fnm, mise, asdf)">
  ตัวจัดการเวอร์ชันช่วยให้คุณสลับเวอร์ชัน Node ได้อย่างง่ายดาย ตัวเลือกยอดนิยมได้แก่:

- [**fnm**](https://github.com/Schniz/fnm) — เร็ว และรองรับหลายแพลตฟอร์ม
- [**nvm**](https://github.com/nvm-sh/nvm) — ใช้อย่างแพร่หลายบน macOS/Linux
- [**mise**](https://mise.jdx.dev/) — รองรับหลายภาษา (Node, Python, Ruby ฯลฯ)

ตัวอย่างด้วย fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  ตรวจสอบให้แน่ใจว่าตัวจัดการเวอร์ชันของคุณถูกเริ่มต้นในไฟล์เริ่มต้นของเชลล์ (`~/.zshrc` หรือ `~/.bashrc`) หากไม่ได้ตั้งค่าไว้ `openclaw` อาจไม่ถูกพบในเซสชันเทอร์มินัลใหม่ เนื่องจาก PATH จะไม่รวมไดเรกทอรี bin ของ Node
  </Warning>
</Accordion>

## การแก้ไขปัญหา

### `openclaw: command not found`

สาเหตุเกือบทั้งหมดคือไดเรกทอรี bin แบบ global ของ npm ไม่อยู่ใน PATH ของคุณ

<Steps>
  <Step title="ค้นหา npm prefix แบบ global">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="ตรวจสอบว่าอยู่ใน PATH หรือไม่">
    ```bash
    echo "$PATH"
    ```

    มองหา `<npm-prefix>/bin` (macOS/Linux) หรือ `<npm-prefix>` (Windows) ในเอาต์พุต

  </Step>
  <Step title="เพิ่มลงในไฟล์เริ่มต้นของเชลล์">
    <Tabs>
      <Tab title="macOS / Linux">
        เพิ่มลงใน `~/.zshrc` หรือ `~/.bashrc`:

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        จากนั้นเปิดเทอร์มินัลใหม่ (หรือรัน `rehash` ใน zsh / `hash -r` ใน bash)
      </Tab>
      <Tab title="Windows">
        เพิ่มเอาต์พุตของ `npm prefix -g` ลงใน system PATH ผ่าน Settings → System → Environment Variables
      </Tab>
    </Tabs>

  </Step>
</Steps>

### ข้อผิดพลาดด้านสิทธิ์บน `npm install -g` (Linux)

หากคุณเห็นข้อผิดพลาด `EACCES` ให้เปลี่ยน npm global prefix ไปยังไดเรกทอรีที่ผู้ใช้มีสิทธิ์เขียนได้:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

เพิ่มบรรทัด `export PATH=...` ลงใน `~/.bashrc` หรือ `~/.zshrc` เพื่อให้มีผลถาวร
