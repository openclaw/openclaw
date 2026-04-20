---
title: "Volcengine (Doubao)"
summary: "鐏北寮曟搸璁剧疆锛堣眴鍖呮ā鍨嬶紝閫氱敤+缂栫▼绔偣锛?
read_when:
  - 浣犳兂鍦?OpenClaw 涓娇鐢ㄧ伀灞卞紩鎿庢垨璞嗗寘妯″瀷
  - 浣犻渶瑕佺伀灞卞紩鎿?API 瀵嗛挜璁剧疆
---

# Volcengine (Doubao)

鐏北寮曟搸鎻愪緵鍟嗗彲璁块棶璞嗗寘妯″瀷鍜屾墭绠″湪鐏北寮曟搸涓婄殑绗笁鏂规ā鍨嬶紝涓洪€氱敤鍜岀紪绋嬪伐浣滆礋杞芥彁渚涘崟鐙殑绔偣銆?

| 璇︽儏 | 鍊? |
| ------ | --- |

| 鎻愪緵鍟?| `volcengine`锛堥€氱敤锛?`volcengine-plan`锛堢紪绋嬶級 |

| 璁よ瘉 | `VOLCANO_ENGINE_API_KEY`|
| API | OpenAI 鍏煎 |

## 寮€濮嬩娇鐢?

<Steps>
  <Step title="璁剧疆 API 瀵嗛挜">
    杩愯浜や簰寮忚缃細```bash
    openclaw onboard --auth-choice volcengine-api-key```杩欎細浠庡崟涓?API 瀵嗛挜鍚屾椂娉ㄥ唽閫氱敤锛坄volcengine`锛夊拰缂栫▼锛坄volcengine-plan`锛夋彁渚涘晢銆?

  </Step>
  <Step title="璁剧疆榛樿妯″瀷">```json5
    {
      agents: {
        defaults: {
          model: { primary: "volcengine-plan/ark-code-latest" },
        },
      },
    }```</Step>
  <Step title="楠岃瘉妯″瀷鍙敤">```bash
    openclaw models list --provider volcengine
    openclaw models list --provider volcengine-plan```</Step>
</Steps>

<Tip>
瀵逛簬闈炰氦浜掑紡璁剧疆锛圕I銆佽剼鏈級锛岀洿鎺ヤ紶閫掑瘑閽ワ細```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice volcengine-api-key \
  --volcengine-api-key "$VOLCANO_ENGINE_API_KEY"```</Tip>

## 鎻愪緵鍟嗗拰绔偣

| 鎻愪緵鍟? | 绔偣 | 鐢ㄤ緥 |
| --------- | ----- | ------ |

| `volcengine`| `ark.cn-beijing.volces.com/api/v3`| 閫氱敤妯″瀷 |
| `volcengine-plan`| `ark.cn-beijing.volces.com/api/coding/v3`| 缂栫▼妯″瀷 |

<Note>
涓や釜鎻愪緵鍟嗛兘浠庡崟涓?API 瀵嗛挜閰嶇疆銆傝缃細鑷姩娉ㄥ唽涓よ€呫€?</Note>

## 鍙敤妯″瀷

