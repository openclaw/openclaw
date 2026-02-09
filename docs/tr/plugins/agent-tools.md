---
summary: "Bir eklentide ajan araçları yazın (şemalar, isteğe bağlı araçlar, izin listeleri)"
read_when:
  - Bir eklentide yeni bir ajan aracı eklemek istiyorsunuz
  - Bir aracı izin listeleri aracılığıyla isteğe bağlı yapmak istiyorsunuz
title: "Eklenti Ajan Araçları"
---

# Eklenti ajan araçları

OpenClaw eklentileri, ajan çalışmaları sırasında LLM’e sunulan **ajan araçlarını**
(JSON‑şema fonksiyonları) kaydedebilir. Araçlar **zorunlu** (her zaman kullanılabilir)
veya **isteğe bağlı** (opt‑in) olabilir.

Ajan araçları, ana yapılandırmada `tools` altında ya da ajan bazında
`agents.list[].tools` altında yapılandırılır. İzin listesi/engelleme listesi politikası,
ajanın hangi araçları çağırabileceğini kontrol eder.

## Temel araç

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

## İsteğe bağlı araç (opt‑in)

İsteğe bağlı araçlar **asla** otomatik olarak etkinleştirilmez. Kullanıcıların bu
araçları bir ajan izin listesine eklemesi gerekir.

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

İsteğe bağlı araçları `agents.list[].tools.allow` içinde (veya genel `tools.allow`) etkinleştirin:

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

Araç kullanılabilirliğini etkileyen diğer yapılandırma ayarları:

- Yalnızca eklenti araçlarını adlandıran izin listeleri, eklenti opt‑in’i olarak
  değerlendirilir; izin listesine çekirdek araçları veya grupları da eklemediğiniz
  sürece çekirdek araçlar etkin kalır.
- `tools.profile` / `agents.list[].tools.profile` (temel izin listesi)
- `tools.byProvider` / `agents.list[].tools.byProvider` (sağlayıcıya özgü izin/verme ve engelleme)
- `tools.sandbox.tools.*` (sandbox içinde çalışırken sandbox araç politikası)

## Kurallar + ipuçları

- Araç adları çekirdek araç adlarıyla **çakışmamalıdır**; çakışan araçlar atlanır.
- İzin listelerinde kullanılan eklenti kimlikleri, çekirdek araç adlarıyla çakışmamalıdır.
- Yan etkileri tetikleyen veya ek ikili dosyalar/kimlik bilgileri gerektiren araçlar için
  `optional: true` tercih edilmelidir.
