---
read_when:
    - 認証情報、デバイス、またはエージェントのデフォルト設定を対話的に調整したい場合
summary: '`openclaw configure`（対話式設定プロンプト）のCLIリファレンス'
title: configure
x-i18n:
    generated_at: "2026-04-02T07:33:09Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: fcd913f07aaf91cc6ced5bc48b5153a5e28cdc84e120932dc822d8edf3e4c29a
    source_path: cli/configure.md
    workflow: 15
---

# `openclaw configure`

認証情報、デバイス、エージェントのデフォルト設定を行うための対話式プロンプトです。

注意: **モデル**セクションには、`agents.defaults.models` 許可リスト（`/model` やモデルピッカーに表示される内容）のマルチセレクトが含まれるようになりました。

ヒント: サブコマンドなしの `openclaw config` でも同じウィザードが開きます。非対話的な編集には `openclaw config get|set|unset` を使用してください。

Web検索については、`openclaw configure --section web` でプロバイダーを選択し、認証情報を設定できます。**Grok**を選択した場合、configureは同じ `XAI_API_KEY` で `x_search` を有効にし、`x_search` モデルを選択するための追加のフォローアップステップを表示することもできます。他のWeb検索プロバイダーではそのステップは表示されません。

関連:

- Gateway ゲートウェイ設定リファレンス: [設定](/gateway/configuration)
- Config CLI: [Config](/cli/config)

注意事項:

- Gateway ゲートウェイの実行場所を選択すると、常に `gateway.mode` が更新されます。それだけで十分な場合は、他のセクションを選択せずに「Continue」を選択できます。
- チャネル指向のサービス（Slack/Discord/Matrix/Microsoft Teams）では、セットアップ中にチャネル/ルームの許可リストの入力が求められます。名前またはIDを入力でき、ウィザードは可能な場合に名前をIDに解決します。
- デーモンのインストールステップを実行する場合、トークン認証にはトークンが必要であり、`gateway.auth.token` はSecretRef管理されています。configureはSecretRefを検証しますが、解決済みのプレーンテキストトークン値をスーパーバイザーサービスの環境メタデータに永続化しません。
- トークン認証にトークンが必要で、設定されたトークンのSecretRefが未解決の場合、configureは実行可能な修正ガイダンスを提示してデーモンのインストールをブロックします。
- `gateway.auth.token` と `gateway.auth.password` の両方が設定されており、`gateway.auth.mode` が未設定の場合、configureはモードが明示的に設定されるまでデーモンのインストールをブロックします。

## 使用例

```bash
openclaw configure
openclaw configure --section web
openclaw configure --section model --section channels
```
