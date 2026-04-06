---
read_when:
    - OpenClawでGoogle Geminiモデルを使用したい場合
    - APIキーまたはOAuth認証フローが必要な場合
summary: Google Geminiのセットアップ（APIキー + OAuth、画像生成、メディア理解、ウェブ検索）
title: Google (Gemini)
x-i18n:
    generated_at: "2026-04-02T08:38:00Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 89a9edc5dbcd59b18bab029016e1c578983c85e673b99191ed56e589bedc23e1
    source_path: providers/google.md
    workflow: 15
---

# Google (Gemini)

GoogleプラグインはGoogle AI Studioを通じてGeminiモデルへのアクセスを提供するほか、画像生成、メディア理解（画像/音声/動画）、およびGemini Groundingによるウェブ検索に対応しています。

- プロバイダー: `google`
- 認証: `GEMINI_API_KEY` または `GOOGLE_API_KEY`
- API: Google Gemini API
- 代替プロバイダー: `google-gemini-cli`（OAuth）

## クイックスタート

1. APIキーを設定します:

```bash
openclaw onboard --auth-choice google-api-key
```

2. デフォルトモデルを設定します:

```json5
{
  agents: {
    defaults: {
      model: { primary: "google/gemini-3.1-pro-preview" },
    },
  },
}
```

## 非対話式の例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice google-api-key \
  --gemini-api-key "$GEMINI_API_KEY"
```

## OAuth (Gemini CLI)

代替プロバイダー `google-gemini-cli` はAPIキーの代わりにPKCE OAuthを使用します。これは非公式のインテグレーションであり、アカウント制限が報告されているユーザーもいます。自己責任でご使用ください。

環境変数:

- `OPENCLAW_GEMINI_OAUTH_CLIENT_ID`
- `OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET`

（または `GEMINI_CLI_*` バリアントも使用可能です。）

## 機能

| 機能                          | サポート状況      |
| ----------------------------- | ----------------- |
| チャット補完                  | あり              |
| 画像生成                      | あり              |
| 画像理解                      | あり              |
| 音声文字起こし                | あり              |
| 動画理解                      | あり              |
| ウェブ検索（Grounding）       | あり              |
| 思考/推論                     | あり（Gemini 3.1+）|

## 環境に関する注意

Gateway ゲートウェイがデーモン（launchd/systemd）として実行される場合、`GEMINI_API_KEY` がそのプロセスで利用可能であることを確認してください（例: `~/.openclaw/.env` または `env.shellEnv` 経由）。
