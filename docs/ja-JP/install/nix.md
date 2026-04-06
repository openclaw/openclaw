---
read_when:
    - 再現可能でロールバック可能なインストールが必要な場合
    - すでにNix/NixOS/Home Managerを使用している場合
    - すべてを固定して宣言的に管理したい場合
summary: NixでOpenClawを宣言的にインストールする
title: Nix
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 14e1e73533db1350d82d3a786092b4328121a082dfeeedee7c7574021dada546
    source_path: install/nix.md
    workflow: 15
---

# Nixインストール

**[nix-openclaw](https://github.com/openclaw/nix-openclaw)** を使用してOpenClawを宣言的にインストールします。これはバッテリー込みのHome Managerモジュールです。

<Info>
[nix-openclaw](https://github.com/openclaw/nix-openclaw) リポジトリがNixインストールの信頼できる情報源です。このページはクイック概要です。
</Info>

## 得られるもの

- Gateway ゲートウェイ + macOSアプリ + ツール（whisper、spotify、カメラ）-- すべて固定
- 再起動後も持続するlaunchdサービス
- 宣言的な設定によるプラグインシステム
- 即座のロールバック: `home-manager switch --rollback`

## クイックスタート

<Steps>
  <Step title="Determinate Nixをインストール">
    Nixがまだインストールされていない場合は、[Determinate Nixインストーラー](https://github.com/DeterminateSystems/nix-installer)の手順に従ってください。
  </Step>
  <Step title="ローカルフレークを作成">
    nix-openclawリポジトリのエージェントファーストテンプレートを使用：
    ```bash
    mkdir -p ~/code/openclaw-local
    # nix-openclawリポジトリからtemplates/agent-first/flake.nixをコピー
    ```
  </Step>
  <Step title="シークレットを設定">
    メッセージングボットトークンとモデルプロバイダーのAPIキーを設定します。`~/.secrets/`のプレーンファイルで問題ありません。
  </Step>
  <Step title="テンプレートのプレースホルダーを入力してスイッチ">
    ```bash
    home-manager switch
    ```
  </Step>
  <Step title="確認">
    launchdサービスが実行中で、ボットがメッセージに応答することを確認します。
  </Step>
</Steps>

完全なモジュールオプションと例については[nix-openclaw README](https://github.com/openclaw/nix-openclaw)を参照してください。

## Nixモードのランタイム動作

`OPENCLAW_NIX_MODE=1`が設定されている場合（nix-openclawで自動設定）、OpenClawは自動インストールフローを無効化する決定論的モードに入ります。

手動で設定することもできます：

```bash
export OPENCLAW_NIX_MODE=1
```

macOSでは、GUIアプリはシェルの環境変数を自動的に継承しません。代わりにdefaultsでNixモードを有効化してください：

```bash
defaults write ai.openclaw.mac openclaw.nixMode -bool true
```

### Nixモードで変わること

- 自動インストールと自己変更フローが無効化
- 不足している依存関係はNix固有の修復メッセージを表示
- UIにはNixモードの読み取り専用バナーが表示

### 設定と状態のパス

OpenClawは`OPENCLAW_CONFIG_PATH`からJSON5設定を読み込み、`OPENCLAW_STATE_DIR`に変更可能なデータを保存します。Nixの下で実行する場合、ランタイムの状態と設定が不変ストアの外に留まるよう、これらをNix管理の場所に明示的に設定してください。

| 変数                   | デフォルト                                  |
| ---------------------- | ------------------------------------------- |
| `OPENCLAW_HOME`        | `HOME` / `USERPROFILE` / `os.homedir()`     |
| `OPENCLAW_STATE_DIR`   | `~/.openclaw`                               |
| `OPENCLAW_CONFIG_PATH` | `$OPENCLAW_STATE_DIR/openclaw.json`         |

## 関連

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) -- 完全なセットアップガイド
- [ウィザード](/start/wizard) -- Nix以外のCLIセットアップ
- [Docker](/install/docker) -- コンテナ化されたセットアップ
