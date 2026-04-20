---
summary: "閫氳繃 OpenClaw 鍐呯疆鐨?qwen 鎻愪緵鍟嗕娇鐢?Qwen Cloud"
read_when:
  - 浣犳兂鍦?OpenClaw 涓娇鐢?Qwen
  - 浣犱箣鍓嶄娇鐢ㄨ繃 Qwen OAuth
title: "Qwen"
---

# Qwen

<Warning>

**Qwen OAuth 宸茬Щ闄ゃ€?* 浣跨敤 `portal.qwen.ai` 绔偣鐨勫厤璐?OAuth 闆嗘垚锛坄qwen-portal`锛夊凡涓嶅啀鍙敤銆傝儗鏅俊鎭瑙?[Issue #49557](https://github.com/openclaw/openclaw/issues/49557)銆?
</Warning>

OpenClaw 鐜板湪灏?Qwen 浣滀负鍐呯疆鐨勪竴娴佹彁渚涘晢锛屽叾鏍囧噯 ID 涓?`qwen`銆傝鍐呯疆鎻愪緵鍟嗛拡瀵?Qwen Cloud / 闃块噷浜戠櫨鐐煎拰 Coding Plan 绔偣锛屽苟淇濈暀浜嗘棫鐗?`modelstudio` ID 浣滀负鍏煎鎬у埆鍚嶃€?
- 鎻愪緵鍟嗭細`qwen`
- 棣栭€夌幆澧冨彉閲忥細`QWEN_API_KEY`
- 涓轰簡鍏煎鎬т篃鍙帴鍙楋細`MODELSTUDIO_API_KEY`銆乣DASHSCOPE_API_KEY`
- API 椋庢牸锛歄penAI 鍏煎

<Tip>
濡傛灉浣犳兂瑕?`qwen3.6-plus`锛岃浼樺厛閫夋嫨 **鏍囧噯锛堟寜閲忎粯璐癸級** 绔偣銆侰oding Plan 鐨勬敮鎸佸彲鑳戒細婊炲悗浜庡叕寮€鐩綍銆?</Tip>

