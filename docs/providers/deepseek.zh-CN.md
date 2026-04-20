---
title: "DeepSeek"
summary: "DeepSeek 璁剧疆锛堣璇?+ 妯″瀷閫夋嫨锛?
read_when:
  - 浣犳兂鍦?OpenClaw 涓娇鐢?DeepSeek
  - 浣犻渶瑕?API 瀵嗛挜鐜鍙橀噺鎴?CLI 璁よ瘉閫夐」
---

# DeepSeek

[DeepSeek](https://www.deepseek.com) 鎻愪緵鍏锋湁 OpenAI 鍏煎 API 鐨勫己澶?AI 妯″瀷銆?

| 灞炴€?| 鍊?|

|-------- | --------------------------|

| 鎻愪緵鍟?|`deepseek`|

| 璁よ瘉 |`DEEPSEEK_API_KEY`|

| API | OpenAI 鍏煎 |
| 鍩?URL |`<https://api.deepseek.com`|>

## 寮€濮嬩娇鐢?

<Steps>
  <Step title="鑾峰彇浣犵殑 API 瀵嗛挜">
    鍦?[platform.deepseek.com](https://platform.deepseek.com/api_keys) 鍒涘缓 API 瀵嗛挜銆?  </Step>
  <Step title="杩愯璁剧疆鍚戝">```bash
    openclaw onboard --auth-choice deepseek-api-key```杩欎細鎻愮ず杈撳叆浣犵殑 API 瀵嗛挜锛屽苟灏?`deepseek/deepseek-chat`璁剧疆涓洪粯璁ゆā鍨嬨€?

  </Step>
  <Step title="楠岃瘉妯″瀷鍙敤">```bash
    openclaw models list --provider deepseek```</Step>
</Steps>

<AccordionGroup>
  <Accordion title="闈炰氦浜掑紡璁剧疆">
    瀵逛簬鑴氭湰鍖栨垨鏃犱汉鍊煎畧瀹夎锛岀洿鎺ヤ紶閫掓墍鏈夋爣蹇楋細```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice deepseek-api-key \
      --deepseek-api-key "$DEEPSEEK_API_KEY" \
      --skip-health \
      --accept-risk```</Accordion>
</AccordionGroup>

<Warning>
濡傛灉缃戝叧浣滀负瀹堟姢杩涚▼锛坙aunchd/systemd锛夎繍琛岋紝璇风‘淇濊杩涚▼鍙互璁块棶`DEEPSEEK_API_KEY`锛堜緥濡傦紝鍦?`~/.openclaw/.env`涓垨閫氳繃`env.shellEnv`锛夈€?</Warning>

## 鍐呯疆鐩綍

| 妯″瀷寮曠敤 | 鍚嶇О | 杈撳叆 | 涓婁笅鏂? | 鏈€澶ц緭鍑? | 璇存槑 |

|---------------------------- | ----------------- | ------ | --------- | ----------- | ------------------------------------------|

|`deepseek/deepseek-chat`| DeepSeek Chat | text | 131,072 | 8,192 | 榛樿妯″瀷锛汥eepSeek V3.2 闈炴€濊€冩帴鍙? |

|`deepseek/deepseek-reasoner`| DeepSeek Reasoner | text | 131,072 | 65,536 | 鍚敤鎬濊€冪殑 V3.2 鎺ュ彛 |

<Tip>
褰撳墠涓や釜鍐呯疆妯″瀷鍦ㄦ簮浠ｇ爜涓兘瀹ｄ紶浜嗘祦寮忎娇鐢ㄥ吋瀹规€с€?</Tip>

## 閰嶇疆绀轰緥```json5

{
env: { DEEPSEEK_API_KEY: "sk-..." },
agents: {
defaults: {
model: { primary: "deepseek/deepseek-chat" },
},
},
}```## 鐩稿叧鍐呭

<CardGroup cols={2}>
  <Card title="妯″瀷閫夋嫨" href="/concepts/model-providers" icon="layers">
    閫夋嫨鎻愪緵鍟嗐€佹ā鍨嬪紩鐢ㄥ拰鏁呴殰杞Щ琛屼负銆?  </Card>
  <Card title="閰嶇疆鍙傝€? href="/gateway/configuration-reference" icon="gear">
    浠ｇ悊銆佹ā鍨嬪拰鎻愪緵鍟嗙殑瀹屾暣閰嶇疆鍙傝€冦€?  </Card>
</CardGroup>
