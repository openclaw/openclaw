---
summary: "`openclaw configure` のCLIリファレンス（対話型設定プロンプト）"
read_when:
  - 資格情報、デバイス、またはエージェントのデフォルト設定を対話的に調整したい場合
title: "configure"
---

# `openclaw configure`

資格情報、デバイス、およびエージェントのデフォルト設定をセットアップするための対話型プロンプトです。

注意：**Model**セクションには、`agents.defaults.models` 許可リスト（`/model` やモデルピッカーに表示される内容）のマルチセレクトが含まれるようになりました。

ヒント：サブコマンドなしの `openclaw config` でも同じウィザードが開きます。非対話的な編集には `openclaw config get|set|unset` を使用してください。

関連：

- Gateway設定リファレンス：[Configuration](/gateway/configuration)
- Config CLI：[Config](/cli/config)

注意事項：

- Gatewayの実行場所を選択すると、常に `gateway.mode` が更新されます。それだけが必要な場合は、他のセクションなしで「Continue」を選択できます。
- チャネル指向のサービス（Slack/Discord/Matrix/Microsoft Teams）は、セットアップ中にチャネル/ルームの許可リストの入力を求めます。名前またはIDを入力でき、ウィザードは可能な場合に名前をIDに解決します。

## 使用例

```bash
openclaw configure
openclaw configure --section model --section channels
```
