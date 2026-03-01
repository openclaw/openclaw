---
summary: "Elevatedモードと/elevatedディレクティブ"
read_when:
  - elevatedモードのデフォルト、許可リスト、またはスラッシュコマンドの動作を調整する場合
title: "Elevatedモード"
---

# Elevatedモード（/elevatedディレクティブ）

## 機能

- `/elevated on` はGatewayホストで実行し、exec承認を維持します（`/elevated ask` と同じ）。
- `/elevated full` はGatewayホストで実行し、**かつ** execを自動承認します（exec承認をスキップ）。
- `/elevated ask` はGatewayホストで実行しますが、exec承認を維持します（`/elevated on` と同じ）。
- `on`/`ask` は `exec.security=full` を強制しません。設定済みのセキュリティ/askポリシーが引き続き適用されます。
- エージェントが**サンドボックス化**されている場合のみ動作を変更します（それ以外の場合、execはすでにホストで実行されています）。
- ディレクティブ形式: `/elevated on|off|ask|full`、`/elev on|off|ask|full`。
- `on|off|ask|full` のみが受け付けられます。それ以外はヒントを返し、状態を変更しません。

## コントロールするもの（しないもの）

- **利用可能性ゲート**: `tools.elevated` はグローバルベースラインです。`agents.list[].tools.elevated` でエージェントごとにelevatedをさらに制限できます（両方が許可する必要があります）。
- **セッションごとの状態**: `/elevated on|off|ask|full` で現在のセッションキーのelevatedレベルを設定します。
- **インラインディレクティブ**: メッセージ内の `/elevated on|ask|full` はそのメッセージのみに適用されます。
- **グループ**: グループチャットでは、エージェントがメンションされた場合にのみelevatedディレクティブが有効になります。メンション要件をバイパスするコマンドのみのメッセージはメンションされたものとして扱われます。
- **ホスト実行**: elevatedはexecをGatewayホストに強制します。`full` は `security=full` も設定します。
- **承認**: `full` はexec承認をスキップします。`on`/`ask` は許可リスト/askルールが要求する場合に承認を有効にします。
- **サンドボックス化されていないエージェント**: 場所については無操作です。ゲーティング、ログ、ステータスのみに影響します。
- **ツールポリシーは引き続き適用されます**: ツールポリシーによって `exec` が拒否されている場合、elevatedは使用できません。
- **`/exec` とは別**: `/exec` は認証済み送信者のセッションごとのデフォルトを調整し、elevatedを必要としません。

## 解決順序

1. メッセージのインラインディレクティブ（そのメッセージのみに適用）。
2. セッションオーバーライド（ディレクティブのみのメッセージを送信することで設定）。
3. グローバルデフォルト（コンフィグの `agents.defaults.elevatedDefault`）。

## セッションデフォルトの設定

- ディレクティブ**のみ**のメッセージを送信します（空白可）。例: `/elevated full`。
- 確認返信が送信されます（`Elevated mode set to full...` / `Elevated mode disabled.`）。
- elevatedアクセスが無効または送信者が承認済み許可リストにない場合、ディレクティブはアクション可能なエラーで返信し、セッション状態を変更しません。
- `/elevated`（または `/elevated:`）を引数なしで送信すると、現在のelevatedレベルを確認できます。

## 利用可能性と許可リスト

- 機能ゲート: `tools.elevated.enabled`（コードがサポートしていても、コンフィグでデフォルトをオフにできます）。
- 送信者許可リスト: `tools.elevated.allowFrom` とプロバイダーごとの許可リスト（例: `discord`、`whatsapp`）。
- プレフィックスなしの許可リストエントリは送信者スコープのアイデンティティ値のみに一致します（`SenderId`、`SenderE164`、`From`）。受信者ルーティングフィールドはelevated認可には使用されません。
- 変更可能な送信者メタデータには明示的なプレフィックスが必要です:
  - `name:<value>` は `SenderName` に一致
  - `username:<value>` は `SenderUsername` に一致
  - `tag:<value>` は `SenderTag` に一致
  - `id:<value>`、`from:<value>`、`e164:<value>` は明示的なアイデンティティターゲティングに使用可能
- エージェントごとのゲート: `agents.list[].tools.elevated.enabled`（オプション。さらに制限するのみ）。
- エージェントごとの許可リスト: `agents.list[].tools.elevated.allowFrom`（オプション。設定されている場合、送信者はグローバルとエージェントごとの許可リスト**両方**に一致する必要があります）。
- Discordフォールバック: `tools.elevated.allowFrom.discord` が省略されている場合、`channels.discord.allowFrom` リストがフォールバックとして使用されます（レガシー: `channels.discord.dm.allowFrom`）。オーバーライドするには `tools.elevated.allowFrom.discord`（`[]` でも可）を設定してください。エージェントごとの許可リストはフォールバックを使用しません。
- すべてのゲートが通過する必要があります。そうでない場合、elevatedは利用不可として扱われます。

## ログとステータス

- Elevated execの呼び出しはinfoレベルでログに記録されます。
- セッションステータスにはelevatedモードが含まれます（例: `elevated=ask`、`elevated=full`）。
