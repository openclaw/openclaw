---
read_when:
    - macアプリとGateway ゲートウェイのライフサイクルを統合する場合
summary: macOSにおけるGateway ゲートウェイのライフサイクル（launchd）
title: Gateway ゲートウェイライフサイクル
x-i18n:
    generated_at: "2026-04-02T07:47:43Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 73e7eb64ef432c3bfc81b949a5cc2a344c64f2310b794228609aae1da817ec41
    source_path: platforms/mac/child-process.md
    workflow: 15
---

# macOSにおけるGateway ゲートウェイのライフサイクル

macOSアプリはデフォルトで**launchdを介してGateway ゲートウェイを管理**し、Gateway ゲートウェイを子プロセスとしてスポーンしません。まず設定されたポートで既に実行中のGateway ゲートウェイへの接続を試み、到達できない場合は外部の `openclaw` CLIを介してlaunchdサービスを有効にします（組み込みランタイムなし）。これにより、ログイン時の信頼性の高い自動起動とクラッシュ時の再起動が実現されます。

子プロセスモード（アプリから直接スポーンされるGateway ゲートウェイ）は現在**使用されていません**。UIとのより密接な結合が必要な場合は、ターミナルでGateway ゲートウェイを手動で実行してください。

## デフォルトの動作（launchd）

- アプリは `ai.openclaw.gateway` というラベルのユーザーごとのLaunchAgentをインストールします
  （`--profile`/`OPENCLAW_PROFILE` 使用時は `ai.openclaw.<profile>`。レガシーの `com.openclaw.*` もサポートされています）。
- ローカルモードが有効な場合、アプリはLaunchAgentがロードされていることを確認し、
  必要に応じてGateway ゲートウェイを起動します。
- ログはlaunchdのGateway ゲートウェイログパスに書き込まれます（デバッグ設定で確認可能）。

一般的なコマンド:

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
launchctl bootout gui/$UID/ai.openclaw.gateway
```

名前付きプロファイルを使用する場合は、ラベルを `ai.openclaw.<profile>` に置き換えてください。

## 未署名の開発ビルド

`scripts/restart-mac.sh --no-sign` は署名キーがない場合の高速なローカルビルド用です。launchdが未署名のリレーバイナリを指すのを防ぐため、以下を行います:

- `~/.openclaw/disable-launchagent` を書き込みます。

署名済みの `scripts/restart-mac.sh` の実行では、このマーカーが存在する場合にオーバーライドをクリアします。手動でリセットするには:

```bash
rm ~/.openclaw/disable-launchagent
```

## アタッチ専用モード

macOSアプリに**launchdのインストールや管理を一切行わせない**ようにするには、`--attach-only`（または `--no-launchd`）を付けて起動してください。これにより `~/.openclaw/disable-launchagent` が設定され、アプリは既に実行中のGateway ゲートウェイにのみ接続します。デバッグ設定でも同じ動作を切り替えることができます。

## リモートモード

リモートモードではローカルのGateway ゲートウェイを起動しません。アプリはリモートホストへのSSHトンネルを使用し、そのトンネルを介して接続します。

## launchdを推奨する理由

- ログイン時の自動起動。
- 組み込みの再起動/KeepAliveセマンティクス。
- 予測可能なログと監視。

真の子プロセスモードが再び必要になった場合は、独立した明示的な開発専用モードとしてドキュメント化すべきです。
