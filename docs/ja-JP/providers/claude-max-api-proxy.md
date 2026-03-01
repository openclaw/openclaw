---
summary: "Claude Max/ProサブスクリプションをOpenAI互換APIエンドポイントとして使用する"
read_when:
  - OpenAI互換ツールでClaude Maxサブスクリプションを使いたい場合
  - Claude Code CLIをラップするローカルAPIサーバーが欲しい場合
  - APIキーの代わりにサブスクリプションを使ってコストを節約したい場合
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy**は、Claude Max/ProサブスクリプションをOpenAI互換APIエンドポイントとして公開するコミュニティツールです。これにより、OpenAI API形式をサポートする任意のツールでサブスクリプションを利用できます。

## なぜ使うのか

| アプローチ                  | コスト                                                   | 適した用途                                     |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| Anthropic API           | トークンごとの従量課金（Opusで入力約$15/M、出力$75/M） | プロダクションアプリ、大容量                   |
| Claude Maxサブスクリプション | 月額$200の定額                                          | 個人利用、開発、無制限使用                     |

Claude Maxサブスクリプションをお持ちで、OpenAI互換ツールで利用したい場合、このプロキシで大幅なコスト削減ができます。

## 仕組み

```
あなたのアプリ → claude-max-api-proxy → Claude Code CLI → Anthropic（サブスクリプション経由）
（OpenAI形式）              （形式変換）          （ログインを利用）
```

プロキシの動作:

1. `http://localhost:3456/v1/chat/completions` でOpenAI形式のリクエストを受け付けます
2. Claude Code CLIコマンドに変換します
3. OpenAI形式でレスポンスを返します（ストリーミング対応）

## インストール

```bash
# Node.js 20以降とClaude Code CLIが必要
npm install -g claude-max-api-proxy

# Claude CLIが認証されているか確認する
claude --version
```

## 使用方法

### サーバーを起動する

```bash
claude-max-api
# サーバーは http://localhost:3456 で動作します
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

### OpenClawで使用する

OpenClawをカスタムOpenAI互換エンドポイントとしてプロキシに向けることができます:

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

| モデルID              | マップ先          |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## macOSでの自動起動

LaunchAgentを作成してプロキシを自動的に実行します:

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

- これはAnthropicまたはOpenClawが公式にサポートする製品ではなく、**コミュニティツール**です
- Claude Code CLIで認証済みのアクティブなClaude Max/Proサブスクリプションが必要です
- プロキシはローカルで実行され、サードパーティサーバーにデータを送信しません
- ストリーミングレスポンスは完全にサポートされています

## 関連情報

- [Anthropicプロバイダー](/providers/anthropic) - Claude setup-tokenまたはAPIキーによるOpenClawネイティブ統合
- [OpenAIプロバイダー](/providers/openai) - OpenAI/Codexサブスクリプション用
