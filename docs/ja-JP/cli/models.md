---
read_when:
    - デフォルトモデルを変更したい、またはプロバイダーの認証ステータスを確認したい
    - 利用可能なモデル/プロバイダーをスキャンしたい、または認証プロファイルをデバッグしたい
summary: '`openclaw models`（ステータス/一覧/設定/スキャン、エイリアス、フォールバック、認証）のCLIリファレンス'
title: models
x-i18n:
    generated_at: "2026-04-02T07:34:13Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: fa1b39c1f4b9b4508723f7ab1a686cfd5d2ddc50a5e43fc015a31233f1d2ee9c
    source_path: cli/models.md
    workflow: 15
---

# `openclaw models`

モデルのディスカバリー、スキャン、設定（デフォルトモデル、フォールバック、認証プロファイル）。

関連:

- プロバイダー＋モデル: [モデル](/providers/models)
- プロバイダー認証セットアップ: [はじめに](/start/getting-started)

## よく使うコマンド

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status`は解決されたデフォルト/フォールバックと認証の概要を表示します。
プロバイダーの使用量スナップショットが利用可能な場合、OAuth/トークンステータスセクションにプロバイダーの使用量ヘッダーが含まれます。
`--probe`を追加すると、設定された各プロバイダープロファイルに対してライブ認証プローブを実行します。
プローブは実際のリクエストです（トークンを消費し、レート制限をトリガーする可能性があります）。
`--agent <id>`を使用して、設定されたエージェントのモデル/認証状態を検査します。省略した場合、コマンドは`OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`が設定されていればそれを使用し、それ以外の場合は設定されたデフォルトエージェントを使用します。

注意事項:

- `models set <model-or-alias>`は`provider/model`またはエイリアスを受け付けます。
- モデル参照は**最初の**`/`で分割して解析されます。モデルIDに`/`が含まれる場合（OpenRouterスタイル）、プロバイダープレフィックスを含めてください（例: `openrouter/moonshotai/kimi-k2`）。
- プロバイダーを省略した場合、OpenClawは入力をエイリアスまたは**デフォルトプロバイダー**のモデルとして扱います（モデルIDに`/`が含まれない場合のみ動作します）。
- `models status`は認証出力で、非シークレットプレースホルダー（例: `OPENAI_API_KEY`、`secretref-managed`、`minimax-oauth`、`oauth:chutes`、`ollama-local`）をシークレットとしてマスキングする代わりに`marker(<value>)`として表示する場合があります。

### `models status`

オプション:

- `--json`
- `--plain`
- `--check`（終了コード 1=期限切れ/欠落、2=期限切れ間近）
- `--probe`（設定された認証プロファイルのライブプローブ）
- `--probe-provider <name>`（1つのプロバイダーをプローブ）
- `--probe-profile <id>`（繰り返しまたはカンマ区切りのプロファイルID）
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>`（設定されたエージェントID。`OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`をオーバーライド）

## エイリアス＋フォールバック

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## 認証プロファイル

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login`はプロバイダープラグインの認証フロー（OAuth/APIキー）を実行します。インストールされているプロバイダーを確認するには`openclaw plugins list`を使用してください。

例:

```bash
openclaw models auth login --provider anthropic --method cli --set-default
openclaw models auth login --provider openai-codex --set-default
```

注意事項:

- `login --provider anthropic --method cli --set-default`はローカルのClaude CLIログインを再利用し、メインのAnthropicデフォルトモデルパスを`claude-cli/...`に書き換えます。
- `setup-token`はセットアップトークン値の入力を求めます（任意のマシンで`claude setup-token`で生成できます）。
- `paste-token`は他の場所または自動化から生成されたトークン文字列を受け付けます。
- Anthropicポリシーに関する注意: セットアップトークンのサポートは技術的な互換性です。AnthropicはClaude Code以外での一部のサブスクリプション使用を過去にブロックしたことがあるため、広く使用する前に現在の利用規約を確認してください。
