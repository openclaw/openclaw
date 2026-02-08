---
title: "Node.js"
summary: "OpenClaw کے لیے Node.js انسٹال اور کنفیگر کریں — ورژن کی ضروریات، انسٹال کے اختیارات، اور PATH کی خرابیوں کا ازالہ"
read_when:
  - "OpenClaw انسٹال کرنے سے پہلے آپ کو Node.js انسٹال کرنا ہو"
  - "آپ نے OpenClaw انسٹال کر لیا ہو لیکن `openclaw` کمانڈ نہ مل رہی ہو"
  - "`npm install -g` اجازتوں یا PATH کے مسائل کے ساتھ ناکام ہو رہا ہو"
x-i18n:
  source_path: install/node.md
  source_hash: f848d6473a183090
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:24Z
---

# Node.js

OpenClaw کے لیے **Node 22 یا اس سے نیا** درکار ہے۔ [انسٹالر اسکرپٹ](/install#install-methods) خودکار طور پر Node کو شناخت کر کے انسٹال کر دے گا — یہ صفحہ اس صورت کے لیے ہے جب آپ Node کو خود سیٹ اپ کرنا چاہتے ہوں اور یہ یقینی بنانا چاہتے ہوں کہ سب کچھ درست طور پر منسلک ہے (ورژنز، PATH، گلوبل انسٹالز)۔

## اپنا ورژن چیک کریں

```bash
node -v
```

اگر یہ `v22.x.x` یا اس سے زیادہ پرنٹ کرے تو سب ٹھیک ہے۔ اگر Node انسٹال نہیں ہے یا ورژن بہت پرانا ہے تو نیچے دیا گیا کوئی انسٹال طریقہ منتخب کریں۔

## Node انسٹال کریں

<Tabs>
  <Tab title="macOS">
    **Homebrew** (سفارش کردہ):

    ```bash
    brew install node
    ```

    یا [nodejs.org](https://nodejs.org/) سے macOS انسٹالر ڈاؤن لوڈ کریں۔

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

    یا ورژن مینیجر استعمال کریں (نیچے دیکھیں)۔

  </Tab>
  <Tab title="Windows">
    **winget** (سفارش کردہ):

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    یا [nodejs.org](https://nodejs.org/) سے Windows انسٹالر ڈاؤن لوڈ کریں۔

  </Tab>
</Tabs>

<Accordion title="ورژن مینیجر کا استعمال (nvm, fnm, mise, asdf)">
  ورژن مینیجرز آپ کو Node کے مختلف ورژنز کے درمیان آسانی سے سوئچ کرنے دیتے ہیں۔ مقبول اختیارات:

- [**fnm**](https://github.com/Schniz/fnm) — تیز، کراس پلیٹ فارم
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linux پر وسیع پیمانے پر استعمال ہوتا ہے
- [**mise**](https://mise.jdx.dev/) — پولی گلاٹ (Node، Python، Ruby، وغیرہ)

fnm کے ساتھ مثال:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  یقینی بنائیں کہ آپ کا ورژن مینیجر آپ کی شیل کی اسٹارٹ اپ فائل میں initialized ہو (`~/.zshrc` یا `~/.bashrc`)۔ اگر ایسا نہیں ہے تو نئی ٹرمینل سیشنز میں `openclaw` نہیں مل سکتا کیونکہ PATH میں Node کی bin ڈائریکٹری شامل نہیں ہوگی۔
  </Warning>
</Accordion>

## خرابیوں کا ازالہ

### `openclaw: command not found`

اس کا مطلب تقریباً ہمیشہ یہ ہوتا ہے کہ npm کی گلوبل bin ڈائریکٹری آپ کے PATH میں شامل نہیں ہے۔

<Steps>
  <Step title="اپنا گلوبل npm prefix معلوم کریں">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="چیک کریں کہ آیا یہ PATH میں ہے">
    ```bash
    echo "$PATH"
    ```

    آؤٹ پٹ میں `<npm-prefix>/bin` (macOS/Linux) یا `<npm-prefix>` (Windows) تلاش کریں۔

  </Step>
  <Step title="اسے اپنی شیل اسٹارٹ اپ فائل میں شامل کریں">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc` یا `~/.bashrc` میں شامل کریں:

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        پھر نئی ٹرمینل کھولیں (یا zsh میں `rehash` چلائیں / bash میں `hash -r`)۔
      </Tab>
      <Tab title="Windows">
        `npm prefix -g` کے آؤٹ پٹ کو Settings → System → Environment Variables کے ذریعے اپنے سسٹم PATH میں شامل کریں۔
      </Tab>
    </Tabs>

  </Step>
</Steps>

### `npm install -g` پر اجازت کی غلطیاں (Linux)

اگر آپ کو `EACCES` جیسی غلطیاں نظر آئیں تو npm کے گلوبل prefix کو کسی ایسے ڈائریکٹری میں تبدیل کریں جس پر صارف کو لکھنے کی اجازت ہو:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

اسے مستقل بنانے کے لیے `export PATH=...` والی لائن کو اپنے `~/.bashrc` یا `~/.zshrc` میں شامل کریں۔
