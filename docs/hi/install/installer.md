---
summary: "इंस्टॉलर स्क्रिप्ट्स कैसे काम करती हैं (install.sh, install-cli.sh, install.ps1), फ़्लैग्स, और स्वचालन"
read_when:
  - आप `openclaw.ai/install.sh` को समझना चाहते हैं
  - आप इंस्टॉल को स्वचालित करना चाहते हैं (CI / हेडलेस)
  - आप GitHub चेकआउट से इंस्टॉल करना चाहते हैं
title: "इंस्टॉलर के आंतरिक विवरण"
---

# इंस्टॉलर के आंतरिक विवरण

OpenClaw तीन इंस्टॉलर स्क्रिप्ट्स प्रदान करता है, जो `openclaw.ai` से परोसी जाती हैं।

| Script                             | Platform                                | यह क्या करता है                                                                                                                                   |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | आवश्यकता होने पर Node इंस्टॉल करता है, npm (डिफ़ॉल्ट) या git के माध्यम से OpenClaw इंस्टॉल करता है, और ऑनबोर्डिंग चला सकता है। |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | Node + OpenClaw को एक लोकल प्रीफ़िक्स (`~/.openclaw`) में इंस्टॉल करता है। root की आवश्यकता नहीं है।                           |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | आवश्यकता होने पर Node इंस्टॉल करता है, npm (डिफ़ॉल्ट) या git के माध्यम से OpenClaw इंस्टॉल करता है, और ऑनबोर्डिंग चला सकता है। |

