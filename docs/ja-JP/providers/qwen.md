---
read_when:
    - OpenClawでQwenを使用したい場合
    - 以前Qwen OAuthを使用していた場合
summary: Alibaba Cloud Model Studio経由でQwenモデルを使用する
title: Qwen
x-i18n:
    generated_at: "2026-04-02T07:50:39Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: d3f2fb1cbfa1257acbef8682d1397c31e87bf608d992175aa973e3215203bac1
    source_path: providers/qwen.md
    workflow: 15
---

# Qwen

<Warning>

**Qwen OAuthは削除されました。** `portal.qwen.ai`エンドポイントを使用していた無料枠のOAuth統合（`qwen-portal`）は利用できなくなりました。
背景については[Issue #49557](https://github.com/openclaw/openclaw/issues/49557)を参照してください。

</Warning>

## 推奨: Model Studio（Alibaba Cloud Coding Plan）

Qwenモデル（Qwen 3.5 Plus、GLM-4.7、Kimi K2.5など）への公式サポート付きアクセスには[Model Studio](/providers/qwen_modelstudio)を使用してください。

```bash
# グローバルエンドポイント
openclaw onboard --auth-choice modelstudio-api-key

# 中国エンドポイント
openclaw onboard --auth-choice modelstudio-api-key-cn
```

セットアップの詳細は[Model Studio](/providers/qwen_modelstudio)を参照してください。