<Tabs>
  <Tab title="閫氱敤锛坴olcengine锛?>

    | 妯″瀷寮曠敤 | 鍚嶇О | 杈撳叆 | 涓婁笅鏂?|
    | -------------------------------------------- | ------------------------------- | ----------- | ------- |

    | `volcengine/doubao-seed-1-8-251228`| Doubao Seed 1.8 | text, image | 256,000 |
    | `volcengine/doubao-seed-code-preview-251028`| doubao-seed-code-preview-251028 | text, image | 256,000 |

    | `volcengine/kimi-k2-5-260127`| Kimi K2.5 | text, image | 256,000 |

    | `volcengine/glm-4-7-251222`| GLM 4.7 | text, image | 200,000 |
    | `volcengine/deepseek-v3-2-251201`| DeepSeek V3.2 | text, image | 128,000 |

  </Tab>
  <Tab title="缂栫▼锛坴olcengine-plan锛?>
    | 妯″瀷寮曠敤 | 鍚嶇О | 杈撳叆 | 涓婁笅鏂?|

    | ------------------------------------------------- | ------------------------ | ----- | ------- |

    | `volcengine-plan/ark-code-latest`| Ark Coding Plan | text | 256,000 |
    | `volcengine-plan/doubao-seed-code`| Doubao Seed Code | text | 256,000 |

    | `volcengine-plan/glm-4.7`| GLM 4.7 Coding | text | 200,000 |
    | `volcengine-plan/kimi-k2-thinking`| Kimi K2 Thinking | text | 256,000 |

    | `volcengine-plan/kimi-k2.5`| Kimi K2.5 Coding | text | 256,000 |

    | `volcengine-plan/doubao-seed-code-preview-251028`| Doubao Seed Code Preview | text | 256,000 |

  </Tab>
</Tabs>

## 楂樼骇璇存槑

<AccordionGroup>
  <Accordion title="璁剧疆鍚庣殑榛樿妯″瀷">`openclaw onboard --auth-choice volcengine-api-key`褰撳墠浼氬皢`volcengine-plan/ark-code-latest`璁剧疆涓洪粯璁ゆā鍨嬶紝鍚屾椂涔熶細娉ㄥ唽閫氱敤鐨?`volcengine`鐩綍銆?  </Accordion>

  <Accordion title="妯″瀷閫夋嫨鍣ㄥ洖閫€琛屼负">
    鍦ㄨ缃?閰嶇疆妯″瀷閫夋嫨鏈熼棿锛岀伀灞卞紩鎿庤璇侀€夋嫨浼氬悓鏃朵紭鍏堣€冭檻`volcengine/*`鍜?`volcengine-plan/*`琛屻€傚鏋滆繖浜涙ā鍨嬪皻鏈姞杞斤紝OpenClaw 浼氬洖閫€鍒版湭杩囨护鐨勭洰褰曪紝鑰屼笉鏄樉绀虹┖鐨勬彁渚涘晢鑼冨洿閫夋嫨鍣ㄣ€?  </Accordion>

<Accordion title="瀹堟姢杩涚▼鐨勭幆澧冨彉閲?>
濡傛灉缃戝叧浣滀负瀹堟姢杩涚▼锛坙aunchd/systemd锛夎繍琛岋紝璇风‘淇?`VOLCANO_ENGINE_API_KEY`瀵硅杩涚▼鍙敤锛堜緥濡傦紝鍦?`~/.openclaw/.env`涓垨閫氳繃`env.shellEnv`锛夈€? </Accordion>
</AccordionGroup>

<Warning>
褰撳皢 OpenClaw 浣滀负鍚庡彴鏈嶅姟杩愯鏃讹紝鍦ㄤ氦浜掑紡 shell 涓缃殑鐜鍙橀噺涓嶄細鑷姩缁ф壙銆傝鍙傞槄涓婇潰鐨勫畧鎶よ繘绋嬭鏄庛€?</Warning>

## 鐩稿叧鍐呭

<CardGroup cols={2}>
  <Card title="妯″瀷閫夋嫨" href="/concepts/model-providers" icon="layers">
    閫夋嫨鎻愪緵鍟嗐€佹ā鍨嬪紩鐢ㄥ拰鏁呴殰杞Щ琛屼负銆?  </Card>
  <Card title="閰嶇疆" href="/configuration" icon="gear">
    浠ｇ悊銆佹ā鍨嬪拰鎻愪緵鍟嗙殑瀹屾暣閰嶇疆鍙傝€冦€?  </Card>
  <Card title="鏁呴殰鎺掗櫎" href="/help/troubleshooting" icon="wrench">
    甯歌闂鍜岃皟璇曟楠ゃ€?  </Card>
  <Card title="甯歌闂" href="/help/faq" icon="circle-question">
    鍏充簬 OpenClaw 璁剧疆鐨勫父瑙侀棶棰樸€?  </Card>
</CardGroup>
