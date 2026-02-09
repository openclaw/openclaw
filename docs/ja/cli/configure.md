---
summary: "対話型の設定プロンプトを使用する `openclaw configure` の CLI リファレンス"
read_when:
  - 資格情報、デバイス、またはエージェントの既定値を対話的に調整したい場合
title: "configure"
---

# `openclaw configure`

資格情報、デバイス、エージェントの既定値を設定するための対話型プロンプトです。

注記: **Model** セクションには、`agents.defaults.models` の許可リスト（`/model` およびモデルピッカーに表示される内容）のマルチセレクトが含まれるようになりました。

ヒント: サブコマンドを付けずに `openclaw config` を実行すると、同じウィザードが開きます。非対話的な編集には `openclaw config get|set|unset` を使用してください。 非対話的な編集には、
`openclaw config get|set|unset` を使用します。

関連:

- Gateway の設定リファレンス: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

注記:

- Gateway をどこで実行するかを選択すると、常に `gateway.mode` が更新されます。それだけが必要な場合は、他のセクションを選択せずに「Continue」を選択できます。 必要に応じて、他のセクションなしで「続ける」を選択できます。
- チャンネル指向のサービス（Slack/Discord/Matrix/Microsoft Teams）では、セットアップ中にチャンネル／ルームの許可リストの入力が求められます。名前または ID を入力できます。可能な場合、ウィザードが名前を ID に解決します。 名前または ID を入力できます。可能な場合、ウィザードは ID に名前を解決します。

## 例

```bash
openclaw configure
openclaw configure --section models --section channels
```
