---
title: "Node.js"
summary: "OpenClaw کے لیے Node.js انسٹال اور کنفیگر کریں — ورژن کی ضروریات، انسٹال کے اختیارات، اور PATH کی خرابیوں کا ازالہ"
read_when:
  - "OpenClaw انسٹال کرنے سے پہلے آپ کو Node.js انسٹال کرنا ہو"
  - "آپ نے OpenClaw انسٹال کر لیا ہو لیکن `openclaw` کمانڈ نہ مل رہی ہو"
  - "`npm install -g` اجازتوں یا PATH کے مسائل کے ساتھ ناکام ہو رہا ہو"
---

# Node.js

OpenClaw کو **Node 22 یا نیا** درکار ہے۔ [installer script](/install#install-methods) خودکار طور پر Node کو ڈٹیکٹ اور انسٹال کرے گا — یہ صفحہ اُن صورتوں کے لیے ہے جب آپ Node خود سیٹ اپ کرنا چاہتے ہوں اور یقینی بنانا چاہتے ہوں کہ سب کچھ درست طریقے سے وائرڈ ہے (ورژنز، PATH، گلوبل انسٹالز)۔

## اپنا ورژن چیک کریں

```bash
node -v
```

اگر یہ `v22.x.x` یا اس سے زیادہ پرنٹ کرے تو آپ ٹھیک ہیں۔ اگر Node انسٹال نہیں ہے یا ورژن بہت پرانا ہے تو نیچے دیا گیا کوئی انسٹال طریقہ منتخب کریں۔

## Node انسٹال کریں

<Tabs>
  <Tab title="macOS">
    **Homebrew** (سفارش کردہ):

    ````
    ```bash
    brew install node
    ```
    
    یا [nodejs.org](https://nodejs.org/) سے macOS انسٹالر ڈاؤن لوڈ کریں۔
    ````

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ````
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```
    
    **Fedora / RHEL:**
    
    ```bash
    sudo dnf install nodejs
    ```
    
    یا ورژن مینیجر استعمال کریں (نیچے دیکھیں)۔
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (سفارش کردہ):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    یا [nodejs.org](https://nodejs.org/) سے Windows انسٹالر ڈاؤن لوڈ کریں۔
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  ورژن مینیجرز آپ کو Node کے ورژنز کے درمیان آسانی سے سوئچ کرنے دیتے ہیں۔ مقبول آپشنز:

- [**fnm**](https://github.com/Schniz/fnm) — تیز، کراس پلیٹ فارم
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linux پر وسیع پیمانے پر استعمال ہوتا ہے
- [**mise**](https://mise.jdx.dev/) — پولی گلاٹ (Node، Python، Ruby، وغیرہ)

fnm کے ساتھ مثال:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  یقینی بنائیں کہ آپ کا ورژن مینیجر آپ کی شیل اسٹارٹ اپ فائل (`~/.zshrc` یا `~/.bashrc`) میں initialized ہے۔ If it isn't, `openclaw` may not be found in new terminal sessions because the PATH won't include Node's bin directory.
  </Warning>
</Accordion>

## خرابیوں کا ازالہ

### `openclaw: command not found`

اس کا مطلب تقریباً ہمیشہ یہ ہوتا ہے کہ npm کی گلوبل bin ڈائریکٹری آپ کے PATH میں شامل نہیں ہے۔

<Steps>
  <Step title="Find your global npm prefix">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="Check if it's on your PATH">
    ```bash
    echo "$PATH"
    ```

    ```
    آؤٹ پٹ میں `<npm-prefix>/bin` (macOS/Linux) یا `<npm-prefix>` (Windows) تلاش کریں۔
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc` یا `~/.bashrc` میں شامل کریں:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            پھر نئی ٹرمینل کھولیں (یا zsh میں `rehash` چلائیں / bash میں `hash -r`)۔
          </Tab>
          <Tab title="Windows">
            `npm prefix -g` کے آؤٹ پٹ کو Settings → System → Environment Variables کے ذریعے اپنے سسٹم PATH میں شامل کریں۔
          </Tab>
        </Tabs>
        ```

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
