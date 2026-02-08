---
title: "Node.js"
summary: "OpenClaw के लिए Node.js स्थापित और विन्यस्त करें — संस्करण आवश्यकताएँ, इंस्टॉल विकल्प, और PATH समस्या-निवारण"
read_when:
  - "OpenClaw स्थापित करने से पहले आपको Node.js स्थापित करना है"
  - "आपने OpenClaw स्थापित किया है लेकिन `openclaw` कमांड नहीं मिला"
  - "`npm install -g` अनुमतियों या PATH संबंधी समस्याओं के साथ विफल हो रहा है"
x-i18n:
  source_path: install/node.md
  source_hash: f848d6473a183090
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:27Z
---

# Node.js

OpenClaw के लिए **Node 22 या उससे नया** आवश्यक है। [इंस्टॉलर स्क्रिप्ट](/install#install-methods) Node का स्वतः पता लगाकर उसे स्थापित कर देगी — यह पृष्ठ तब के लिए है जब आप Node स्वयं सेट अप करना चाहते हैं और यह सुनिश्चित करना चाहते हैं कि सब कुछ सही तरह से जुड़ा हो (संस्करण, PATH, ग्लोबल इंस्टॉल)।

## अपना संस्करण जाँचें

```bash
node -v
```

यदि यह `v22.x.x` या उससे अधिक दिखाता है, तो सब ठीक है। यदि Node स्थापित नहीं है या संस्करण बहुत पुराना है, तो नीचे दिए गए किसी इंस्टॉल तरीके को चुनें।

## Node स्थापित करें

<Tabs>
  <Tab title="macOS">
    **Homebrew** (अनुशंसित):

    ```bash
    brew install node
    ```

    या [nodejs.org](https://nodejs.org/) से macOS इंस्टॉलर डाउनलोड करें।

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

    या किसी संस्करण प्रबंधक का उपयोग करें (नीचे देखें)।

  </Tab>
  <Tab title="Windows">
    **winget** (अनुशंसित):

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    या [nodejs.org](https://nodejs.org/) से Windows इंस्टॉलर डाउनलोड करें।

  </Tab>
</Tabs>

<Accordion title="संस्करण प्रबंधक का उपयोग करना (nvm, fnm, mise, asdf)">
  संस्करण प्रबंधक आपको Node के विभिन्न संस्करणों के बीच आसानी से स्विच करने देते हैं। लोकप्रिय विकल्प:

- [**fnm**](https://github.com/Schniz/fnm) — तेज़, क्रॉस-प्लैटफ़ॉर्म
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linux पर व्यापक रूप से उपयोग किया जाता है
- [**mise**](https://mise.jdx.dev/) — बहुभाषी (Node, Python, Ruby, आदि)

fnm के साथ उदाहरण:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  सुनिश्चित करें कि आपका संस्करण प्रबंधक आपकी शेल स्टार्टअप फ़ाइल (`~/.zshrc` या `~/.bashrc`) में इनिशियलाइज़ हो। यदि ऐसा नहीं है, तो नए टर्मिनल सत्रों में `openclaw` नहीं मिल सकता क्योंकि PATH में Node की bin निर्देशिका शामिल नहीं होगी।
  </Warning>
</Accordion>

## समस्या-निवारण

### `openclaw: command not found`

इसका अर्थ लगभग हमेशा यह होता है कि npm की ग्लोबल bin निर्देशिका आपके PATH में नहीं है।

<Steps>
  <Step title="अपना ग्लोबल npm prefix खोजें">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="जाँचें कि क्या यह आपके PATH में है">
    ```bash
    echo "$PATH"
    ```

    आउटपुट में `<npm-prefix>/bin` (macOS/Linux) या `<npm-prefix>` (Windows) खोजें।

  </Step>
  <Step title="इसे अपनी शेल स्टार्टअप फ़ाइल में जोड़ें">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc` या `~/.bashrc` में जोड़ें:

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        फिर नया टर्मिनल खोलें (या zsh में `rehash` / bash में `hash -r` चलाएँ)।
      </Tab>
      <Tab title="Windows">
        Settings → System → Environment Variables के माध्यम से `npm prefix -g` के आउटपुट को अपने सिस्टम PATH में जोड़ें।
      </Tab>
    </Tabs>

  </Step>
</Steps>

### `npm install -g` पर अनुमति संबंधी त्रुटियाँ (Linux)

यदि आपको `EACCES` त्रुटियाँ दिखें, तो npm का ग्लोबल prefix किसी उपयोगकर्ता-लिखने योग्य निर्देशिका पर स्विच करें:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

इसे स्थायी बनाने के लिए `export PATH=...` पंक्ति को अपनी `~/.bashrc` या `~/.zshrc` में जोड़ें।
