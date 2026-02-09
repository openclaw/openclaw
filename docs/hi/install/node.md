---
title: "Node.js"
summary: "OpenClaw के लिए Node.js स्थापित और विन्यस्त करें — संस्करण आवश्यकताएँ, इंस्टॉल विकल्प, और PATH समस्या-निवारण"
read_when:
  - "OpenClaw स्थापित करने से पहले आपको Node.js स्थापित करना है"
  - "आपने OpenClaw स्थापित किया है लेकिन `openclaw` कमांड नहीं मिला"
  - "`npm install -g` अनुमतियों या PATH संबंधी समस्याओं के साथ विफल हो रहा है"
---

# Node.js

OpenClaw को **Node 22 या उससे नया** चाहिए। [installer script](/install#install-methods) Node को अपने आप detect और install कर देगा — यह पेज तब के लिए है जब आप Node को खुद सेटअप करना चाहते हैं और सुनिश्चित करना चाहते हैं कि सब कुछ सही तरह से जुड़ा हुआ है (versions, PATH, global installs)।

## अपना संस्करण जाँचें

```bash
node -v
```

यदि यह `v22.x.x` या उससे ऊपर प्रिंट करता है, तो आप ठीक हैं। यदि Node इंस्टॉल नहीं है या वर्ज़न बहुत पुराना है, तो नीचे दिए गए किसी इंस्टॉल मेथड को चुनें।

## Node स्थापित करें

<Tabs>
  <Tab title="macOS">
    **Homebrew** (अनुशंसित):

    ````
    ```bash
    brew install node
    ```
    
    या [nodejs.org](https://nodejs.org/) से macOS इंस्टॉलर डाउनलोड करें।
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
    
    या किसी संस्करण प्रबंधक का उपयोग करें (नीचे देखें)।
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (अनुशंसित):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    या [nodejs.org](https://nodejs.org/) से Windows इंस्टॉलर डाउनलोड करें।
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Version managers आपको Node versions के बीच आसानी से स्विच करने देते हैं। लोकप्रिय विकल्प:

- [**fnm**](https://github.com/Schniz/fnm) — तेज़, क्रॉस-प्लैटफ़ॉर्म
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linux पर व्यापक रूप से उपयोग किया जाता है
- [**mise**](https://mise.jdx.dev/) — बहुभाषी (Node, Python, Ruby, आदि)

fnm के साथ उदाहरण:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  सुनिश्चित करें कि आपका version manager आपके शेल स्टार्टअप फ़ाइल (`~/.zshrc` या `~/.bashrc`) में initialized है। यदि ऐसा नहीं है, तो नई टर्मिनल सेशंस में `openclaw` नहीं मिलेगा क्योंकि PATH में Node की bin डिरेक्टरी शामिल नहीं होगी।
  </Warning>
</Accordion>

## समस्या-निवारण

### `openclaw: command not found`

इसका अर्थ लगभग हमेशा यह होता है कि npm की ग्लोबल bin निर्देशिका आपके PATH में नहीं है।

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
    आउटपुट में `<npm-prefix>/bin` (macOS/Linux) या `<npm-prefix>` (Windows) खोजें।
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc` या `~/.bashrc` में जोड़ें:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            फिर नया टर्मिनल खोलें (या zsh में `rehash` / bash में `hash -r` चलाएँ)।
          </Tab>
          <Tab title="Windows">
            Settings → System → Environment Variables के माध्यम से `npm prefix -g` के आउटपुट को अपने सिस्टम PATH में जोड़ें।
          </Tab>
        </Tabs>
        ```

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