## त्वरित कमांड

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
यदि इंस्टॉल सफल हो जाता है लेकिन नई टर्मिनल में `openclaw` नहीं मिलता, तो [Node.js समस्या-निवारण](/install/node#troubleshooting) देखें।
</Note>

---

## install.sh

<Tip>
macOS/Linux/WSL पर अधिकांश इंटरैक्टिव इंस्टॉल के लिए अनुशंसित।
</Tip>

### प्रवाह (install.sh)

<Steps>
  <Step title="Detect OS">
    macOS और Linux (WSL सहित) को सपोर्ट करता है। यदि macOS डिटेक्ट होता है, तो Homebrew मौजूद न होने पर उसे इंस्टॉल करता है।
  </Step>
  <Step title="Ensure Node.js 22+">
    Node संस्करण की जाँच करता है और आवश्यकता होने पर Node 22 इंस्टॉल करता है (macOS पर Homebrew, Linux apt/dnf/yum पर NodeSource सेटअप स्क्रिप्ट्स)।
  </Step>
  <Step title="Ensure Git">
    अनुपस्थित होने पर Git इंस्टॉल करता है।
  </Step>
  <Step title="Install OpenClaw">
    - `npm` विधि (डिफ़ॉल्ट): वैश्विक npm इंस्टॉल
    - `git` विधि: रिपॉज़िटरी क्लोन/अपडेट, pnpm से डिपेंडेंसीज़ इंस्टॉल, बिल्ड, फिर `~/.local/bin/openclaw` पर रैपर इंस्टॉल
  </Step>
  <Step title="Post-install tasks">
    - अपग्रेड्स और git इंस्टॉल पर `openclaw doctor --non-interactive` चलाता है (सर्वोत्तम प्रयास)
    - उपयुक्त होने पर ऑनबोर्डिंग का प्रयास करता है (TTY उपलब्ध, ऑनबोर्डिंग अक्षम नहीं, और बूटस्ट्रैप/विन्यास जाँच पास)
    - डिफ़ॉल्ट रूप से `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### सोर्स चेकआउट पहचान

यदि OpenClaw चेकआउट के भीतर चलाया जाए (`package.json` + `pnpm-workspace.yaml`), तो स्क्रिप्ट यह विकल्प देती है:

- चेकआउट का उपयोग करें (`git`), या
- वैश्विक इंस्टॉल का उपयोग करें (`npm`)

यदि कोई TTY उपलब्ध नहीं है और कोई इंस्टॉल विधि सेट नहीं है, तो यह `npm` पर डिफ़ॉल्ट करता है और चेतावनी देता है।

अमान्य विधि चयन या अमान्य `--install-method` मानों के लिए स्क्रिप्ट `2` कोड के साथ बाहर निकलती है।

### उदाहरण (install.sh)

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

| Flag                              | विवरण                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | इंस्टॉल मेथड चुनें (डिफ़ॉल्ट: `npm`)। उपनाम: `--method`    |
| `--npm`                           | npm विधि के लिए शॉर्टकट                                                                                       |
| `--git`                           | git मेथड के लिए शॉर्टकट। उपनाम: `--github`                                                    |
| `--version <version\\|dist-tag>` | npm संस्करण या dist-tag (डिफ़ॉल्ट: `latest`)                               |
| `--beta`                          | उपलब्ध होने पर beta dist-tag का उपयोग करें, अन्यथा `latest` पर फ़ॉलबैक                                        |
| `--git-dir <path>`                | Checkout directory (default: `~/openclaw`)। उपनाम: `--dir` |
| `--no-git-update`                 | मौजूदा चेकआउट के लिए `git pull` छोड़ें                                                                        |
| `--no-prompt`                     | प्रॉम्प्ट्स अक्षम करें                                                                                        |
| `--no-onboard`                    | ऑनबोर्डिंग छोड़ें                                                                                             |
| `--onboard`                       | ऑनबोर्डिंग सक्षम करें                                                                                         |
| `--dry-run`                       | परिवर्तन लागू किए बिना कार्रवाइयाँ प्रिंट करें                                                                |
| `--verbose`                       | डिबग आउटपुट सक्षम करें (`set -x`, npm नोटिस-स्तर लॉग्स)                                    |
| `--help`                          | उपयोग दिखाएँ (`-h`)                                                                        |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                        | विवरण                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | इंस्टॉल विधि                                                                            |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | npm संस्करण या dist-tag                                                                 |
| `OPENCLAW_BETA=0\\|1`                          | उपलब्ध होने पर beta का उपयोग                                                            |
| `OPENCLAW_GIT_DIR=<path>`                       | चेकआउट निर्देशिका                                                                       |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | git अपडेट्स टॉगल करें                                                                   |
| `OPENCLAW_NO_PROMPT=1`                          | प्रॉम्प्ट्स अक्षम करें                                                                  |
| `OPENCLAW_NO_ONBOARD=1`                         | ऑनबोर्डिंग छोड़ें                                                                       |
| `OPENCLAW_DRY_RUN=1`                            | ड्राई रन मोड                                                                            |
| `OPENCLAW_VERBOSE=1`                            | डिबग मोड                                                                                |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm लॉग स्तर                                                                            |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | sharp/libvips व्यवहार नियंत्रित करें (डिफ़ॉल्ट: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
ऐसे परिवेशों के लिए डिज़ाइन किया गया है जहाँ आप सब कुछ एक स्थानीय प्रीफ़िक्स (डिफ़ॉल्ट `~/.openclaw`) के अंतर्गत चाहते हैं और सिस्टम Node पर निर्भरता नहीं चाहते।
</Info>

### प्रवाह (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Node टारबॉल (डिफ़ॉल्ट `22.22.0`) को `<prefix>/tools/node-v<version>` में डाउनलोड करता है और SHA-256 सत्यापित करता है।
  </Step>
  <Step title="Ensure Git">
    यदि Git अनुपस्थित है, तो Linux पर apt/dnf/yum या macOS पर Homebrew के माध्यम से इंस्टॉल का प्रयास करता है।
  </Step>
  <Step title="Install OpenClaw under prefix">
    `--prefix <prefix>` का उपयोग करके npm से इंस्टॉल करता है, फिर `<prefix>/bin/openclaw` पर रैपर लिखता है।
  </Step>
</Steps>

### उदाहरण (install-cli.sh)

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

| Flag                   | विवरण                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `--prefix <path>`      | इंस्टॉल प्रीफ़िक्स (डिफ़ॉल्ट: `~/.openclaw`)                         |
| `--version <ver>`      | OpenClaw संस्करण या dist-tag (डिफ़ॉल्ट: `latest`)                    |
| `--node-version <ver>` | Node संस्करण (डिफ़ॉल्ट: `22.22.0`)                                   |
| `--json`               | NDJSON इवेंट्स उत्सर्जित करें                                                                           |
| `--onboard`            | इंस्टॉल के बाद `openclaw onboard` चलाएँ                                                                 |
| `--no-onboard`         | ऑनबोर्डिंग छोड़ें (डिफ़ॉल्ट)                                                         |
| `--set-npm-prefix`     | Linux पर, यदि वर्तमान प्रीफ़िक्स लिखने योग्य नहीं है तो npm प्रीफ़िक्स को `~/.npm-global` पर बाध्य करें |
| `--help`               | उपयोग दिखाएँ (`-h`)                                                                  |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                        | विवरण                                                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | इंस्टॉल प्रीफ़िक्स                                                                                               |
| `OPENCLAW_VERSION=<ver>`                        | OpenClaw संस्करण या dist-tag                                                                                     |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Node संस्करण                                                                                                     |
| `OPENCLAW_NO_ONBOARD=1`                         | ऑनबोर्डिंग छोड़ें                                                                                                |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm लॉग स्तर                                                                                                     |
| `OPENCLAW_GIT_DIR=<path>`                       | लेगेसी क्लीनअप लुकअप पाथ (पुराने `Peekaboo` सबमॉड्यूल चेकआउट को हटाते समय उपयोग किया जाता है) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | sharp/libvips व्यवहार नियंत्रित करें (डिफ़ॉल्ट: `1`)                          |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### प्रवाह (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    PowerShell 5+ आवश्यक है।
  </Step>
  <Step title="Ensure Node.js 22+">
    यदि अनुपस्थित है, तो winget, फिर Chocolatey, फिर Scoop के माध्यम से इंस्टॉल का प्रयास करता है।
  </Step>
  <Step title="Install OpenClaw">
    - `npm` विधि (डिफ़ॉल्ट): चयनित `-Tag` का उपयोग करके वैश्विक npm इंस्टॉल
    - `git` विधि: रिपॉज़िटरी क्लोन/अपडेट, pnpm से इंस्टॉल/बिल्ड, और `%USERPROFILE%\.local\bin\openclaw.cmd` पर रैपर इंस्टॉल
  </Step>
  <Step title="Post-install tasks">
    संभव होने पर आवश्यक bin निर्देशिका को उपयोगकर्ता PATH में जोड़ता है, फिर अपग्रेड्स और git इंस्टॉल पर `openclaw doctor --non-interactive` चलाता है (सर्वोत्तम प्रयास)।
  </Step>
</Steps>

### उदाहरण (install.ps1)

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

| Flag                        | विवरण                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `-InstallMethod npm\\|git` | इंस्टॉल विधि (डिफ़ॉल्ट: `npm`)                          |
| `-Tag <tag>`                | npm dist-tag (डिफ़ॉल्ट: `latest`)                       |
| `-GitDir <path>`            | चेकआउट निर्देशिका (डिफ़ॉल्ट: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | ऑनबोर्डिंग छोड़ें                                                                          |
| `-NoGitUpdate`              | `git pull` छोड़ें                                                                          |
| `-DryRun`                   | केवल कार्रवाइयाँ प्रिंट करें                                                               |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                             | विवरण               |
| ------------------------------------ | ------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | इंस्टॉल विधि        |
| `OPENCLAW_GIT_DIR=<path>`            | चेकआउट निर्देशिका   |
| `OPENCLAW_NO_ONBOARD=1`              | ऑनबोर्डिंग छोड़ें   |
| `OPENCLAW_GIT_UPDATE=0`              | git pull अक्षम करें |
| `OPENCLAW_DRY_RUN=1`                 | ड्राई रन मोड        |

  </Accordion>
</AccordionGroup>

<Note>
यदि `-InstallMethod git` का उपयोग किया जाता है और Git अनुपस्थित है, तो स्क्रिप्ट बाहर निकलती है और Git for Windows लिंक प्रिंट करती है।
</Note>

---

## CI और स्वचालन

पूर्वानुमेय रन के लिए नॉन-इंटरैक्टिव फ़्लैग्स/पर्यावरण चर का उपयोग करें।

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

## समस्या-निवारण

<AccordionGroup>
  <Accordion title="Why is Git required?">
    `git` इंस्टॉल मेथड के लिए Git आवश्यक है। `npm` इंस्टॉल के लिए भी Git को चेक/इंस्टॉल किया जाता है ताकि dependencies में git URLs होने पर `spawn git ENOENT` failures से बचा जा सके।
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    कुछ Linux सेटअप npm global prefix को root-owned paths की ओर पॉइंट करते हैं। `install.sh` prefix को `~/.npm-global` पर स्विच कर सकता है और shell rc फ़ाइलों में PATH exports जोड़ सकता है (जब वे फ़ाइलें मौजूद हों)।
  </Accordion>

  <Accordion title="sharp/libvips issues">
    स्क्रिप्ट्स डिफ़ॉल्ट रूप से `SHARP_IGNORE_GLOBAL_LIBVIPS=1` सेट करती हैं ताकि sharp system libvips के खिलाफ build न करे। ओवरराइड करने के लिए:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Git for Windows इंस्टॉल करें, PowerShell पुनः खोलें, इंस्टॉलर फिर से चलाएँ।
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    `npm config get prefix` चलाएँ, `\bin` जोड़ें, उस निर्देशिका को उपयोगकर्ता PATH में जोड़ें, फिर PowerShell पुनः खोलें।
  </Accordion>

  <Accordion title="openclaw not found after install">
    आमतौर पर यह PATH से जुड़ी समस्या होती है। [Node.js troubleshooting](/install/node#troubleshooting) देखें।
  </Accordion>
</AccordionGroup>
