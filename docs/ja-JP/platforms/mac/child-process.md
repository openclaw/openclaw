---
summary: "macOSにおけるGatewayライフサイクル（launchd）"
read_when:
  - macアプリとGatewayライフサイクルの統合
title: "Gatewayライフサイクル"
---

# macOSにおけるGatewayライフサイクル

macOSアプリはデフォルトで**launchdを介してGatewayを管理**し、Gatewayを子プロセスとして起動しません。まず設定されたポートですでに実行中のGatewayへの接続を試み、到達できない場合は外部の`openclaw` CLI（組み込みランタイムなし）を介してlaunchdサービスを有効化します。これにより、ログイン時の自動起動とクラッシュ時の再起動が確実に行われます。

子プロセスモード（アプリが直接Gatewayを起動するモード）は現在**使用されていません**。UIとの密な連携が必要な場合は、ターミナルでGatewayを手動実行してください。

## デフォルトの動作（launchd）

- アプリは`ai.openclaw.gateway`というラベルのユーザーごとのLaunchAgentをインストールします
  （`--profile`/`OPENCLAW_PROFILE`使用時は`ai.openclaw.<profile>`、レガシーの`com.openclaw.*`もサポートされます）。
- ローカルモードが有効な場合、アプリはLaunchAgentがロードされていることを確認し、必要に応じてGatewayを起動します。
- ログはlaunchd Gatewayログパス（デバッグ設定で確認可能）に書き込まれます。

一般的なコマンド：

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
launchctl bootout gui/$UID/ai.openclaw.gateway
```

名前付きプロファイルを実行している場合は、ラベルを`ai.openclaw.<profile>`に置き換えてください。

## 未署名の開発ビルド

`scripts/restart-mac.sh --no-sign`は、署名キーがない場合の高速なローカルビルド用です。launchdが未署名のリレーバイナリを参照しないようにするため、以下を行います：

- `~/.openclaw/disable-launchagent`を書き込みます。

署名済みの`scripts/restart-mac.sh`の実行は、マーカーが存在する場合にこのオーバーライドをクリアします。手動でリセットするには：

```bash
rm ~/.openclaw/disable-launchagent
```

## アタッチオンリーモード

macOSアプリに**launchdのインストールや管理を一切行わせない**ようにするには、`--attach-only`（または`--no-launchd`）で起動します。これにより`~/.openclaw/disable-launchagent`が設定され、アプリはすでに実行中のGatewayにのみ接続します。同じ動作はデバッグ設定でも切り替えられます。

## リモートモード

リモートモードではローカルGatewayを起動しません。アプリはリモートホストへのSSHトンネルを使用し、そのトンネル経由で接続します。

## launchdを推奨する理由

- ログイン時の自動起動。
- ビルトインの再起動/KeepAliveセマンティクス。
- 予測可能なログと監視。

真の子プロセスモードが再び必要になった場合は、明示的な開発専用モードとして別途ドキュメント化する必要があります。
