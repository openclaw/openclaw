---
summary: "閰嶇疆 Moonshot Kimi 涓?Kimi Coding锛堝崟鐙殑鎻愪緵鍟嗗拰瀵嗛挜锛?
read_when:
  - 浣犳兂瑕?Moonshot K2锛圡oonshot 寮€鏀惧钩鍙帮級涓?Kimi Coding 鐨勮缃?  - 浣犻渶瑕佷簡瑙ｅ崟鐙殑绔偣銆佸瘑閽ュ拰妯″瀷寮曠敤
  - 浣犳兂瑕佷换涓€鎻愪緵鍟嗙殑澶嶅埗绮樿创閰嶇疆
title: "Moonshot AI"
---

# Moonshot AI锛圞imi锛?

Moonshot 鎻愪緵 Kimi API锛屽叿鏈?OpenAI 鍏煎鐨勭鐐广€傞厤缃彁渚涘晢骞跺皢榛樿妯″瀷璁剧疆涓?`moonshot/kimi-k2.5`锛屾垨鑰呭皢 Kimi Coding 涓?`kimi/kimi-code` 涓€璧蜂娇鐢ㄣ€?
<Warning>
Moonshot 鍜?Kimi Coding 鏄?\*鍗曠嫭鐨勬彁渚涘晢\*\*銆傚瘑閽ヤ笉鍙簰鎹紝绔偣涓嶅悓锛屾ā鍨嬪紩鐢ㄤ篃涓嶅悓锛坄moonshot/` 涓?`kimi/`锛夈€?</Warning>

## 鍐呯疆妯″瀷鐩綍

[//]: # "moonshot-kimi-k2-ids:start"

| 妯″瀷寮曠敤                       | 鍚嶇О                  | 鎬濊€? | 杈撳叆      | 涓婁笅鏂? | 鏈€澶ц緭鍑? |
| --------------------------------- | ---------------------- | ------ | ----------- | --------- | ----------- |
| `moonshot/kimi-k2.5`              | Kimi K2.5              | No     | text, image | 262,144   | 262,144     |
| `moonshot/kimi-k2-thinking`       | Kimi K2 Thinking       | Yes    | text        | 262,144   | 262,144     |
| `moonshot/kimi-k2-thinking-turbo` | Kimi K2 Thinking Turbo | Yes    | text        | 262,144   | 262,144     |
| `moonshot/kimi-k2-turbo`          | Kimi K2 Turbo          | No     | text        | 256,000   | 16,384      |

[//]: # "moonshot-kimi-k2-ids:end"

## 寮€濮嬩娇鐢?

閫夋嫨浣犵殑鎻愪緵鍟嗗苟鎸夌収璁剧疆姝ラ鎿嶄綔銆?
<Tabs>
<Tab title="Moonshot API"> \*_鏈€閫傚悎锛?_ 閫氳繃 Moonshot 寮€鏀惧钩鍙扮殑 Kimi K2 妯″瀷銆?
<Steps>
<Step title="閫夋嫨浣犵殑绔偣鍖哄煙">
| 璁よ瘉閫夋嫨 | 绔偣 | 鍖哄煙 |
| -------------------- | ----------------------------- | ------------- |
| `moonshot-api-key` | `https://api.moonshot.ai/v1` | 鍥介檯 |
| `moonshot-api-key-cn` | `https://api.moonshot.cn/v1` | 涓浗 |
</Step>
<Step title="杩愯璁剧疆鍚戝">
`bash
        openclaw onboard --auth-choice moonshot-api-key
        `

        鎴栬€呭浜庝腑鍥界鐐癸細

        ```bash
        openclaw onboard --auth-choice moonshot-api-key-cn
        ```
      </Step>
      <Step title="璁剧疆榛樿妯″瀷">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "moonshot/kimi-k2.5" },
            },
          },
        }
        ```
      </Step>
      <Step title="楠岃瘉妯″瀷鍙敤">
        ```bash
        openclaw models list --provider moonshot
        ```
      </Step>
    </Steps>

    ### 閰嶇疆绀轰緥

    ```json5
    {
      env: { MOONSHOT_API_KEY: "sk-..." },
      agents: {
        defaults: {
          model: { primary: "moonshot/kimi-k2.5" },
          models: {
            // moonshot-kimi-k2-aliases:start
            "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
            "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
            "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },
            "moonshot/kimi-k2-turbo": { alias: "Kimi K2 Turbo" },
            // moonshot-kimi-k2-aliases:end
          },
        },
      },
      models: {
        mode: "merge",
        providers: {
          moonshot: {
            baseUrl: "https://api.moonshot.ai/v1",
            apiKey: "${MOONSHOT_API_KEY}",
            api: "openai-completions",
            models: [
              // moonshot-kimi-k2-models:start
              {
                id: "kimi-k2.5",
                name: "Kimi K2.5",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "kimi-k2-thinking",
                name: "Kimi K2 Thinking",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "kimi-k2-thinking-turbo",
                name: "Kimi K2 Thinking Turbo",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "kimi-k2-turbo",
                name: "Kimi K2 Turbo",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 256000,
                maxTokens: 16384,
              },
              // moonshot-kimi-k2-models:end
            ],
          },
        },
      },
    }
    ```

  </Tab>

  <Tab title="Kimi Coding">
    **鏈€閫傚悎锛?* 閫氳繃 Kimi Coding 绔偣鐨勪笓娉ㄤ簬缂栫▼鐨勪换鍔°€?
    <Note>
    Kimi Coding 浣跨敤涓?Moonshot 涓嶅悓鐨?API 瀵嗛挜鍜屾彁渚涘晢鍓嶇紑锛坄kimi/`锛夈€傛棫鐗堟ā鍨嬪紩鐢?`kimi/k2p5` 浠嶇劧浣滀负鍏煎鎬?ID 琚帴鍙椼€?    </Note>

    <Steps>
      <Step title="杩愯璁剧疆鍚戝">
        ```bash
        openclaw onboard --auth-choice kimi-code-api-key
        ```
      </Step>
      <Step title="璁剧疆榛樿妯″瀷">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "kimi/kimi-code" },
            },
          },
        }
        ```
      </Step>
      <Step title="楠岃瘉妯″瀷鍙敤">
        ```bash
        openclaw models list --provider kimi
        ```
      </Step>
    </Steps>

    ### 閰嶇疆绀轰緥

    ```json5
    {
      env: { KIMI_API_KEY: "sk-..." },
      agents: {
        defaults: {
          model: { primary: "kimi/kimi-code" },
          models: {
            "kimi/kimi-code": { alias: "Kimi" },
          },
        },
      },
    }
    ```

  </Tab>
</Tabs>

## Kimi 缃戦〉鎼滅储

OpenClaw 杩橀檮甯?**Kimi** 浣滀负 `web_search` 鎻愪緵鍟嗭紝鐢?Moonshot 缃戦〉鎼滅储鎻愪緵鏀寔銆?
<Steps>
<Step title="杩愯浜や簰寮忕綉椤垫悳绱㈣缃?>
`bash
    openclaw configure --section web
    `

    鍦ㄧ綉椤垫悳绱㈤儴鍒嗛€夋嫨 **Kimi** 浠ュ瓨鍌?`plugins.entries.moonshot.config.webSearch.*`銆?

  </Step>
  <Step title="閰嶇疆缃戦〉鎼滅储鍖哄煙鍜屾ā鍨?>
    浜や簰寮忚缃細鎻愮ず锛?
    | 璁剧疆 | 閫夐」 |
    | ------------------- | -------------------------------------------------------------------- |
    | API 鍖哄煙 | `https://api.moonshot.ai/v1`锛堝浗闄咃級鎴?`https://api.moonshot.cn/v1`锛堜腑鍥斤級 |
    | 缃戦〉鎼滅储妯″瀷 | 榛樿涓?`kimi-k2.5` |

  </Step>
