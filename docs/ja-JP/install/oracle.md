---
read_when:
    - Oracle CloudにOpenClawをセットアップする場合
    - OpenClaw向けの無料VPSホスティングを探している場合
    - 小規模サーバーでOpenClawを24時間稼働させたい場合
summary: Oracle CloudのAlways Free ARMティアでOpenClawをホストする
title: Oracle Cloud
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 5a34d980b011a6e9b562fa78d3331ce80403e0007541221a03fd7fa9acdc2dc1
    source_path: install/oracle.md
    workflow: 15
---

# Oracle Cloud

Oracle CloudのAlways Free ARMティア（最大4 OCPU、24 GB RAM、200 GBストレージ）で、無料で永続的なOpenClaw Gateway ゲートウェイを実行します。

## 前提条件

- Oracle Cloudアカウント（[サインアップ](https://www.oracle.com/cloud/free/)）-- 問題が発生した場合は[コミュニティサインアップガイド](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)を参照
- Tailscaleアカウント（[tailscale.com](https://tailscale.com)で無料）
- SSHキーペア
- 約30分

## セットアップ

<Steps>
  <Step title="OCIインスタンスを作成">
    1. [Oracle Cloud Console](https://cloud.oracle.com/)にログイン。
    2. **コンピュート > インスタンス > インスタンスの作成**に移動。
    3. 設定：
       - **名前:** `openclaw`
       - **イメージ:** Ubuntu 24.04（aarch64）
       - **シェイプ:** `VM.Standard.A1.Flex`（Ampere ARM）
       - **OCPU:** 2（最大4）
       - **メモリ:** 12 GB（最大24 GB）
       - **ブートボリューム:** 50 GB（最大200 GB無料）
       - **SSHキー:** 公開キーを追加
    4. **作成**をクリックし、パブリックIPアドレスをメモ。

    <Tip>
    「容量不足」でインスタンス作成が失敗した場合は、別の可用性ドメインを試すか、後で再試行してください。Free Tierの容量は限られています。
    </Tip>

  </Step>

  <Step title="接続してシステムを更新">
    ```bash
    ssh ubuntu@YOUR_PUBLIC_IP

    sudo apt update && sudo apt upgrade -y
    sudo apt install -y build-essential
    ```

    `build-essential`は一部の依存関係のARMコンパイルに必要です。

  </Step>

  <Step title="ユーザーとホスト名を設定">
    ```bash
    sudo hostnamectl set-hostname openclaw
    sudo passwd ubuntu
    sudo loginctl enable-linger ubuntu
    ```

    lingerを有効にすることで、ログアウト後もユーザーサービスが実行され続けます。

  </Step>

  <Step title="Tailscaleをインストール">
    ```bash
    curl -fsSL https://tailscale.com/install.sh | sh
    sudo tailscale up --ssh --hostname=openclaw
    ```

    以後はTailscale経由で接続: `ssh ubuntu@openclaw`

  </Step>

  <Step title="OpenClawをインストール">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    source ~/.bashrc
    ```

    「ボットをどのように起動しますか？」と聞かれたら**後で行う**を選択してください。

  </Step>

  <Step title="Gateway ゲートウェイを設定">
    Tailscale Serveによるトークン認証を使用してセキュアなリモートアクセスを設定。

    ```bash
    openclaw config set gateway.bind loopback
    openclaw config set gateway.auth.mode token
    openclaw doctor --generate-gateway-token
    openclaw config set gateway.tailscale.mode serve
    openclaw config set gateway.trustedProxies '["127.0.0.1"]'

    systemctl --user restart openclaw-gateway
    ```

    `gateway.trustedProxies=["127.0.0.1"]`はローカルのTailscale Serveプロキシ用です。この設定ではdiffビューアールートはfail-closedで動作します: プロキシヘッダーなしの生の`127.0.0.1`ビューアーリクエストは`Diff not found`を返す場合があります。添付ファイルには`mode=file` / `mode=both`を使用するか、リモートビューアーを意図的に有効にして`plugins.entries.diffs.config.viewerBaseUrl`（またはプロキシ`baseUrl`）を設定してください。

  </Step>

  <Step title="VCNセキュリティをロックダウン">
    ネットワークエッジでTailscale以外のすべてのトラフィックをブロック：

    1. OCIコンソールで**ネットワーキング > 仮想クラウドネットワーク**に移動。
    2. VCNをクリックし、**セキュリティリスト > デフォルトセキュリティリスト**。
    3. `0.0.0.0/0 UDP 41641`（Tailscale）以外のすべてのイングレスルールを**削除**。
    4. デフォルトのエグレスルール（すべてのアウトバウンドを許可）は保持。

    これにより、ポート22のSSH、HTTP、HTTPS、その他すべてがネットワークエッジでブロックされます。以後はTailscale経由でのみ接続できます。

  </Step>

  <Step title="確認">
    ```bash
    openclaw --version
    systemctl --user status openclaw-gateway
    tailscale serve status
    curl http://localhost:18789
    ```

    tailnet上の任意のデバイスからControl UIにアクセス：

    ```
    https://openclaw.<tailnet-name>.ts.net/
    ```

    `<tailnet-name>`をtailnet名に置き換えてください（`tailscale status`で確認できます）。

  </Step>
</Steps>

## フォールバック: SSHトンネル

Tailscale Serveが動作しない場合は、ローカルマシンからSSHトンネルを使用：

```bash
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

その後`http://localhost:18789`を開いてください。

## トラブルシューティング

**インスタンス作成が失敗する（「容量不足」）** -- Free Tier ARMインスタンスは人気があります。別の可用性ドメインを試すか、ピーク時間外に再試行してください。

**Tailscaleが接続しない** -- `sudo tailscale up --ssh --hostname=openclaw --reset`で再認証してください。

**Gateway ゲートウェイが起動しない** -- `openclaw doctor --non-interactive`を実行し、`journalctl --user -u openclaw-gateway -n 50`でログを確認してください。

**ARMバイナリの問題** -- ほとんどのnpmパッケージはARM64で動作します。ネイティブバイナリの場合は`linux-arm64`または`aarch64`リリースを探してください。`uname -m`でアーキテクチャを確認してください。

## 次のステップ

- [チャネル](/channels) -- Telegram、WhatsApp、Discordなどに接続
- [Gateway ゲートウェイ設定](/gateway/configuration) -- すべての設定オプション
- [アップデート](/install/updating) -- OpenClawを最新に保つ
