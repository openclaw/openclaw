---
read_when:
    - OpenClawでQwen（Alibaba Cloud Model Studio）を使用したい場合
    - Model StudioのAPIキー環境変数が必要な場合
    - Standard（従量課金制）またはCoding Planエンドポイントを使用したい場合
summary: Alibaba Cloud Model Studioのセットアップ（従量課金制とCoding Plan、デュアルリージョンエンドポイント）
title: Qwen / Model Studio
x-i18n:
    generated_at: "2026-04-02T07:50:49Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: f7cf566fada88d400c1927aa338f92073e467e1e8a32a82badff30a0c2982dad
    source_path: providers/qwen_modelstudio.md
    workflow: 15
---

# Qwen / Model Studio（Alibaba Cloud）

Model Studioプロバイダーは、Qwenやプラットフォーム上でホストされているサードパーティモデルなど、Alibaba Cloudのモデルへのアクセスを提供します。**Standard**（従量課金制）と**Coding Plan**（サブスクリプション）の2つの課金プランに対応しています。

- プロバイダー: `modelstudio`
- 認証: `MODELSTUDIO_API_KEY`
- API: OpenAI互換

## クイックスタート

### Standard（従量課金制）

```bash
# 中国エンドポイント
openclaw onboard --auth-choice modelstudio-standard-api-key-cn

# グローバル/国際エンドポイント
openclaw onboard --auth-choice modelstudio-standard-api-key
```

### Coding Plan（サブスクリプション）

```bash
# 中国エンドポイント
openclaw onboard --auth-choice modelstudio-api-key-cn

# グローバル/国際エンドポイント
openclaw onboard --auth-choice modelstudio-api-key
```

オンボーディング後、デフォルトモデルを設定します:

```json5
{
  agents: {
    defaults: {
      model: { primary: "modelstudio/qwen3.5-plus" },
    },
  },
}
```

## プランの種類とエンドポイント

| プラン                     | リージョン | 認証選択                            | エンドポイント                                     |
| -------------------------- | ---------- | ----------------------------------- | -------------------------------------------------- |
| Standard（従量課金制）     | 中国       | `modelstudio-standard-api-key-cn`   | `dashscope.aliyuncs.com/compatible-mode/v1`        |
| Standard（従量課金制）     | グローバル | `modelstudio-standard-api-key`      | `dashscope-intl.aliyuncs.com/compatible-mode/v1`   |
| Coding Plan（サブスクリプション） | 中国 | `modelstudio-api-key-cn`            | `coding.dashscope.aliyuncs.com/v1`                 |
| Coding Plan（サブスクリプション） | グローバル | `modelstudio-api-key`          | `coding-intl.dashscope.aliyuncs.com/v1`            |

プロバイダーは認証選択に基づいてエンドポイントを自動的に選択します。設定でカスタム `baseUrl` を指定してオーバーライドすることもできます。

## APIキーの取得

- **中国**: [bailian.console.aliyun.com](https://bailian.console.aliyun.com/)
- **グローバル/国際**: [modelstudio.console.alibabacloud.com](https://modelstudio.console.alibabacloud.com/)

## 利用可能なモデル

- **qwen3.5-plus**（デフォルト）— Qwen 3.5 Plus
- **qwen3-coder-plus**, **qwen3-coder-next** — Qwenコーディングモデル
- **GLM-5** — Alibaba経由のGLMモデル
- **Kimi K2.5** — Alibaba経由のMoonshot AI
- **MiniMax-M2.7** — Alibaba経由のMiniMax

一部のモデル（qwen3.5-plus、kimi-k2.5）は画像入力に対応しています。コンテキストウィンドウは200Kから1Mトークンの範囲です。

## 環境に関する注意

Gateway ゲートウェイがデーモン（launchd/systemd）として実行されている場合、`MODELSTUDIO_API_KEY` がそのプロセスで利用可能であることを確認してください（例: `~/.openclaw/.env` または `env.shellEnv` 経由）。
