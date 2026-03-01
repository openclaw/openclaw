---
summary: "Nixを使用したOpenClawの宣言的インストール"
read_when:
  - 再現可能でロールバック可能なインストールが必要な場合
  - すでにNix/NixOS/Home Managerを使用している場合
  - すべてをピン留めして宣言的に管理したい場合
title: "Nix"
---

# Nixインストール

NixでOpenClawを実行する推奨方法は、**[nix-openclaw](https://github.com/openclaw/nix-openclaw)**を使用することです。これはバッテリー同梱のHome Managerモジュールです。

## クイックスタート

AIエージェント（Claude、Cursorなど）に以下を貼り付けてください：

```text
I want to set up nix-openclaw on my Mac.
Repository: github:openclaw/nix-openclaw

What I need you to do:
1. Check if Determinate Nix is installed (if not, install it)
2. Create a local flake at ~/code/openclaw-local using templates/agent-first/flake.nix
3. Help me create a Telegram bot (@BotFather) and get my chat ID (@userinfobot)
4. Set up secrets (bot token, Anthropic key) - plain files at ~/.secrets/ is fine
5. Fill in the template placeholders and run home-manager switch
6. Verify: launchd running, bot responds to messages

Reference the nix-openclaw README for module options.
```

> **完全ガイド：[github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> nix-openclawリポジトリがNixインストールの正本です。このページはクイック概要にすぎません。

## 得られるもの

- Gateway + macOSアプリ + ツール（whisper、spotify、camerasなど）すべてピン留め
- 再起動後も維持されるlaunchdサービス
- 宣言的設定によるプラグインシステム
- 即時ロールバック：`home-manager switch --rollback`

---

## NixモードのランタイムDEFAULT動作

`OPENCLAW_NIX_MODE=1`が設定されている場合（nix-openclawでは自動）：

OpenClawは設定を決定論的にし、自動インストールフローを無効にする**Nixモード**をサポートしています。
以下をエクスポートして有効にします：

```bash
OPENCLAW_NIX_MODE=1
```

macOSでは、GUIアプリはシェル環境変数を自動的に継承しません。defaultsを使ってNixモードを有効にすることもできます：

```bash
defaults write ai.openclaw.mac openclaw.nixMode -bool true
```

### 設定 + 状態パス

OpenClawは`OPENCLAW_CONFIG_PATH`からJSON5設定を読み取り、可変データを`OPENCLAW_STATE_DIR`に保存します。
必要に応じて、`OPENCLAW_HOME`を設定して内部パス解決に使用されるベースホームディレクトリを制御することもできます。

- `OPENCLAW_HOME`（デフォルトの優先順位：`HOME` / `USERPROFILE` / `os.homedir()`）
- `OPENCLAW_STATE_DIR`（デフォルト：`~/.openclaw`）
- `OPENCLAW_CONFIG_PATH`（デフォルト：`$OPENCLAW_STATE_DIR/openclaw.json`）

Nix環境で実行する場合、ランタイムの状態と設定がイミュータブルストアの外に保持されるように、これらをNix管理の場所に明示的に設定してください。

### Nixモードのランタイム動作

- 自動インストールおよび自己変更フローが無効化されます
- 不足している依存関係にはNix固有の修復メッセージが表示されます
- UIにはNixモードが存在する場合、読み取り専用のNixモードバナーが表示されます

## パッケージングに関する注意（macOS）

macOSのパッケージングフローでは、以下の場所に安定したInfo.plistテンプレートが必要です：

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)はこのテンプレートをアプリバンドルにコピーし、動的フィールド（バンドルID、バージョン/ビルド、Git SHA、Sparkleキー）にパッチを当てます。これによりplistはSwiftPMパッケージングおよびNixビルド（完全なXcodeツールチェーンに依存しない）に対して決定論的になります。

## 関連情報

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — 完全セットアップガイド
- [ウィザード](/start/wizard) — 非NixのCLIセットアップ
- [Docker](/install/docker) — コンテナ化セットアップ
