---
summary: "`openclaw models` の CLI リファレンス（status/list/set/scan、エイリアス、フォールバック、認証）"
read_when:
  - デフォルトモデルの変更やプロバイダー認証ステータスの確認
  - 利用可能なモデル/プロバイダーのスキャンや認証プロファイルのデバッグ
title: "models"
---

# `openclaw models`

モデルの検出、スキャン、設定（デフォルトモデル、フォールバック、認証プロファイル）を行います。

関連:

- プロバイダー + モデル: [モデル](/providers/models)
- プロバイダー認証の設定: [はじめに](/start/getting-started)

## 一般的なコマンド

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` は、解決済みのデフォルト/フォールバックと認証の概要を表示します。
プロバイダー使用量のスナップショットが利用可能な場合、OAuth/トークンステータスのセクションに
プロバイダー使用量のヘッダーが含まれます。
`--probe` を追加すると、設定済みの各プロバイダープロファイルに対してライブ認証プローブを実行します。
プローブは実際のリクエストです（トークンを消費し、レート制限をトリガーする場合があります）。
`--agent <id>` を使用すると、設定済みエージェントのモデル/認証状態を確認できます。省略した場合、
`OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` が設定されていればそれを使用し、
それ以外の場合は設定済みのデフォルトエージェントを使用します。

注意事項:

- `models set <model-or-alias>` は `provider/model` またはエイリアスを受け付けます。
- モデル参照は**最初の** `/` で分割して解析されます。モデル ID に `/` が含まれる場合（OpenRouter 形式）、プロバイダープレフィックスを含めてください（例: `openrouter/moonshotai/kimi-k2`）。
- プロバイダーを省略した場合、OpenClaw はその入力をエイリアスまたは**デフォルトプロバイダー**のモデルとして扱います（モデル ID に `/` が含まれない場合のみ有効）。

### `models status`

オプション:

- `--json`
- `--plain`
- `--check`（終了コード 1=期限切れ/未設定、2=期限切れ間近）
- `--probe`（設定済み認証プロファイルのライブプローブ）
- `--probe-provider <name>`（1つのプロバイダーをプローブ）
- `--probe-profile <id>`（繰り返しまたはカンマ区切りのプロファイル ID）
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>`（設定済みエージェント ID。`OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` を上書きします）

## エイリアス + フォールバック

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

`models auth login` はプロバイダープラグインの認証フロー（OAuth/API キー）を実行します。
`openclaw plugins list` でインストール済みのプロバイダーを確認できます。

注意事項:

- `setup-token` はセットアップトークンの値を入力するよう求めます（任意のマシンで `claude setup-token` を使って生成できます）。
- `paste-token` は別の場所やオートメーションで生成されたトークン文字列を受け付けます。
