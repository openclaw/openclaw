---
summary: "GLM 妯″瀷绯诲垪姒傝 + 濡備綍鍦?OpenClaw 涓娇鐢ㄥ畠"
read_when:
  - 浣犳兂鍦?OpenClaw 涓娇鐢?GLM 妯″瀷
  - 浣犻渶瑕佹ā鍨嬪懡鍚嶇害瀹氬拰璁剧疆鏂规硶
title: "GLM (Zhipu)"
---

# GLM 妯″瀷

GLM 鏄€氳繃 Z.AI 骞冲彴鎻愪緵鐨勪竴涓?\*妯″瀷绯诲垪\*\*锛堜笉鏄叕鍙革級銆傚湪 OpenClaw 涓紝GLM 妯″瀷閫氳繃 `zai` 鎻愪緵鍟嗗拰绫讳技 `zai/glm-5` 鐨勬ā鍨?ID 璁块棶銆?

## 寮€濮嬩娇鐢?

<Steps>
  <Step title="閫夋嫨璁よ瘉璺敱骞惰繍琛岃缃悜瀵?>
    閫夋嫨涓庝綘鐨?Z.AI 璁″垝鍜屽尯鍩熷尮閰嶇殑璁剧疆閫夐」锛?
    | 璁よ瘉閫夐」 | 鏈€閫傚悎 |
    | ----------- | -------- |
    | `zai-api-key` | 鍏锋湁绔偣鑷姩妫€娴嬪姛鑳界殑閫氱敤 API 瀵嗛挜璁剧疆 |
    | `zai-coding-global` | Coding Plan 鐢ㄦ埛锛堝叏鐞冿級 |
    | `zai-coding-cn` | Coding Plan 鐢ㄦ埛锛堜腑鍥藉尯鍩燂級 |
    | `zai-global` | 閫氱敤 API锛堝叏鐞冿級 |
    | `zai-cn` | 閫氱敤 API锛堜腑鍥藉尯鍩燂級 |

    ```bash
    # 绀轰緥锛氶€氱敤鑷姩妫€娴?    openclaw onboard --auth-choice zai-api-key

    # 绀轰緥锛欳oding Plan 鍏ㄧ悆
    openclaw onboard --auth-choice zai-coding-global
    ```

  </Step>
  <Step title="灏?GLM 璁剧疆涓洪粯璁ゆā鍨?>
    ```bash
    openclaw config set agents.defaults.model.primary "zai/glm-5.1"
    ```
  </Step>
  <Step title="楠岃瘉妯″瀷鍙敤">
    ```bash
    openclaw models list --provider zai
    ```
  </Step>
</Steps>

## 閰嶇疆绀轰緥

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5.1" } } },
}
```

<Tip>
`zai-api-key` 鍏佽 OpenClaw 浠庡瘑閽ヤ腑妫€娴嬪尮閰嶇殑 Z.AI 绔偣锛屽苟鑷姩搴旂敤姝ｇ‘鐨勫熀 URL銆傚綋浣犳兂瑕佸己鍒朵娇鐢ㄧ壒瀹氱殑 Coding Plan 鎴栭€氱敤 API 鎺ュ彛鏃讹紝璇蜂娇鐢ㄦ槑纭殑鍖哄煙閫夐」銆?</Tip>

## 鍐呯疆 GLM 妯″瀷

OpenClaw 褰撳墠涓哄唴缃殑 `zai` 鎻愪緵鍟嗛缃簡杩欎簺 GLM 寮曠敤锛?
| 妯″瀷 | 妯″瀷 |
| --------------- | ---------------- |
| `glm-5.1` | `glm-4.7` |
| `glm-5` | `glm-4.7-flash` |
| `glm-5-turbo` | `glm-4.7-flashx` |
| `glm-5v-turbo` | `glm-4.6` |
| `glm-4.5` | `glm-4.6v` |
| `glm-4.5-air` | |
| `glm-4.5-flash` | |
| `glm-4.5v` | |

<Note>
榛樿鐨勫唴缃ā鍨嬪紩鐢ㄦ槸 `zai/glm-5.1`銆侴LM 鐗堟湰鍜屽彲鐢ㄦ€у彲鑳戒細鍙戠敓鍙樺寲锛涜鏌ョ湅 Z.AI 鐨勬枃妗ｄ互鑾峰彇鏈€鏂颁俊鎭€?</Note>

## 楂樼骇璇存槑

<AccordionGroup>
  <Accordion title="绔偣鑷姩妫€娴?>
    褰撲綘浣跨敤 `zai-api-key` 璁よ瘉閫夐」鏃讹紝OpenClaw 浼氭鏌ュ瘑閽ユ牸寮忎互纭畾姝ｇ‘鐨?Z.AI 鍩?URL銆傛槑纭殑鍖哄煙閫夐」锛坄zai-coding-global`銆乣zai-coding-cn`銆乣zai-global`銆乣zai-cn`锛変細瑕嗙洊鑷姩妫€娴嬪苟鐩存帴鍥哄畾绔偣銆?  </Accordion>

<Accordion title="鎻愪緵鍟嗚鎯?>
GLM 妯″瀷鐢?`zai` 杩愯鏃舵彁渚涘晢鎻愪緵銆傛湁鍏冲畬鏁寸殑鎻愪緵鍟嗛厤缃€佸尯鍩熺鐐瑰拰鍏朵粬鍔熻兘锛岃鍙傞槄 [Z.AI 鎻愪緵鍟嗘枃妗(/providers/zai)銆? </Accordion>
</AccordionGroup>

## 鐩稿叧鍐呭

<CardGroup cols={2}>
  <Card title="Z.AI 鎻愪緵鍟? href="/providers/zai" icon="server">
    瀹屾暣鐨?Z.AI 鎻愪緵鍟嗛厤缃拰鍖哄煙绔偣銆?  </Card>
  <Card title="妯″瀷閫夋嫨" href="/concepts/model-providers" icon="layers">
    閫夋嫨鎻愪緵鍟嗐€佹ā鍨嬪紩鐢ㄥ拰鏁呴殰杞Щ琛屼负銆?  </Card>
</CardGroup>
