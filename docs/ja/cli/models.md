---
summary: "「`openclaw models`」の CLI リファレンス（status/list/set/scan、エイリアス、フォールバック、認証）"
read_when:
  - 既定のモデルを変更する、またはプロバイダーの認証ステータスを確認したいとき
  - 利用可能なモデル／プロバイダーをスキャンし、認証プロファイルをデバッグしたいとき
title: "モデル"
x-i18n:
  source_path: cli/models.md
  source_hash: 923b6ffc7de382ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:16Z
---

# `openclaw models`

モデルの検出、スキャン、設定（既定モデル、フォールバック、認証プロファイル）。

関連:

- プロバイダー＋モデル: [モデル](/providers/models)
- プロバイダーの認証セットアップ: [はじめに](/start/getting-started)

## 共通コマンド

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` は、解決済みの既定／フォールバックと認証の概要を表示します。
プロバイダーの使用状況スナップショットが利用可能な場合、OAuth／トークンのステータス欄には
プロバイダーの使用状況ヘッダーが含まれます。
`--probe` を追加すると、設定済みの各プロバイダープロファイルに対してライブの認証プローブを実行します。
プローブは実際のリクエストであり（トークンを消費したり、レート制限を引き起こす可能性があります）。
`--agent <id>` を使用すると、設定済みエージェントのモデル／認証の状態を確認できます。省略した場合、
設定されていれば `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` を使用し、そうでなければ
設定済みの既定エージェントを使用します。

注記:

- `models set <model-or-alias>` は `provider/model` またはエイリアスを受け付けます。
- モデル参照は **最初の** `/` で分割して解析されます。モデル ID に `/`（OpenRouter 形式）が含まれる場合は、プロバイダープレフィックスを含めてください（例: `openrouter/moonshotai/kimi-k2`）。
- プロバイダーを省略した場合、OpenClaw は入力をエイリアス、または **既定プロバイダー** のモデルとして扱います（モデル ID に `/` が含まれない場合のみ機能します）。

### `models status`

オプション:

- `--json`
- `--plain`
- `--check`（終了コード 1=期限切れ／欠落、2=期限間近）
- `--probe`（設定済み認証プロファイルのライブプローブ）
- `--probe-provider <name>`（単一プロバイダーをプローブ）
- `--probe-profile <id>`（繰り返し、またはカンマ区切りのプロファイル ID）
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>`（設定済みエージェント ID。`OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` を上書き）

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

`models auth login` は、プロバイダープラグインの認証フロー（OAuth／API キー）を実行します。
`openclaw plugins list` を使用して、インストールされているプロバイダーを確認してください。

注記:

- `setup-token` は、セットアップトークンの値を入力するように求めます（任意のマシンで `claude setup-token` を使用して生成してください）。
- `paste-token` は、別の場所で生成された、または自動化から渡されたトークン文字列を受け付けます。
