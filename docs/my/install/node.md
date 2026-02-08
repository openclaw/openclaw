---
title: "Node.js"
summary: "OpenClaw အတွက် Node.js ကို ထည့်သွင်းတပ်ဆင်ခြင်းနှင့် ဖွဲ့စည်းပြင်ဆင်ခြင်း — ဗားရှင်းလိုအပ်ချက်များ၊ ထည့်သွင်းနည်းလမ်းများ၊ နှင့် PATH ပြဿနာဖြေရှင်းခြင်း"
read_when:
  - "OpenClaw ကို ထည့်သွင်းမတပ်ဆင်မီ Node.js ကို ထည့်သွင်းရန် လိုအပ်သောအခါ"
  - "OpenClaw ကို ထည့်သွင်းပြီးနောက် `openclaw` ကို မတွေ့နိုင်သောအခါ"
  - "`npm install -g` သည် ခွင့်ပြုချက် သို့မဟုတ် PATH ပြဿနာများကြောင့် မအောင်မြင်သောအခါ"
x-i18n:
  source_path: install/node.md
  source_hash: f848d6473a183090
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:37Z
---

# Node.js

OpenClaw သည် **Node 22 သို့မဟုတ် ထိုထက်အသစ်** လိုအပ်သည်။ [installer script](/install#install-methods) သည် Node ကို အလိုအလျောက် စစ်ဆေးပြီး ထည့်သွင်းပေးနိုင်သည် — သို့သော် Node ကို ကိုယ်တိုင် ပြင်ဆင်တပ်ဆင်လိုသည့်အခါ (ဗားရှင်းများ၊ PATH၊ global installs စသည်) အတွက် ဤစာမျက်နှာကို အသုံးပြုပါ။

## သင့်ဗားရှင်းကို စစ်ဆေးပါ

```bash
node -v
```

ဤအမိန့်၏ ရလဒ်သည် `v22.x.x` သို့မဟုတ် ထိုထက်မြင့်ပါက အဆင်ပြေပါသည်။ Node ကို မထည့်သွင်းရသေးပါက သို့မဟုတ် ဗားရှင်းဟောင်းနေပါက အောက်ပါ ထည့်သွင်းနည်းလမ်းများထဲမှ တစ်ခုကို ရွေးချယ်ပါ။

## Node ကို ထည့်သွင်းခြင်း

<Tabs>
  <Tab title="macOS">
    **Homebrew** (အကြံပြု):

    ```bash
    brew install node
    ```

    သို့မဟုတ် [nodejs.org](https://nodejs.org/) မှ macOS installer ကို ဒေါင်းလုဒ်လုပ်နိုင်ပါသည်။

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

    သို့မဟုတ် version manager ကို အသုံးပြုနိုင်ပါသည် (အောက်တွင် ကြည့်ပါ)။

  </Tab>
  <Tab title="Windows">
    **winget** (အကြံပြု):

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    သို့မဟုတ် [nodejs.org](https://nodejs.org/) မှ Windows installer ကို ဒေါင်းလုဒ်လုပ်နိုင်ပါသည်။

  </Tab>
</Tabs>

<Accordion title="Version manager ကို အသုံးပြုခြင်း (nvm, fnm, mise, asdf)">
  Version manager များသည် Node ဗားရှင်းများကို လွယ်ကူစွာ ပြောင်းလဲအသုံးပြုနိုင်စေပါသည်။ လူကြိုက်များသော ရွေးချယ်စရာများမှာ —

- [**fnm**](https://github.com/Schniz/fnm) — မြန်ဆန်ပြီး cross-platform
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linux တွင် အကျယ်ပြန့် အသုံးပြုကြသည်
- [**mise**](https://mise.jdx.dev/) — polyglot (Node, Python, Ruby စသည်)

fnm ဖြင့် အသုံးပြုသည့် ဥပမာ —

```bash
fnm install 22
fnm use 22
```

  <Warning>
  သင့် shell startup file (`~/.zshrc` သို့မဟုတ် `~/.bashrc`) တွင် version manager ကို initialize လုပ်ထားကြောင်း သေချာပါစေ။ မလုပ်ထားပါက PATH ထဲတွင် Node ၏ bin directory မပါဝင်သဖြင့် terminal session အသစ်များတွင် `openclaw` ကို မတွေ့နိုင်ပါ။
  </Warning>
</Accordion>

## ပြဿနာဖြေရှင်းခြင်း

### `openclaw: command not found`

ဤအခြေအနေသည် အများအားဖြင့် npm ၏ global bin directory သည် PATH ထဲတွင် မပါဝင်ခြင်းကြောင့် ဖြစ်ပါသည်။

<Steps>
  <Step title="npm ၏ global prefix ကို ရှာဖွေပါ">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="PATH ထဲတွင် ပါဝင်နေသလား စစ်ဆေးပါ">
    ```bash
    echo "$PATH"
    ```

    ရလဒ်ထဲတွင် `<npm-prefix>/bin` (macOS/Linux) သို့မဟုတ် `<npm-prefix>` (Windows) ကို ရှာပါ။

  </Step>
  <Step title="shell startup file ထဲသို့ ထည့်ပါ">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc` သို့မဟုတ် `~/.bashrc` ထဲသို့ ထည့်ပါ —

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        ထို့နောက် terminal အသစ်တစ်ခုကို ဖွင့်ပါ (သို့မဟုတ် zsh တွင် `rehash` / bash တွင် `hash -r` ကို လည်ပတ်ပါ)။
      </Tab>
      <Tab title="Windows">
        `npm prefix -g` ၏ ရလဒ်ကို Settings → System → Environment Variables မှတဆင့် system PATH ထဲသို့ ထည့်ပါ။
      </Tab>
    </Tabs>

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