</Steps>

閰嶇疆浣嶄簬 `plugins.entries.moonshot.config.webSearch` 涓嬶細

```json5
{
  plugins: {
    entries: {
      moonshot: {
        config: {
          webSearch: {
            apiKey: "sk-...", // 鎴栦娇鐢?KIMI_API_KEY / MOONSHOT_API_KEY
            baseUrl: "https://api.moonshot.ai/v1",
            model: "kimi-k2.5",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "kimi",
      },
    },
  },
}
```

## 楂樼骇閰嶇疆

<AccordionGroup>
  <Accordion title="鍘熺敓鎬濊€冩ā寮?>
    Moonshot Kimi 鏀寔浜岃繘鍒跺師鐢熸€濊€冿細

    - `thinking: { type: "enabled" }`
    - `thinking: { type: "disabled" }`

    閫氳繃 `agents.defaults.models.<provider/model>.params` 涓烘瘡涓ā鍨嬮厤缃細

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "moonshot/kimi-k2.5": {
              params: {
                thinking: { type: "disabled" },
              },
            },
          },
        },
      },
    }
    ```

    OpenClaw 杩樹細涓?Moonshot 鏄犲皠杩愯鏃?`/think` 绾у埆锛?
    | `/think` 绾у埆 | Moonshot 琛屼负 |
    | -------------------- | -------------------------- |
    | `/think off` | `thinking.type=disabled` |
    | 浠讳綍闈炲叧闂骇鍒?| `thinking.type=enabled` |

    <Warning>
    褰?Moonshot 鎬濊€冨惎鐢ㄦ椂锛宍tool_choice` 蹇呴』鏄?`auto` 鎴?`none`銆備负浜嗗吋瀹规€э紝OpenClaw 浼氬皢涓嶅吋瀹圭殑 `tool_choice` 鍊兼爣鍑嗗寲涓?`auto`銆?    </Warning>

  </Accordion>

