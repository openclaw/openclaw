---
summary: "Claude Max/Pro サブスクリプションを OpenAI 互換 API エンドポイントとして使用します"
read_when:
  - OpenAI 互換ツールで Claude Max サブスクリプションを使用したい場合
  - Claude Code CLI をラップするローカル API サーバーが必要な場合
  - API キーではなくサブスクリプションを使用してコストを節約したい場合
title: "Claude Max API プロキシ"
---

# Claude Max API プロキシ

**claude-max-api-proxy** は、Claude Max/Pro サブスクリプションを OpenAI 互換の API エンドポイントとして公開するコミュニティツールです。これにより、OpenAI API 形式をサポートするあらゆるツールでサブスクリプションを使用できます。 これにより、OpenAI API形式をサポートする任意のツールでサブスクリプションを使用できます。

## なぜ使用するのですか？

| アプローチ                | コスト                                                               | 最適な用途          |
| -------------------- | ----------------------------------------------------------------- | -------------- |
| Anthropic API        | トークン課金（Opus は入力 ~$15/M、出力 ~$75/M） | 本番アプリ、高ボリューム   |
| Claude Max サブスクリプション | 月額 $200 の定額                                                       | 個人利用、開発、無制限の使用 |

Claude Max サブスクリプションをお持ちで、OpenAI 互換ツールで使用したい場合、このプロキシにより大幅なコスト削減が可能です。

## 仕組み

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

このプロキシは次を行います。

1. `http://localhost:3456/v1/chat/completions` で OpenAI 形式のリクエストを受け付けます。
2. それらを Claude Code CLI のコマンドに変換します。
3. OpenAI 形式でレスポンスを返します（ストリーミング対応）。

## インストール

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## 使用方法

### サーバーを起動する

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### テストする

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### OpenClaw と併用する

カスタムの OpenAI 互換エンドポイントとして、OpenClaw をこのプロキシに向けることができます。

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

| モデル ID            | 地図先             |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## macOS での自動起動

プロキシを自動的に実行するために LaunchAgent を作成します。

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

## 注記

- これは **コミュニティツール** であり、Anthropic または OpenClaw による公式サポートはありません。
- Claude Code CLI が認証された、有効な Claude Max/Pro サブスクリプションが必要です。
- プロキシはローカルで実行され、第三者のサーバーにデータを送信しません。
- ストリーミングレスポンスは完全にサポートされています。

## See Also

- [Anthropic プロバイダー](/providers/anthropic) - setup-token または API キーを用いた Claude のネイティブ OpenClaw 統合
- [OpenAI プロバイダー](/providers/openai) - OpenAI/Codex サブスクリプション向け
