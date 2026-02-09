---
summary: "OpenClaw स्थापित करें — इंस्टॉलर स्क्रिप्ट, npm/pnpm, स्रोत से, Docker, और अन्य"
read_when:
  - आपको Getting Started त्वरित प्रारंभ के अलावा किसी अन्य इंस्टॉल विधि की आवश्यकता है
  - आप किसी क्लाउड प्लेटफ़ॉर्म पर डिप्लॉय करना चाहते हैं
  - आपको अपडेट, माइग्रेट, या अनइंस्टॉल करना है
title: "स्थापना"
---

# स्थापना

क्या आपने पहले ही [Getting Started](/start/getting-started) फॉलो कर लिया है? आप पूरी तरह तैयार हैं — यह पेज वैकल्पिक इंस्टॉल तरीकों, प्लेटफ़ॉर्म-विशिष्ट निर्देशों और मेंटेनेंस के लिए है।

## सिस्टम आवश्यकताएँ

- **[Node 22+](/install/node)** (यदि अनुपस्थित हो तो [इंस्टॉलर स्क्रिप्ट](#install-methods) इसे स्थापित कर देगी)
- macOS, Linux, या Windows
- `pnpm` केवल तभी, जब आप स्रोत से बिल्ड करते हैं

<Note>
Windows पर, हम दृढ़ता से अनुशंसा करते हैं कि OpenClaw को [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) के अंतर्गत चलाएँ।
</Note>

## इंस्टॉल विधियाँ

<Tip>
**installer script** OpenClaw इंस्टॉल करने का अनुशंसित तरीका है। यह एक ही स्टेप में Node detection, इंस्टॉलेशन और onboarding संभालता है।
</Tip>

<AccordionGroup>
  <Accordion title="Installer script" icon="rocket" defaultOpen>
    CLI डाउनलोड करता है, npm के माध्यम से इसे वैश्विक रूप से स्थापित करता है, और ऑनबोर्डिंग विज़ार्ड प्रारंभ करता है।

    ```
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
    
    बस इतना ही — यह स्क्रिप्ट Node की पहचान, स्थापना, और ऑनबोर्डिंग संभालती है।
    
    ऑनबोर्डिंग छोड़कर केवल बाइनरी स्थापित करने के लिए:
    
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
    
    सभी फ़्लैग, env vars, और CI/ऑटोमेशन विकल्पों के लिए, [Installer internals](/install/installer) देखें।
    ```

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    यदि आपके पास पहले से Node 22+ है और आप इंस्टॉल को स्वयं प्रबंधित करना चाहते हैं:

    ```
    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```
    
        <Accordion title="sharp बिल्ड त्रुटियाँ?">
          यदि आपके पास libvips वैश्विक रूप से स्थापित है (macOS पर Homebrew के माध्यम से सामान्य) और `sharp` विफल हो जाता है, तो प्रीबिल्ट बाइनरी को बाध्य करें:
    
          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```
    
          यदि आपको `sharp: Please add node-gyp to your dependencies` दिखाई देता है, तो या तो बिल्ड टूलिंग स्थापित करें (macOS: Xcode CLT + `npm install -g node-gyp`) या ऊपर दिए गए env var का उपयोग करें।
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```
    
        <Note>
        pnpm को बिल्ड स्क्रिप्ट वाले पैकेजों के लिए स्पष्ट अनुमोदन की आवश्यकता होती है। पहली इंस्टॉल के बाद यदि "Ignored build scripts" चेतावनी दिखाई दे, तो `pnpm approve-builds -g` चलाएँ और सूचीबद्ध पैकेजों का चयन करें।
        </Note>
      </Tab>
    </Tabs>
    ```

  </Accordion>

  <Accordion title="From source" icon="github">
    योगदानकर्ताओं या उन सभी के लिए जो स्थानीय चेकआउट से चलाना चाहते हैं।

    ```
    <Steps>
      <Step title="Clone और build करें">
        [OpenClaw repo](https://github.com/openclaw/openclaw) को clone करें और build करें:
    
        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="CLI को link करें">
        `openclaw` कमांड को वैश्विक रूप से उपलब्ध करें:
    
        ```bash
        pnpm link --global
        ```
    
        वैकल्पिक रूप से, link को छोड़ दें और repo के अंदर से `pnpm openclaw ...` के माध्यम से कमांड चलाएँ।
      </Step>
      <Step title="ऑनबोर्डिंग चलाएँ">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>
    
    गहन विकास वर्कफ़्लो के लिए, [Setup](/start/setup) देखें।
    ```

  </Accordion>
</AccordionGroup>

## अन्य इंस्टॉल विधियाँ

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    कंटेनराइज़्ड या हेडलेस डिप्लॉयमेंट।
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Nix के माध्यम से घोषणात्मक इंस्टॉल।
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    स्वचालित फ़्लीट प्रोविज़निंग।
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Bun runtime के माध्यम से केवल CLI उपयोग।
  </Card>
</CardGroup>

## इंस्टॉल के बाद

सुनिश्चित करें कि सब कुछ सही तरह से काम कर रहा है:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## समस्या-निवारण: `openclaw` नहीं मिला

<Accordion title="PATH diagnosis and fix">
  त्वरित निदान:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

यदि `$(npm prefix -g)/bin` (macOS/Linux) या `$(npm prefix -g)` (Windows) आपके `$PATH` में **नहीं** है, तो आपका शेल वैश्विक npm बाइनरी (जिसमें `openclaw` शामिल है) नहीं ढूँढ पा रहा है।

समाधान — इसे अपनी शेल स्टार्टअप फ़ाइल (`~/.zshrc` या `~/.bashrc`) में जोड़ें:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Windows पर, `npm prefix -g` के आउटपुट को अपने PATH में जोड़ें।

फिर एक नया टर्मिनल खोलें (या zsh में `rehash` / bash में `hash -r`)। </Accordion>

## अपडेट / अनइंस्टॉल

<CardGroup cols={3}>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    OpenClaw को अद्यतन रखें।
  </Card>
  <Card title="Migrating" href="/install/migrating" icon="arrow-right">
    किसी नए मशीन पर स्थानांतरित करें।
  </Card>
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">
    OpenClaw को पूरी तरह से हटाएँ।
  </Card>
</CardGroup>