<Accordion title="娴佸紡浣跨敤鍏煎鎬?>
鍘熺敓 Moonshot 绔偣锛坄https://api.moonshot.ai/v1` 鍜?`https://api.moonshot.cn/v1`锛夊湪鍏变韩鐨?`openai-completions` 浼犺緭涓婂浼犳祦寮忎娇鐢ㄥ吋瀹规€с€侽penClaw 鐜板湪浼氬皢绔偣鍔熻兘涓庡瘑閽ュ叧鑱旓紝鍥犳閽堝鐩稿悓鍘熺敓 Moonshot 涓绘満鐨勫吋瀹硅嚜瀹氫箟鎻愪緵鍟?ID 浼氱户鎵跨浉鍚岀殑娴佸紡浣跨敤琛屼负銆? </Accordion>

<Accordion title="绔偣鍜屾ā鍨嬪紩鐢ㄥ弬鑰?>
| 鎻愪緵鍟?| 妯″瀷寮曠敤鍓嶇紑 | 绔偣 | 璁よ瘉鐜鍙橀噺 |
| ---------- | ---------------- | ----------------------------- | ------------------- |
| Moonshot | `moonshot/` | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` |
| Moonshot CN | `moonshot/` | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` |
| Kimi Coding | `kimi/` | Kimi Coding 绔偣 | `KIMI_API_KEY` |
| 缃戦〉鎼滅储 | 涓嶉€傜敤 | 涓?Moonshot API 鍖哄煙鐩稿悓 | `KIMI_API_KEY` 鎴?`MOONSHOT_API_KEY` |

    - Kimi 缃戦〉鎼滅储浣跨敤 `KIMI_API_KEY` 鎴?`MOONSHOT_API_KEY`锛岄粯璁や负 `https://api.moonshot.ai/v1` 鍜屾ā鍨?`kimi-k2.5`銆?    - 濡傞渶锛岃鍦?`models.providers` 涓鐩栧畾浠峰拰涓婁笅鏂囧厓鏁版嵁銆?    - 濡傛灉 Moonshot 涓烘煇涓ā鍨嬪彂甯冧笉鍚岀殑涓婁笅鏂囬檺鍒讹紝璇风浉搴旇皟鏁?`contextWindow`銆?

  </Accordion>
</AccordionGroup>

## 鐩稿叧鍐呭

<CardGroup cols={2}>
  <Card title="妯″瀷閫夋嫨" href="/concepts/model-providers" icon="layers">
    閫夋嫨鎻愪緵鍟嗐€佹ā鍨嬪紩鐢ㄥ拰鏁呴殰杞Щ琛屼负銆?  </Card>
  <Card title="缃戦〉鎼滅储" href="/tools/web-search" icon="magnifying-glass">
    閰嶇疆鍖呮嫭 Kimi 鍦ㄥ唴鐨勭綉椤垫悳绱㈡彁渚涘晢銆?  </Card>
  <Card title="閰嶇疆鍙傝€? href="/gateway/configuration-reference" icon="gear">
    鎻愪緵鍟嗐€佹ā鍨嬪拰鎻掍欢鐨勫畬鏁撮厤缃灦鏋勩€?  </Card>
  <Card title="Moonshot 寮€鏀惧钩鍙? href="https://platform.moonshot.ai" icon="globe">
    Moonshot API 瀵嗛挜绠＄悊鍜屾枃妗ｃ€?  </Card>
</CardGroup>
