---
summary: "OpenClaw इंस्टॉल करें और कुछ ही मिनटों में अपनी पहली चैट चलाएँ।"
read_when:
  - शून्य से पहली बार सेटअप
  - आप काम करने वाली चैट तक सबसे तेज़ रास्ता चाहते हैं
title: "आरंभ करें"
---

# आरंभ करें

लक्ष्य: न्यूनतम सेटअप के साथ शून्य से पहली काम करने वाली चैट तक पहुँचना।

<Info>
यदि macOS ऐप
किसी रिमोट Gateway से कनेक्ट होता है, तो वर्कस्पेस और बूटस्ट्रैपिंग फ़ाइलें उसी रिमोट
मशीन पर रहती हैं। यह पेज एक क्यूरेटेड इंडेक्स है।
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">Gateway होस्ट</Tooltip>यदि आप नए हैं, तो [Getting Started](/start/getting-started) से शुरुआत करें।
डॉक्स का पूरा मैप देखने के लिए [Docs hubs](/start/hubs) देखें।
</Info>

## पूर्वापेक्षाएँ

- Node 22 या उससे नया

<Tip>
यदि आप सुनिश्चित नहीं हैं, तो `node --version` से अपना Node संस्करण जाँचें।
</Tip>

## त्वरित सेटअप (CLI)

<Steps>
  <Step title="Install OpenClaw (recommended)">
    <Tabs>
      <Tab title="macOS/Linux">
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

    ```
    <Note>
    अन्य इंस्टॉल विधियाँ और आवश्यकताएँ: [Install](/install)।
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    विज़ार्ड प्रमाणीकरण, Gateway सेटिंग्स और वैकल्पिक चैनलों को कॉन्फ़िगर करता है।
    विवरण के लिए [Onboarding Wizard](/start/wizard) देखें।
    ```

  </Step>
  <Step title="Check the Gateway">
    यदि आपने सेवा इंस्टॉल की है, तो यह पहले से चल रही होनी चाहिए:

    ````
    ```bash
    openclaw gateway status
    ```
    ````

  </Step>
  <Step title="Open the Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
यदि Control UI लोड हो जाता है, तो आपका Gateway उपयोग के लिए तैयार है।
</Check>

## वैकल्पिक जाँचें और अतिरिक्त

<AccordionGroup>
  <Accordion title="Run the Gateway in the foreground">
    त्वरित परीक्षणों या समस्या-निवारण के लिए उपयोगी।

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    कॉन्फ़िगर किए गए चैनल की आवश्यकता होती है।

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## और गहराई में जाएँ

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    पूर्ण CLI विज़ार्ड संदर्भ और उन्नत विकल्प।
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
    macOS ऐप के लिए प्रथम-रन प्रवाह।
  </Card>
</Columns>

## आपके पास क्या होगा

- एक चल रहा Gateway
- प्रमाणीकरण कॉन्फ़िगर किया हुआ
- Control UI तक पहुँच या एक कनेक्टेड चैनल

## अगले कदम

- DM सुरक्षा और अनुमोदन: [Pairing](/channels/pairing)
- अधिक चैनल कनेक्ट करें: [Channels](/channels)
- उन्नत वर्कफ़्लो और स्रोत से: [Setup](/start/setup)
