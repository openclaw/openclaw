---
title: "Pi विकास कार्यप्रवाह"
x-i18n:
  source_path: pi-dev.md
  source_hash: b6c44672306d8867
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:26Z
---

# Pi विकास कार्यप्रवाह

यह मार्गदर्शिका OpenClaw में pi एकीकरण पर काम करने के लिए एक सुव्यवस्थित कार्यप्रवाह का सार प्रस्तुत करती है।

## प्रकार जाँच और लिंटिंग

- प्रकार जाँच और बिल्ड: `pnpm build`
- लिंट: `pnpm lint`
- प्रारूप जाँच: `pnpm format`
- पुश करने से पहले पूर्ण गेट: `pnpm lint && pnpm build && pnpm test`

## Pi परीक्षण चलाना

pi एकीकरण परीक्षण सेट के लिए समर्पित स्क्रिप्ट का उपयोग करें:

```bash
scripts/pi/run-tests.sh
```

वास्तविक प्रदाता व्यवहार का अभ्यास करने वाला लाइव परीक्षण शामिल करने के लिए:

```bash
scripts/pi/run-tests.sh --live
```

यह स्क्रिप्ट इन ग्लोब्स के माध्यम से सभी pi-संबंधित यूनिट परीक्षण चलाती है:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## मैनुअल परीक्षण

अनुशंसित प्रवाह:

- dev मोड में Gateway चलाएँ:
  - `pnpm gateway:dev`
- एजेंट को सीधे ट्रिगर करें:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- इंटरैक्टिव डिबगिंग के लिए TUI का उपयोग करें:
  - `pnpm tui`

टूल कॉल व्यवहार के लिए, `read` या `exec` क्रिया के लिए प्रॉम्प्ट करें ताकि आप टूल स्ट्रीमिंग और पेलोड हैंडलिंग देख सकें।

## क्लीन स्लेट रीसेट

स्थिति OpenClaw स्टेट डायरेक्टरी के अंतर्गत रहती है। डिफ़ॉल्ट `~/.openclaw` है। यदि `OPENCLAW_STATE_DIR` सेट है, तो उसके स्थान पर उस डायरेक्टरी का उपयोग करें।

सब कुछ रीसेट करने के लिए:

- विन्यास के लिए `openclaw.json`
- प्रमाणीकरण प्रोफ़ाइल और टोकन के लिए `credentials/`
- एजेंट सत्र इतिहास के लिए `agents/<agentId>/sessions/`
- सत्र इंडेक्स के लिए `agents/<agentId>/sessions.json`
- यदि लेगेसी पथ मौजूद हों तो `sessions/`
- यदि आप एक खाली वर्कस्पेस चाहते हैं तो `workspace/`

यदि आप केवल सत्र रीसेट करना चाहते हैं, तो उस एजेंट के लिए `agents/<agentId>/sessions/` और `agents/<agentId>/sessions.json` हटाएँ। यदि आप पुनः प्रमाणीकरण नहीं करना चाहते हैं, तो `credentials/` रखें।

## संदर्भ

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
