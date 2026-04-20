---
summary: "浣跨敤鍗冨竼鐨勭粺涓€ API 鍦?OpenClaw 涓闂涓ā鍨?
read_when:
  - 浣犳兂涓哄涓?LLM 浣跨敤鍗曚釜 API 瀵嗛挜
  - 浣犻渶瑕佺櫨搴﹀崈甯嗚缃寚瀵?title: "Qianfan"
---

# Qianfan

鍗冨竼鏄櫨搴︾殑 MaaS 骞冲彴锛屾彁渚?\*缁熶竴 API\*\*锛屽彲閫氳繃鍗曚釜绔偣鍜?API 瀵嗛挜灏嗚姹傝矾鐢卞埌澶氫釜妯″瀷銆傚畠鏄?OpenAI 鍏煎鐨勶紝鍥犳澶у鏁?OpenAI SDK 鍙渶鍒囨崲鍩?URL 鍗冲彲浣跨敤銆?
| 灞炴€?| 鍊?|
| -------- | --------------------------------- |
| 鎻愪緵鍟?| `qianfan` |
| 璁よ瘉 | `QIANFAN_API_KEY` |
| API | OpenAI 鍏煎 |
| 鍩?URL | `https://qianfan.baidubce.com/v2` |

## 寮€濮嬩娇鐢?

<Steps>
  <Step title="鍒涘缓鐧惧害浜戣处鎴?>
    鍦?[鍗冨竼鎺у埗鍙癩(https://console.bce.baidu.com/qianfan/ais/console/apiKey) 娉ㄥ唽鎴栫櫥褰曪紝纭繚宸插惎鐢ㄥ崈甯?API 璁块棶鏉冮檺銆?  </Step>
  <Step title="鐢熸垚 API 瀵嗛挜">
    鍒涘缓鏂板簲鐢ㄦ垨閫夋嫨鐜版湁搴旂敤锛岀劧鍚庣敓鎴?API 瀵嗛挜銆傚瘑閽ユ牸寮忎负 `bce-v3/ALTAK-...`銆?  </Step>
  <Step title="杩愯璁剧疆鍚戝">
    ```bash
    openclaw onboard --auth-choice qianfan-api-key
    ```
  </Step>
  <Step title="楠岃瘉妯″瀷鍙敤">
    ```bash
    openclaw models list --provider qianfan
    ```
  </Step>
</Steps>

## 鍙敤妯″瀷

| 妯″瀷寮曠敤                          | 杈撳叆      | 涓婁笅鏂? | 鏈€澶ц緭鍑? | 鎬濊€? | 璇存槑     |
| ------------------------------------ | ----------- | --------- | ----------- | ------ | ---------- |
| `qianfan/deepseek-v3.2`              | text        | 98,304    | 32,768      | Yes    | 榛樿妯″瀷 |
| `qianfan/ernie-5.0-thinking-preview` | text, image | 119,000   | 64,000      | Yes    | 澶氭ā鎬?   |

<Tip>
榛樿鐨勫唴缃ā鍨嬪紩鐢ㄦ槸 `qianfan/deepseek-v3.2`銆備粎褰撲綘闇€瑕佽嚜瀹氫箟鍩?URL 鎴栨ā鍨嬪厓鏁版嵁鏃讹紝鎵嶉渶瑕佽鐩?`models.providers.qianfan`銆?</Tip>

## 閰嶇疆绀轰緥

```json5
{
  env: { QIANFAN_API_KEY: "bce-v3/ALTAK-..." },
  agents: {
    defaults: {
      model: { primary: "qianfan/deepseek-v3.2" },
      models: {
        "qianfan/deepseek-v3.2": { alias: "QIANFAN" },
      },
    },
  },
  models: {
    providers: {
      qianfan: {
        baseUrl: "https://qianfan.baidubce.com/v2",
        api: "openai-completions",
        models: [
          {
            id: "deepseek-v3.2",
            name: "DEEPSEEK V3.2",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 98304,
            maxTokens: 32768,
          },
          {
            id: "ernie-5.0-thinking-preview",
            name: "ERNIE-5.0-Thinking-Preview",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 119000,
            maxTokens: 64000,
          },
        ],
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="浼犺緭鍜屽吋瀹规€?>
    鍗冨竼閫氳繃 OpenAI 鍏煎鐨勪紶杈撹矾寰勮繍琛岋紝鑰屼笉鏄師鐢?OpenAI 璇锋眰鏁村舰銆傝繖鎰忓懗鐫€鏍囧噯 OpenAI SDK 鍔熻兘鍙敤锛屼絾鐗瑰畾浜庢彁渚涘晢鐨勫弬鏁板彲鑳戒笉浼氳杞彂銆?  </Accordion>

<Accordion title="鐩綍鍜岃鐩?>
褰撳墠鍐呯疆鐩綍鍖呮嫭 `deepseek-v3.2` 鍜?`ernie-5.0-thinking-preview`銆備粎褰撲綘闇€瑕佽嚜瀹氫箟鍩?URL 鎴栨ā鍨嬪厓鏁版嵁鏃讹紝鎵嶆坊鍔犳垨瑕嗙洊 `models.providers.qianfan`銆?
<Note>
妯″瀷寮曠敤浣跨敤 `qianfan/` 鍓嶇紑锛堜緥濡?`qianfan/deepseek-v3.2`锛夈€? </Note>

  </Accordion>

  <Accordion title="鏁呴殰鎺掗櫎">
    - 纭繚浣犵殑 API 瀵嗛挜浠?`bce-v3/ALTAK-` 寮€澶达紝骞跺湪鐧惧害浜戞帶鍒跺彴涓惎鐢ㄤ簡鍗冨竼 API 璁块棶鏉冮檺銆?    - 濡傛灉鏈垪鍑烘ā鍨嬶紝璇风‘璁や綘鐨勮处鎴峰凡婵€娲诲崈甯嗘湇鍔°€?    - 榛樿鍩?URL 涓?`https://qianfan.baidubce.com/v2`銆備粎褰撲娇鐢ㄨ嚜瀹氫箟绔偣鎴栦唬鐞嗘椂鎵嶆洿鏀瑰畠銆?  </Accordion>
</AccordionGroup>

## 鐩稿叧鍐呭

<CardGroup cols={2}>
  <Card title="妯″瀷閫夋嫨" href="/concepts/model-providers" icon="layers">
    閫夋嫨鎻愪緵鍟嗐€佹ā鍨嬪紩鐢ㄥ拰鏁呴殰杞Щ琛屼负銆?  </Card>
  <Card title="閰嶇疆鍙傝€? href="/gateway/configuration" icon="gear">
    瀹屾暣鐨?OpenClaw 閰嶇疆鍙傝€冦€?  </Card>
  <Card title="浠ｇ悊璁剧疆" href="/concepts/agent" icon="robot">
    閰嶇疆浠ｇ悊榛樿鍊煎拰妯″瀷鍒嗛厤銆?  </Card>
  <Card title="鍗冨竼 API 鏂囨。" href="https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb" icon="arrow-up-right-from-square">
    瀹樻柟鍗冨竼 API 鏂囨。銆?  </Card>
</CardGroup>