## 寮€濮嬩娇鐢?
閫夋嫨浣犵殑璁″垝绫诲瀷骞舵寜鐓ц缃楠ゆ搷浣溿€?
<Tabs>
  <Tab title="Coding Plan锛堣闃咃級">
    **鏈€閫傚悎锛?* 閫氳繃 Qwen Coding Plan 鐨勮闃呰闂€?
    <Steps>
      <Step title="鑾峰彇浣犵殑 API 瀵嗛挜">
        浠?[home.qwencloud.com/api-keys](https://home.qwencloud.com/api-keys) 鍒涘缓鎴栧鍒?API 瀵嗛挜銆?      </Step>
      <Step title="杩愯璁剧疆鍚戝">
        瀵逛簬 **鍏ㄧ悆** 绔偣锛?
        ```bash
        openclaw onboard --auth-choice qwen-api-key
        ```

        瀵逛簬 **涓浗** 绔偣锛?
        ```bash
        openclaw onboard --auth-choice qwen-api-key-cn
        ```
      </Step>
      <Step title="璁剧疆榛樿妯″瀷">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "qwen/qwen3.5-plus" },
            },
          },
        }
        ```
      </Step>
      <Step title="楠岃瘉妯″瀷鍙敤">
        ```bash
        openclaw models list --provider qwen
        ```
      </Step>
    </Steps>

    <Note>
    鏃х増 `modelstudio-*` 璁よ瘉閫夋嫨 ID 鍜?`modelstudio/...` 妯″瀷寮曠敤浠嶇劧浣滀负鍏煎鎬у埆鍚嶆湁鏁堬紝浣嗘柊鐨勮缃祦绋嬪簲浼樺厛浣跨敤鏍囧噯鐨?`qwen-*` 璁よ瘉閫夋嫨 ID 鍜?`qwen/...` 妯″瀷寮曠敤銆?    </Note>

  </Tab>

  <Tab title="鏍囧噯锛堟寜閲忎粯璐癸級">
    **鏈€閫傚悎锛?* 閫氳繃鏍囧噯 Model Studio 绔偣鐨勬寜閲忎粯璐硅闂紝鍖呮嫭鍙兘鍦?Coding Plan 涓婁笉鍙敤鐨?`qwen3.6-plus` 绛夋ā鍨嬨€?
    <Steps>
      <Step title="鑾峰彇浣犵殑 API 瀵嗛挜">
        浠?[home.qwencloud.com/api-keys](https://home.qwencloud.com/api-keys) 鍒涘缓鎴栧鍒?API 瀵嗛挜銆?      </Step>
      <Step title="杩愯璁剧疆鍚戝">
        瀵逛簬 **鍏ㄧ悆** 绔偣锛?
        ```bash
        openclaw onboard --auth-choice qwen-standard-api-key
        ```

        瀵逛簬 **涓浗** 绔偣锛?
        ```bash
        openclaw onboard --auth-choice qwen-standard-api-key-cn
        ```
      </Step>
      <Step title="璁剧疆榛樿妯″瀷">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "qwen/qwen3.5-plus" },
            },
          },
        }
        ```
      </Step>
      <Step title="楠岃瘉妯″瀷鍙敤">
        ```bash
        openclaw models list --provider qwen
        ```
      </Step>
    </Steps>

    <Note>
    鏃х増 `modelstudio-*` 璁よ瘉閫夋嫨 ID 鍜?`modelstudio/...` 妯″瀷寮曠敤浠嶇劧浣滀负鍏煎鎬у埆鍚嶆湁鏁堬紝浣嗘柊鐨勮缃祦绋嬪簲浼樺厛浣跨敤鏍囧噯鐨?`qwen-*` 璁よ瘉閫夋嫨 ID 鍜?`qwen/...` 妯″瀷寮曠敤銆?    </Note>

  </Tab>
</Tabs>

