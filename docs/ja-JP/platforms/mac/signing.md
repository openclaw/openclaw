---
summary: "パッケージングスクリプトで生成されるmacOSデバッグビルドの署名手順"
read_when:
  - macデバッグビルドのビルドまたは署名
title: "macOS署名"
---

# Mac署名（デバッグビルド）

このアプリは通常[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)からビルドされます。このスクリプトは以下を行います：

- 安定したデバッグバンドル識別子を設定します：`ai.openclaw.mac.debug`
- そのバンドルIDでInfo.plistを書き込みます（`BUNDLE_ID=...`でオーバーライド可能）
- [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh)を呼び出してメインバイナリとアプリバンドルに署名し、macOSが各リビルドを同じ署名済みバンドルとして扱い、TCCパーミッション（通知、アクセシビリティ、画面収録、マイク、音声認識）を保持するようにします。安定したパーミッションのためには実際の署名IDを使用してください。アドホックはオプトインであり脆弱です（[macOSパーミッション](/platforms/mac/permissions)を参照）。
- デフォルトで`CODESIGN_TIMESTAMP=auto`を使用します。Developer ID署名に信頼できるタイムスタンプを有効にします。タイムスタンプをスキップするには`CODESIGN_TIMESTAMP=off`を設定してください（オフラインデバッグビルド）。
- ビルドメタデータをInfo.plistに注入します：`OpenClawBuildTimestamp`（UTC）と`OpenClawGitCommit`（短いハッシュ）。Aboutペインでビルド、git、デバッグ/リリースチャンネルを表示できます。
- **パッケージングにはNode 22+が必要です**：スクリプトはTSビルドとControl UIビルドを実行します。
- 環境から`SIGN_IDENTITY`を読み取ります。常に証明書で署名するには、シェルrcに`export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"`（またはDeveloper ID Application証明書）を追加してください。アドホック署名には`ALLOW_ADHOC_SIGNING=1`または`SIGN_IDENTITY="-"`による明示的なオプトインが必要です（パーミッションテストには推奨されません）。
- 署名後にTeam ID監査を実行し、アプリバンドル内のMach-Oが異なるTeam IDで署名されている場合は失敗します。バイパスするには`SKIP_TEAM_ID_CHECK=1`を設定してください。

## 使用方法

```bash
# リポジトリルートから
scripts/package-mac-app.sh               # IDを自動選択、見つからない場合はエラー
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # 実際の証明書
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # アドホック（パーミッションは保持されません）
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # 明示的なアドホック（同じ注意事項）
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # 開発専用のSparkle Team ID不一致回避策
```

### アドホック署名に関する注意

`SIGN_IDENTITY="-"`（アドホック）で署名する場合、スクリプトは自動的に**Hardened Runtime**（`--options runtime`）を無効化します。これは、アプリが同じTeam IDを共有しない埋め込みフレームワーク（Sparkleなど）をロードしようとした際のクラッシュを防ぐために必要です。アドホック署名はTCCパーミッションの永続性も破壊します。復旧手順については[macOSパーミッション](/platforms/mac/permissions)を参照してください。

## Aboutのビルドメタデータ

`package-mac-app.sh`はバンドルに以下をスタンプします：

- `OpenClawBuildTimestamp`：パッケージング時のISO8601 UTC
- `OpenClawGitCommit`：短いgitハッシュ（利用不可の場合は`unknown`）

Aboutタブはこれらのキーを読み取り、バージョン、ビルド日、gitコミット、デバッグビルドかどうか（`#if DEBUG`経由）を表示します。コード変更後にこれらの値を更新するにはパッケージャーを実行してください。

## 理由

TCCパーミッションはバンドル識別子_と_コード署名に紐付けられています。変化するUUIDを持つ未署名のデバッグビルドは、各リビルド後にmacOSに付与を忘れさせていました。バイナリに署名し（デフォルトでアドホック）、固定のバンドルID/パス（`dist/OpenClaw.app`）を維持することで、VibeTunnelアプローチと同様にビルド間で付与が保持されます。
