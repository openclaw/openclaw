---
read_when:
    - Claude MaxサブスクリプションをOpenAI互換ツールで使用したい場合
    - Claude Code CLIをラップするローカルAPIサーバーが必要な場合
    - サブスクリプションベースとAPIキーベースのAnthropicアクセスを評価したい場合
summary: Claudeサブスクリプションの認証情報をOpenAI互換エンドポイントとして公開するコミュニティプロキシ
title: Claude Max APIプロキシ
x-i18n:
    generated_at: "2026-04-02T08:37:52Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: f1e379025bd26798973e6eff790a4c88835a8d5e3032abcef300d45fdf81afb9
    source_path: providers/claude-max-api-proxy.md
    workflow: 15
---

# Claude Max APIプロキシ

**claude-max-api-proxy**は、Claude Max/ProサブスクリプションをOpenAI互換APIエンドポイントとして公開するコミュニティツールです。これにより、OpenAI APIフォーマットをサポートする任意のツールでサブスクリプションを使用できます。

<Warning>
このパスは技術的な互換性のみを目的としています。Anthropicは過去にClaude Code以外でのサブスクリプション利用をブロックしたことがあります。使用するかどうかはご自身で判断し、依存する前にAnthropicの現在の利用規約を確認してください。
</Warning>

## なぜ使うのか？

| アプローチ                | コスト                                                | 最適な用途                                   |
| ----------------------- | --------------------------------------------------- | ------------------------------------------ |
| Anthropic API           | トークン単位の課金（Opusで入力 約$15/M、出力 $75/M） | 本番アプリ、大量利用               |
| Claude Maxサブスクリプション | 月額$200の定額                                     | 個人利用、開発、無制限利用 |

Claude Maxサブスクリプションを持っていて、OpenAI互換ツールで使用したい場合、このプロキシは一部のワークフローでコスト削減に役立つ可能性があります。本番利用にはAPIキーがポリシー上より明確な方法です。

## 仕組み

```
アプリ → claude-max-api-proxy → Claude Code CLI → Anthropic（サブスクリプション経由）
     （OpenAIフォーマット）        （フォーマット変換）      （ログイン情報を使用）
```

プロキシの動作：

1. `http://localhost:3456/v1/chat/completions`でOpenAIフォーマットのリクエストを受け付ける
2. Claude Code CLIコマンドに変換する
3. OpenAIフォーマットでレスポンスを返す（ストリーミング対応）

## インストール

```bash
# Node.js 20+とClaude Code CLIが必要です
npm install -g claude-max-api-proxy

# Claude CLIが認証済みであることを確認
claude --version
```

## 使い方

### サーバーの起動

```bash
claude-max-api
# サーバーが http://localhost:3456 で起動します
```

### テスト

```bash
# ヘルスチェック
curl http://localhost:3456/health

# モデル一覧
curl http://localhost:3456/v1/models

# チャット補完
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### OpenClawでの使用

OpenClawからプロキシをカスタムOpenAI互換エンドポイントとして指定できます：

```json5
{
  env: {
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:3456/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/claude-opus-4" },
    },
  },
}
```

## 利用可能なモデル

| モデルID          | マッピング先         |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## macOSでの自動起動

LaunchAgentを作成してプロキシを自動的に実行します：

```bash
cat > ~/Library/LaunchAgents/com.claude-max-api.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-max-api</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:~/.local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-max-api.plist
```

## リンク

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## 注意事項

- これは**コミュニティツール**であり、AnthropicやOpenClawが公式にサポートするものではありません
- Claude Code CLIで認証済みのアクティブなClaude Max/Proサブスクリプションが必要です
- プロキシはローカルで実行され、サードパーティサーバーにデータを送信しません
- ストリーミングレスポンスに完全対応しています

## 関連項目

- [Anthropicプロバイダー](/providers/anthropic) - Claudeセットアップトークンまたはキーを使用したOpenClawネイティブ統合
- [OpenAIプロバイダー](/providers/openai) - OpenAI/Codexサブスクリプション向け
