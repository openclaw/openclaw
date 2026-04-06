---
read_when:
    - OpenClawでGLMモデルを使用したいとき
    - モデルの命名規則とセットアップが必要なとき
summary: GLMモデルファミリーの概要とOpenClawでの使用方法
title: GLMモデル
x-i18n:
    generated_at: "2026-04-02T08:37:54Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 474bc8150c55a7e82c1a920b9d319e96e08a208e34641d3afd8049804a619074
    source_path: providers/glm.md
    workflow: 15
---

# GLMモデル

GLMはZ.AIプラットフォームを通じて利用できる**モデルファミリー**（企業ではありません）です。OpenClawでは、GLMモデルは `zai` プロバイダーと `zai/glm-5` のようなモデルIDを介してアクセスされます。

## CLIセットアップ

```bash
# Coding Plan Global、Coding Planユーザーに推奨
openclaw onboard --auth-choice zai-coding-global

# Coding Plan CN（中国リージョン）、Coding Planユーザーに推奨
openclaw onboard --auth-choice zai-coding-cn

# 汎用API
openclaw onboard --auth-choice zai-global

# 汎用API CN（中国リージョン）
openclaw onboard --auth-choice zai-cn
```

## 設定スニペット

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 注意事項

- GLMのバージョンと利用可能性は変更される場合があります。最新情報はZ.AIのドキュメントをご確認ください。
- モデルIDの例として、`glm-5.1`、`glm-5`、`glm-5v-turbo`、`glm-4.7`、`glm-4.6` などがあります。
- プロバイダーの詳細については、[/providers/zai](/providers/zai) をご覧ください。
