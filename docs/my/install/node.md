---
title: "Node.js"
summary: "OpenClaw အတွက် Node.js ကို ထည့်သွင်းတပ်ဆင်ခြင်းနှင့် ဖွဲ့စည်းပြင်ဆင်ခြင်း — ဗားရှင်းလိုအပ်ချက်များ၊ ထည့်သွင်းနည်းလမ်းများ၊ နှင့် PATH ပြဿနာဖြေရှင်းခြင်း"
read_when:
  - "OpenClaw ကို ထည့်သွင်းမတပ်ဆင်မီ Node.js ကို ထည့်သွင်းရန် လိုအပ်သောအခါ"
  - "OpenClaw ကို ထည့်သွင်းပြီးနောက် `openclaw` ကို မတွေ့နိုင်သောအခါ"
  - "`npm install -g` သည် ခွင့်ပြုချက် သို့မဟုတ် PATH ပြဿနာများကြောင့် မအောင်မြင်သောအခါ"
---

# Node.js

OpenClaw requires **Node 22 or newer**. The [installer script](/install#install-methods) will detect and install Node automatically — this page is for when you want to set up Node yourself and make sure everything is wired up correctly (versions, PATH, global installs).

## သင့်ဗားရှင်းကို စစ်ဆေးပါ

```bash
node -v
```

If this prints `v22.x.x` or higher, you're good. If Node isn't installed or the version is too old, pick an install method below.

## Node ကို ထည့်သွင်းခြင်း

<Tabs>
  <Tab title="macOS">
    **Homebrew** (အကြံပြု):

    ````
    ```bash
    brew install node
    ```
    
    သို့မဟုတ် [nodejs.org](https://nodejs.org/) မှ macOS installer ကို ဒေါင်းလုဒ်လုပ်နိုင်ပါသည်။
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
    
    သို့မဟုတ် version manager ကို အသုံးပြုနိုင်ပါသည် (အောက်တွင် ကြည့်ပါ)။
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (အကြံပြု):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    သို့မဟုတ် [nodejs.org](https://nodejs.org/) မှ Windows installer ကို ဒေါင်းလုဒ်လုပ်နိုင်ပါသည်။
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Version managers let you switch between Node versions easily. Popular options:

- [**fnm**](https://github.com/Schniz/fnm) — မြန်ဆန်ပြီး cross-platform
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linux တွင် အကျယ်ပြန့် အသုံးပြုကြသည်
- [**mise**](https://mise.jdx.dev/) — polyglot (Node, Python, Ruby စသည်)

fnm ဖြင့် အသုံးပြုသည့် ဥပမာ —

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Make sure your version manager is initialized in your shell startup file (`~/.zshrc` or `~/.bashrc`). If it isn't, `openclaw` may not be found in new terminal sessions because the PATH won't include Node's bin directory.
  </Warning>
</Accordion>

## ပြဿနာဖြေရှင်းခြင်း

### `openclaw: command not found`

ဤအခြေအနေသည် အများအားဖြင့် npm ၏ global bin directory သည် PATH ထဲတွင် မပါဝင်ခြင်းကြောင့် ဖြစ်ပါသည်။

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
    ရလဒ်ထဲတွင် `<npm-prefix>/bin` (macOS/Linux) သို့မဟုတ် `<npm-prefix>` (Windows) ကို ရှာပါ။
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc` သို့မဟုတ် `~/.bashrc` ထဲသို့ ထည့်ပါ —

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            ထို့နောက် terminal အသစ်တစ်ခုကို ဖွင့်ပါ (သို့မဟုတ် zsh တွင် `rehash` / bash တွင် `hash -r` ကို လည်ပတ်ပါ)။
          </Tab>
          <Tab title="Windows">
            `npm prefix -g` ၏ ရလဒ်ကို Settings → System → Environment Variables မှတဆင့် system PATH ထဲသို့ ထည့်ပါ။
          </Tab>
        </Tabs>
        ```

  </Step>
</Steps>

### `npm install -g` တွင် Permission errors (Linux)

`EACCES` အမှားများကို တွေ့ပါက npm ၏ global prefix ကို အသုံးပြုသူရေးခွင့်ရှိသော directory သို့ ပြောင်းလဲပါ —

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

အမြဲတမ်း အသက်ဝင်စေရန် `export PATH=...` လိုင်းကို သင့် `~/.bashrc` သို့မဟုတ် `~/.zshrc` ထဲသို့ ထည့်ပါ။
