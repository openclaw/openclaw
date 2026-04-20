---
summary: "鍦?OpenClaw 涓娇鐢?Z.AI锛圙LM 妯″瀷锛?
read_when:
  - 浣犳兂鍦?OpenClaw 涓娇鐢?Z.AI / GLM 妯″瀷
  - 浣犻渶瑕佺畝鍗曠殑 ZAI_API_KEY 璁剧疆
title: "Z.AI"
---

# Z.AI

Z.AI 鏄?**GLM** 妯″瀷鐨?API 骞冲彴銆傚畠涓?GLM 鎻愪緵 REST API锛屽苟浣跨敤 API 瀵嗛挜杩涜韬唤楠岃瘉銆傚湪 Z.AI 鎺у埗鍙颁腑鍒涘缓浣犵殑 API 瀵嗛挜銆侽penClaw 浣跨敤甯︽湁 Z.AI API 瀵嗛挜鐨?`zai` 鎻愪緵鍟嗐€?

- 鎻愪緵鍟嗭細`zai`
- 璁よ瘉锛歚ZAI_API_KEY`
- API锛歓.AI Chat Completions锛圔earer 璁よ瘉锛?

## 寮€濮嬩娇鐢?

<Tabs>
  <Tab title="鑷姩妫€娴嬬鐐?>
    **鏈€閫傚悎锛?*澶у鏁扮敤鎴枫€侽penClaw 浠庡瘑閽ヤ腑妫€娴嬪尮閰嶇殑 Z.AI 绔偣锛屽苟鑷姩搴旂敤姝ｇ‘鐨勫熀 URL銆?
    <Steps>
      <Step title="杩愯璁剧疆鍚戝">
        ```bash
        openclaw onboard --auth-choice zai-api-key
        ```
      </Step>
      <Step title="璁剧疆榛樿妯″瀷">
        ```json5
        {
          env: { ZAI_API_KEY: "sk-..." },
          agents: { defaults: { model: { primary: "zai/glm-5.1" } } },
        }
        ```
      </Step>
      <Step title="楠岃瘉妯″瀷鍙敤">
        ```bash
        openclaw models list --provider zai
        ```
      </Step>
    </Steps>

  </Tab>

<Tab title="鏄庣‘鐨勫尯鍩熺鐐?> \**鏈€閫傚悎锛?*鎯宠寮哄埗浣跨敤鐗瑰畾 Coding Plan 鎴栭€氱敤 API 鎺ュ彛鐨勭敤鎴枫€?
<Steps>
<Step title="閫夋嫨姝ｇ‘鐨勮缃€夐」">
```bash # Coding Plan 鍏ㄧ悆锛堟帹鑽愮粰 Coding Plan 鐢ㄦ埛锛? openclaw onboard --auth-choice zai-coding-global

        # Coding Plan CN锛堜腑鍥藉尯鍩燂級
        openclaw onboard --auth-choice zai-coding-cn

        # 閫氱敤 API
        openclaw onboard --auth-choice zai-global

        # 閫氱敤 API CN锛堜腑鍥藉尯鍩燂級
        openclaw onboard --auth-choice zai-cn
        ```
      </Step>
      <Step title="璁剧疆榛樿妯″瀷">
        ```json5
        {
          env: { ZAI_API_KEY: "sk-..." },
          agents: { defaults: { model: { primary: "zai/glm-5.1" } } },
        }
        ```
      </Step>
      <Step title="楠岃瘉妯″瀷鍙敤">
        ```bash
        openclaw models list --provider zai
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

## 鍐呯疆 GLM 鐩綍

OpenClaw 褰撳墠涓哄唴缃殑 `zai` 鎻愪緵鍟嗛缃簡锛?
| 妯″瀷寮曠敤 | 璇存槑 |
| -------------------- | ------------- |
| `zai/glm-5.1` | 榛樿妯″瀷 |
| `zai/glm-5` | |
| `zai/glm-5-turbo` | |
| `zai/glm-5v-turbo` | |
| `zai/glm-4.7` | |
| `zai/glm-4.7-flash` | |
| `zai/glm-4.7-flashx` | |
| `zai/glm-4.6` | |
| `zai/glm-4.6v` | |
| `zai/glm-4.5` | |
| `zai/glm-4.5-air` | |
| `zai/glm-4.5-flash` | |
| `zai/glm-4.5v` | |

<Tip>
GLM 妯″瀷浠?`zai/<model>` 褰㈠紡鎻愪緵锛堜緥濡傦細`zai/glm-5`锛夈€傞粯璁ょ殑鍐呯疆妯″瀷寮曠敤鏄?`zai/glm-5.1`銆?</Tip>

## 楂樼骇閰嶇疆

<AccordionGroup>
  <Accordion title="鍓嶅悜瑙ｆ瀽鏈煡鐨?GLM-5 妯″瀷">
    褰?ID 鍖归厤褰撳墠 GLM-5 绯诲垪鏍煎紡鏃讹紝鏈煡鐨?`glm-5*` ID 浠嶇劧鍙互閫氳繃浠?`glm-4.7` 妯℃澘鍚堟垚鎻愪緵鍟嗘嫢鏈夌殑鍏冩暟鎹紝鍦ㄥ唴缃彁渚涘晢璺緞涓婅繘琛屽墠鍚戣В鏋愩€?  </Accordion>

  <Accordion title="宸ュ叿璋冪敤娴佸紡浼犺緭">
    Z.AI 鐨勫伐鍏疯皟鐢ㄦ祦寮忎紶杈撻粯璁ゅ惎鐢?`tool_stream`銆傝绂佺敤瀹冿細

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "zai/<model>": {
              params: { tool_stream: false },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="鍥惧儚鐞嗚В">
    鍐呯疆鐨?Z.AI 鎻掍欢浼氭敞鍐屽浘鍍忕悊瑙ｅ姛鑳姐€?
    | 灞炴€?| 鍊?|
    | ------------- | ----------- |
    | 妯″瀷 | `glm-4.6v` |

    鍥惧儚鐞嗚В鍔熻兘浼氳嚜鍔ㄤ粠閰嶇疆鐨?Z.AI 璁よ瘉涓В鏋愨€斺€旀棤闇€棰濆閰嶇疆銆?

  </Accordion>

  <Accordion title="璁よ瘉璇︽儏">
    - Z.AI 浣跨敤甯︽湁浣犵殑 API 瀵嗛挜鐨?Bearer 璁よ瘉銆?    - `zai-api-key` 璁剧疆閫夐」浼氫粠瀵嗛挜鍓嶇紑鑷姩妫€娴嬪尮閰嶇殑 Z.AI 绔偣銆?    - 褰撲綘鎯宠寮哄埗浣跨敤鐗瑰畾 API 鎺ュ彛鏃讹紝璇蜂娇鐢ㄦ槑纭殑鍖哄煙閫夐」锛坄zai-coding-global`銆乣zai-coding-cn`銆乣zai-global`銆乣zai-cn`锛夈€?  </Accordion>
</AccordionGroup>

## 鐩稿叧鍐呭

<CardGroup cols={2}>
  <Card title="GLM 妯″瀷绯诲垪" href="/providers/glm" icon="microchip">
    GLM 鐨勬ā鍨嬬郴鍒楁瑙堛€?  </Card>
  <Card title="妯″瀷閫夋嫨" href="/concepts/model-providers" icon="layers">
    閫夋嫨鎻愪緵鍟嗐€佹ā鍨嬪紩鐢ㄥ拰鏁呴殰杞Щ琛屼负銆?  </Card>
</CardGroup>