## 璁″垝绫诲瀷鍜岀鐐?
| 璁″垝 | 鍖哄煙 | 璁よ瘉閫夋嫨 | 绔偣 |
| -------------------------- | ------ | -------------------------- | ------------------------------------------------ |
| 鏍囧噯锛堟寜閲忎粯璐癸級 | 涓浗 | `qwen-standard-api-key-cn` | `dashscope.aliyuncs.com/compatible-mode/v1` |
| 鏍囧噯锛堟寜閲忎粯璐癸級 | 鍏ㄧ悆 | `qwen-standard-api-key` | `dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Coding Plan锛堣闃咃級 | 涓浗 | `qwen-api-key-cn` | `coding.dashscope.aliyuncs.com/v1` |
| Coding Plan锛堣闃咃級 | 鍏ㄧ悆 | `qwen-api-key` | `coding-intl.dashscope.aliyuncs.com/v1` |

鎻愪緵鍟嗕細鏍规嵁浣犵殑璁よ瘉閫夋嫨鑷姩閫夋嫨绔偣銆傛爣鍑嗛€夋嫨浣跨敤 `qwen-*` 绯诲垪锛沗modelstudio-*` 浠呯敤浜庡吋瀹规€х洰鐨勩€備綘鍙互鍦ㄩ厤缃腑浣跨敤鑷畾涔?`baseUrl` 杩涜瑕嗙洊銆?
<Tip>
**绠＄悊瀵嗛挜锛?* [home.qwencloud.com/api-keys](https://home.qwencloud.com/api-keys) |
**鏂囨。锛?* [docs.qwencloud.com](https://docs.qwencloud.com/developer-guides/getting-started/introduction)
</Tip>

## 鍐呯疆妯″瀷鐩綍

OpenClaw 褰撳墠闄勫甫姝ゅ唴缃殑 Qwen 鐩綍銆傞厤缃殑鐩綍鍏锋湁绔偣鎰熺煡鑳藉姏锛欳oding Plan 閰嶇疆浼氱渷鐣ヤ粎鍦ㄦ爣鍑嗙鐐逛笂鍙敤鐨勬ā鍨嬨€?
| 妯″瀷寮曠敤 | 杈撳叆 | 涓婁笅鏂?| 璇存槑 |
| --------------------------- | ----------- | --------- | -------------------------------------------------- |
| `qwen/qwen3.5-plus` | text, image | 1,000,000 | 榛樿妯″瀷 |
| `qwen/qwen3.6-plus` | text, image | 1,000,000 | 闇€瑕佹妯″瀷鏃惰浼樺厛浣跨敤鏍囧噯绔偣 |
| `qwen/qwen3-max-2026-01-23` | text | 262,144 | Qwen Max 绯诲垪 |
| `qwen/qwen3-coder-next` | text | 262,144 | 缂栫▼ |
| `qwen/qwen3-coder-plus` | text | 1,000,000 | 缂栫▼ |
| `qwen/MiniMax-M2.5` | text | 1,000,000 | 宸插惎鐢ㄦ€濊€?|
| `qwen/glm-5` | text | 202,752 | GLM |
| `qwen/glm-4.7` | text | 202,752 | GLM |
| `qwen/kimi-k2.5` | text, image | 262,144 | 閫氳繃闃块噷宸村反鐨?Moonshot AI |

<Note>
鍗充娇鏌愪釜妯″瀷瀛樺湪浜庡唴缃洰褰曚腑锛屽叾鍙敤鎬т粛鍙兘鍥犵鐐瑰拰璁¤垂璁″垝鑰屽紓銆?</Note>

## 澶氭ā鎬侀檮鍔犲姛鑳?
`qwen` 鎵╁睍杩樺湪 **鏍囧噯** 鐧剧偧绔偣锛堣€岄潪 Coding Plan 绔偣锛変笂鍏紑浜嗗妯℃€佸姛鑳斤細

- **瑙嗛鐞嗚В** 閫氳繃 `qwen-vl-max-latest`
- **涓囩浉瑙嗛鐢熸垚** 閫氳繃 `wan2.6-t2v`锛堥粯璁わ級銆乣wan2.6-i2v`銆乣wan2.6-r2v`銆乣wan2.6-r2v-flash`銆乣wan2.7-r2v`

瑕佸皢 Qwen 鐢ㄤ綔榛樿瑙嗛鎻愪緵鍟嗭細

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
    },
  },
}
```

<Note>
璇峰弬闃?[瑙嗛鐢熸垚](/tools/video-generation) 浜嗚В鍏变韩宸ュ叿鍙傛暟銆佹彁渚涘晢閫夋嫨鍜屾晠闅滆浆绉昏涓恒€?</Note>

## 楂樼骇閰嶇疆

<AccordionGroup>
  <Accordion title="鍥惧儚鍜岃棰戠悊瑙?>
    鍐呯疆鐨?Qwen 鎻掍欢鍦?**鏍囧噯** 鐧剧偧绔偣锛堣€岄潪 Coding Plan 绔偣锛変笂娉ㄥ唽浜嗗浘鍍忓拰瑙嗛鐨勫獟浣撶悊瑙ｅ姛鑳姐€?
    | 灞炴€?| 鍊?|
    | ------------- | --------------------- |
    | 妯″瀷 | `qwen-vl-max-latest` |
    | 鏀寔鐨勮緭鍏?| 鍥惧儚銆佽棰?|

    濯掍綋鐞嗚В鍔熻兘浼氳嚜鍔ㄤ粠閰嶇疆鐨?Qwen 璁よ瘉涓В鏋?鈥?鏃犻渶棰濆閰嶇疆銆傜‘淇濅綘浣跨敤鐨勬槸鏍囧噯锛堟寜閲忎粯璐癸級绔偣浠ヨ幏寰楀獟浣撶悊瑙ｆ敮鎸併€?
  </Accordion>

  <Accordion title="Qwen 3.6 Plus 鍙敤鎬?>
    `qwen3.6-plus` 鍦ㄦ爣鍑嗭紙鎸夐噺浠樿垂锛塎odel Studio 绔偣涓婂彲鐢細

    - 涓浗锛歚dashscope.aliyuncs.com/compatible-mode/v1`
    - 鍏ㄧ悆锛歚dashscope-intl.aliyuncs.com/compatible-mode/v1`

    濡傛灉 Coding Plan 绔偣瀵?`qwen3.6-plus` 杩斿洖鈥滀笉鏀寔鐨勬ā鍨嬧€濋敊璇紝璇峰垏鎹㈠埌鏍囧噯锛堟寜閲忎粯璐癸級绔偣/瀵嗛挜瀵癸紝鑰屼笉鏄娇鐢?Coding Plan銆?
  </Accordion>

  <Accordion title="鍔熻兘璺嚎鍥?>
    `qwen` 鎵╁睍姝ｈ瀹氫綅涓哄畬鏁?Qwen Cloud 鍔熻兘鐨勬彁渚涘晢锛岃€屼笉浠呬粎鏄紪绋?鏂囨湰妯″瀷銆?
    - **鏂囨湰/鑱婂ぉ妯″瀷锛?* 宸插唴缃?    - **宸ュ叿璋冪敤銆佺粨鏋勫寲杈撳嚭銆佹€濊€冿細** 浠?OpenAI 鍏煎浼犺緭缁ф壙
    - **鍥惧儚鐢熸垚锛?* 璁″垝鍦ㄦ彁渚涘晢鎻掍欢灞傚疄鐜?    - **鍥惧儚/瑙嗛鐞嗚В锛?* 宸插湪鍐呯疆浜庢爣鍑嗙鐐?    - **璇煶/闊抽锛?* 璁″垝鍦ㄦ彁渚涘晢鎻掍欢灞傚疄鐜?    - **璁板繂宓屽叆/閲嶆帓搴忥細** 璁″垝閫氳繃宓屽叆閫傞厤鍣ㄦ帴鍙ｅ疄鐜?    - **瑙嗛鐢熸垚锛?* 宸查€氳繃鍏变韩瑙嗛鐢熸垚鍔熻兘鍐呯疆

  </Accordion>

  <Accordion title="瑙嗛鐢熸垚璇︾粏淇℃伅">
    瀵逛簬瑙嗛鐢熸垚锛孫penClaw 鍦ㄦ彁浜や换鍔′箣鍓嶄細灏嗛厤缃殑 Qwen 鍖哄煙鏄犲皠鍒板尮閰嶇殑鐧剧偧 AIGC 涓绘満锛?
    - 鍏ㄧ悆/鍥介檯锛歚https://dashscope-intl.aliyuncs.com`
    - 涓浗锛歚https://dashscope.aliyuncs.com`

    杩欐剰鍛崇潃鎸囧悜 Coding Plan 鎴栨爣鍑?Qwen 涓绘満鐨勬櫘閫?`models.providers.qwen.baseUrl` 浠嶇劧浼氬皢瑙嗛鐢熸垚淇濇寔鍦ㄦ纭殑鍖哄煙鐧剧偧瑙嗛绔偣涓娿€?
    褰撳墠鍐呯疆 Qwen 瑙嗛鐢熸垚闄愬埗锛?
    - 姣忎釜璇锋眰鏈€澶?**1** 涓緭鍑鸿棰?    - 鏈€澶?**1** 涓緭鍏ュ浘鍍?    - 鏈€澶?**4** 涓緭鍏ヨ棰?    - 鏈€澶?**10 绉?* 鏃堕暱
    - 鏀寔 `size`銆乣aspectRatio`銆乣resolution`銆乣audio` 鍜?`watermark`
    - 鍙傝€冨浘鍍?瑙嗛妯″紡褰撳墠闇€瑕?**杩滅▼ http(s) URL**銆傜敱浜庣櫨鐐艰棰戠鐐逛笉鎺ュ彈涓婁紶鐨勬湰鍦扮紦鍐插尯鐢ㄤ簬杩欎簺鍙傝€冿紝鏈湴鏂囦欢璺緞浼氳棰勫厛鎷掔粷銆?
  </Accordion>

  <Accordion title="娴佸紡浣跨敤鍏煎鎬?>
    鍘熺敓 Model Studio 绔偣鍦ㄥ叡浜殑 `openai-completions` 浼犺緭涓婂浼犳祦寮忎娇鐢ㄥ吋瀹规€с€侽penClaw 鐜板湪浼氬皢绔偣鍔熻兘涓庡瘑閽ュ叧鑱旓紝鍥犳閽堝鐩稿悓鍘熺敓涓绘満鐨勫吋瀹硅嚜瀹氫箟鎻愪緵鍟?ID 浼氱户鎵跨浉鍚岀殑娴佸紡浣跨敤琛屼负锛岃€屼笉鏄笓闂ㄨ姹傚唴缃殑 `qwen` 鎻愪緵鍟?ID銆?
    鍘熺敓娴佸紡浣跨敤鍏煎鎬ч€傜敤浜?Coding Plan 涓绘満鍜屾爣鍑嗙櫨鐐煎吋瀹逛富鏈猴細

    - `https://coding.dashscope.aliyuncs.com/v1`
    - `https://coding-intl.dashscope.aliyuncs.com/v1`
    - `https://dashscope.aliyuncs.com/compatible-mode/v1`
    - `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`

  </Accordion>

  <Accordion title="澶氭ā鎬佺鐐瑰尯鍩?>
    澶氭ā鎬佹帴鍙ｏ紙瑙嗛鐞嗚В鍜屼竾鐩歌棰戠敓鎴愶級浣跨敤 **鏍囧噯** 鐧剧偧绔偣锛岃€屼笉鏄?Coding Plan 绔偣锛?
    - 鍏ㄧ悆/鍥介檯鏍囧噯鍩哄潃锛歚https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
    - 涓浗鏍囧噯鍩哄潃锛歚https://dashscope.aliyuncs.com/compatible-mode/v1`

  </Accordion>

  <Accordion title="鐜鍜屽畧鎶よ繘绋嬭缃?>
    濡傛灉缃戝叧浣滀负瀹堟姢杩涚▼锛坙aunchd/systemd锛夎繍琛岋紝璇风‘淇?`QWEN_API_KEY` 瀵硅杩涚▼鍙敤锛堜緥濡傦紝鍦?`~/.openclaw/.env` 涓垨閫氳繃 `env.shellEnv`锛夈€?  </Accordion>
</AccordionGroup>

## 鐩稿叧鍐呭

<CardGroup cols={2}>
  <Card title="妯″瀷閫夋嫨" href="/concepts/model-providers" icon="layers">
    閫夋嫨鎻愪緵鍟嗐€佹ā鍨嬪紩鐢ㄥ拰鏁呴殰杞Щ琛屼负銆?  </Card>
  <Card title="瑙嗛鐢熸垚" href="/tools/video-generation" icon="video">
    鍏变韩瑙嗛宸ュ叿鍙傛暟鍜屾彁渚涘晢閫夋嫨銆?  </Card>
  <Card title="闃块噷宸村反锛圡odelStudio锛? href="/providers/alibaba" icon="cloud">
    鏃х増 ModelStudio 鎻愪緵鍟嗗拰杩佺Щ璇存槑銆?  </Card>
  <Card title="鏁呴殰鎺掗櫎" href="/help/troubleshooting" icon="wrench">
    涓€鑸晠闅滄帓闄ゅ拰甯歌闂銆?  </Card>
</CardGroup>