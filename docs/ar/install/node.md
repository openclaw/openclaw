---
title: "Node.js"
summary: "تثبيت وتهيئة Node.js لـ OpenClaw — متطلبات الإصدارات، خيارات التثبيت، واستكشاف أخطاء PATH وإصلاحها"
read_when:
  - "تحتاج إلى تثبيت Node.js قبل تثبيت OpenClaw"
  - "قمت بتثبيت OpenClaw لكن يظهر الخطأ بأن الأمر `openclaw` غير موجود"
  - "يفشل `npm install -g` بسبب الأذونات أو مشاكل PATH"
---

# Node.js

يتطلّب OpenClaw **Node 22 أو أحدث**. سيقوم [نص التثبيت](/install#install-methods) باكتشاف Node وتثبيته تلقائيًا — هذه الصفحة مخصّصة للحالات التي تريد فيها إعداد Node يدويًا والتأكد من أن كل شيء مُهيّأ بشكل صحيح (الإصدارات، PATH، التثبيتات العامة).

## التحقق من الإصدار

```bash
node -v
```

إذا طبع هذا `v22.x.x` أو أحدث، فأنت جاهز. إذا لم يكن Node مُثبّتًا أو كان الإصدار قديمًا جدًا، فاختر طريقة تثبيت أدناه.

## تثبيت Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (موصى به):

    ````
    ```bash
    brew install node
    ```
    
    أو قم بتنزيل مُثبّت macOS من [nodejs.org](https://nodejs.org/).
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
    
    أو استخدم مدير إصدارات (انظر أدناه).
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (موصى به):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    أو قم بتنزيل مُثبّت Windows من [nodejs.org](https://nodejs.org/).
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  تتيح لك مدراء الإصدارات التبديل بين إصدارات Node بسهولة. من الخيارات الشائعة:

- [**fnm**](https://github.com/Schniz/fnm) — سريع ومتعدد المنصات
- [**nvm**](https://github.com/nvm-sh/nvm) — واسع الاستخدام على macOS/Linux
- [**mise**](https://mise.jdx.dev/) — متعدد اللغات (Node وPython وRuby وغيرها)

مثال باستخدام fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  تأكد من تهيئة مدير الإصدارات في ملف بدء تشغيل الصدفة لديك (`~/.zshrc` أو `~/.bashrc`). إذا لم يكن كذلك، فقد لا يتم العثور على `openclaw` في جلسات الطرفية الجديدة لأن PATH لن يتضمن دليل bin الخاص بـ Node.
  </Warning>
</Accordion>

## استكشاف الأخطاء وإصلاحها

### `openclaw: command not found`

يعني هذا في الغالب أن دليل bin العام لـ npm غير موجود على PATH.

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
    ابحث عن `<npm-prefix>/bin` (macOS/Linux) أو `<npm-prefix>` (Windows) في المخرجات.
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        أضِف إلى `~/.zshrc` أو `~/.bashrc`:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            ثم افتح طرفية جديدة (أو شغّل `rehash` في zsh / `hash -r` في bash).
          </Tab>
          <Tab title="Windows">
            أضِف مخرجات `npm prefix -g` إلى PATH الخاص بالنظام عبر الإعدادات → النظام → متغيرات البيئة.
          </Tab>
        </Tabs>
        ```

  </Step>
</Steps>

### أخطاء الأذونات على `npm install -g` (Linux)

إذا رأيت أخطاء `EACCES`، فقم بتبديل البادئة العامة لـ npm إلى دليل قابل للكتابة من قِبل المستخدم:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

أضِف سطر `export PATH=...` إلى `~/.bashrc` أو `~/.zshrc` لجعله دائمًا.
