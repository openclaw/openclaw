---
summary: "प्लगइन में एजेंट टूल लिखें (स्कीमा, वैकल्पिक टूल, अलाउलिस्ट)"
read_when:
  - आप किसी प्लगइन में नया एजेंट टूल जोड़ना चाहते हैं
  - आपको अलाउलिस्ट के माध्यम से किसी टूल को ऑप्ट‑इन बनाना है
title: "प्लगइन एजेंट टूल्स"
---

# प्लगइन एजेंट टूल्स

OpenClaw प्लगइन्स **agent tools** (JSON‑schema फ़ंक्शन्स) रजिस्टर कर सकते हैं जिन्हें एजेंट रन के दौरान LLM को एक्सपोज़ किया जाता है। टूल्स **required** (हमेशा उपलब्ध) या **optional** (opt‑in) हो सकते हैं।

एजेंट टूल्स मुख्य कॉन्फ़िग में `tools` के तहत, या प्रति‑एजेंट `agents.list[].tools` के तहत कॉन्फ़िगर किए जाते हैं। allowlist/denylist नीति यह नियंत्रित करती है कि एजेंट कौन‑से टूल्स कॉल कर सकता है।

## बुनियादी टूल

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

## वैकल्पिक टूल (ऑप्ट‑इन)

Optional टूल्स **कभी भी** अपने‑आप सक्षम नहीं होते। उपयोगकर्ताओं को उन्हें एजेंट allowlist में जोड़ना होगा।

```ts
export default function (api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a local workflow",
      parameters: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
        },
        required: ["pipeline"],
      },
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

`agents.list[].tools.allow` (या वैश्विक `tools.allow`) में वैकल्पिक टूल सक्षम करें:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // specific tool name
            "workflow", // plugin id (enables all tools from that plugin)
            "group:plugins", // all plugin tools
          ],
        },
      },
    ],
  },
}
```

टूल उपलब्धता को प्रभावित करने वाले अन्य विन्यास विकल्प:

- जो अलाउलिस्ट केवल प्लगइन टूल्स का नाम लेती हैं, उन्हें प्लगइन ऑप्ट‑इन माना जाता है; कोर टूल्स
  तब तक सक्षम रहते हैं जब तक आप अलाउलिस्ट में कोर टूल्स या समूह भी शामिल न करें।
- `tools.profile` / `agents.list[].tools.profile` (आधार अलाउलिस्ट)
- `tools.byProvider` / `agents.list[].tools.byProvider` (प्रदाता‑विशिष्ट अनुमति/अस्वीकृति)
- `tools.sandbox.tools.*` (सैंडबॉक्स में होने पर sandbox टूल नीति)

## नियम + सुझाव

- टूल नाम **कोर टूल नामों** से टकराने नहीं चाहिए; टकराव होने पर टूल्स को छोड़ दिया जाता है।
- अलाउलिस्ट में उपयोग किए गए प्लगइन आईडी कोर टूल नामों से टकराने नहीं चाहिए।
- जिन टूल्स से साइड इफेक्ट्स ट्रिगर होते हैं या जिनके लिए अतिरिक्त
  बाइनरी/क्रेडेंशियल्स चाहिए, उनके लिए `optional: true` को प्राथमिकता दें।
