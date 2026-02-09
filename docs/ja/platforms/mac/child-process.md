---
summary: "macOS（launchd）における Gateway（ゲートウェイ）のライフサイクル"
read_when:
  - Gateway（ゲートウェイ）のライフサイクルに mac アプリを統合する場合
title: "Gateway（ゲートウェイ）のライフサイクル"
---

# macOS における Gateway（ゲートウェイ）のライフサイクル

子プロセスモード（アプリが直接 Gateway（ゲートウェイ）を起動する方式）は、現在 **使用されていません**。UI とのより密な連携が必要な場合は、ターミナルで Gateway（ゲートウェイ）を手動起動してください。 38. まず設定されたポートで既に実行中の Gateway への接続を試みます。到達可能なものがない場合は、外部の `openclaw` CLI を介して launchd サービスを有効化します（組み込みランタイムはありません）。 39. これにより、ログイン時の確実な自動起動と、クラッシュ時の再起動が実現します。

チャイルドプロセス モード (ゲートウェイはアプリから直接生成されます) は今日は **使用されていません** 。
UI へのより強いカップリングが必要な場合は、ターミナルで Gateway を手動で実行します。

## 既定の動作（launchd）

- アプリは、ユーザーごとの LaunchAgent（ラベルは `bot.molt.gateway`。`--profile`/`OPENCLAW_PROFILE` を使用する場合は `bot.molt.<profile>`。レガシーの `com.openclaw.*` もサポート）をインストールします。
- ローカルモードが有効な場合、アプリは LaunchAgent がロードされていることを確認し、必要に応じて Gateway（ゲートウェイ）を起動します。
- ログは launchd の Gateway（ゲートウェイ）ログパスに書き込まれます（Debug Settings で確認できます）。

一般的なコマンド:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

名前付きプロファイルを実行する場合は、ラベルを `bot.molt.<profile>` に置き換えてください。

## 署名なしの開発ビルド

`scripts/restart-mac.sh --no-sign` は、署名キーがない場合の高速なローカルビルド向けです。launchd が署名されていないリレーのバイナリを指さないようにするため、次を行います。 unsigned 中継バイナリを指して起動を防ぐには、次の手順を実行します。

- `~/.openclaw/disable-launchagent` を書き込みます。

`scripts/restart-mac.sh` の署名付き実行では、マーカーが存在する場合にこの上書きを解除します。手動でリセットするには、次を実行してください。 手動でリセットするには:

```bash
rm ~/.openclaw/disable-launchagent
```

## アタッチのみモード

macOS アプリに **launchd のインストールや管理を一切行わせない** ようにするには、`--attach-only`（または `--no-launchd`）を指定して起動します。これにより `~/.openclaw/disable-launchagent` が設定され、アプリは既に稼働中の Gateway（ゲートウェイ）にのみ接続します。同じ挙動は Debug Settings でも切り替え可能です。 40. これにより `~/.openclaw/disable-launchagent` が設定され、アプリは既に実行中の Gateway にのみ接続するようになります。 「デバッグ設定」で同じ
動作を切り替えることができます。

## リモートモード

リモートモードでは、ローカルの Gateway（ゲートウェイ）を起動しません。アプリはリモートホストへの SSH トンネルを使用し、そのトンネル越しに接続します。 アプリは
リモートホストにSSHトンネルを使用し、そのトンネルを介して接続します。

## launchd を推奨する理由

- ログイン時の自動起動。
- 組み込みの再起動／KeepAlive のセマンティクス。
- 予測可能なログと監督。

真の子プロセスモードが再び必要になった場合は、別個の、明示的な開発専用モードとして文書化されるべきです。
