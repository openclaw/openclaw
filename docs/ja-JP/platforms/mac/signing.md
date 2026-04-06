---
read_when:
    - macデバッグビルドのビルドまたは署名
summary: パッケージングスクリプトで生成されたmacOSデバッグビルドの署名手順
title: macOS署名
x-i18n:
    generated_at: "2026-04-02T07:48:23Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 7b16d726549cf6dc34dc9c60e14d8041426ebc0699ab59628aca1d094380334a
    source_path: platforms/mac/signing.md
    workflow: 15
---

# mac署名（デバッグビルド）

このアプリは通常 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) からビルドされます。このスクリプトは現在以下を行います:

- 安定したデバッグバンドル識別子を設定: `ai.openclaw.mac.debug`
- そのバンドルIDでInfo.plistを書き込み（`BUNDLE_ID=...` でオーバーライド可能）
- [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) を呼び出して、メインバイナリとアプリバンドルに署名し、macOSが各リビルドを同じ署名済みバンドルとして扱い、TCC権限（通知、アクセシビリティ、画面収録、マイク、音声認識）を維持するようにします。安定した権限のためには、実際の署名IDを使用してください。アドホック署名はオプトインであり、不安定です（[macOS権限](/platforms/mac/permissions) を参照）。
- デフォルトで `CODESIGN_TIMESTAMP=auto` を使用します。Developer ID署名に対して信頼されたタイムスタンプを有効にします。タイムスタンプをスキップするには `CODESIGN_TIMESTAMP=off` を設定してください（オフラインデバッグビルド用）。
- ビルドメタデータをInfo.plistに注入: `OpenClawBuildTimestamp`（UTC）と `OpenClawGitCommit`（短縮ハッシュ）。これによりAboutペインでビルド、git、デバッグ/リリースチャネルを表示できます。
- **パッケージングはデフォルトでNode 24を使用**: スクリプトはTSビルドとControl UIビルドを実行します。Node 22 LTS（現在 `22.14+`）も互換性のためサポートされています。
- 環境から `SIGN_IDENTITY` を読み取ります。常に証明書で署名するには、シェルrcに `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"`（またはDeveloper ID Application証明書）を追加してください。アドホック署名には `ALLOW_ADHOC_SIGNING=1` または `SIGN_IDENTITY="-"` による明示的なオプトインが必要です（権限テストには推奨しません）。
- 署名後にTeam ID監査を実行し、アプリバンドル内のMach-Oが異なるTeam IDで署名されている場合は失敗します。バイパスするには `SKIP_TEAM_ID_CHECK=1` を設定してください。

## 使用方法

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### アドホック署名に関する注意

`SIGN_IDENTITY="-"`（アドホック）で署名する場合、スクリプトは自動的に**Hardened Runtime**（`--options runtime`）を無効にします。これは、アプリが同じTeam IDを共有しない埋め込みフレームワーク（Sparkleなど）を読み込もうとした際のクラッシュを防ぐために必要です。アドホック署名はTCC権限の永続化も壊します。復旧手順については [macOS権限](/platforms/mac/permissions) を参照してください。

## Aboutのビルドメタデータ

`package-mac-app.sh` はバンドルに以下をスタンプします:

- `OpenClawBuildTimestamp`: パッケージ時のISO8601 UTC
- `OpenClawGitCommit`: 短縮gitハッシュ（利用不可の場合は `unknown`）

Aboutタブはこれらのキーを読み取り、バージョン、ビルド日時、gitコミット、デバッグビルドかどうか（`#if DEBUG` 経由）を表示します。コード変更後にこれらの値を更新するにはパッケージャーを再実行してください。

## 理由

TCC権限はバンドル識別子_および_コード署名に紐づいています。UUIDが変更される未署名のデバッグビルドでは、リビルドのたびにmacOSが付与を忘れてしまいます。バイナリに署名し（デフォルトでアドホック）、固定のバンドルID/パス（`dist/OpenClaw.app`）を維持することで、VibeTunnelアプローチと同様に、ビルド間で付与が保持されます。
