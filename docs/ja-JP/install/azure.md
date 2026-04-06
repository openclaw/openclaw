---
read_when:
    - Network Security Group のハードニングを適用して Azure 上で OpenClaw を 24 時間 365 日稼働させたい場合
    - 自分の Azure Linux VM 上で本番グレードの常時稼働 OpenClaw Gateway ゲートウェイが欲しい場合
    - Azure Bastion SSH で安全な管理を行いたい場合
summary: Azure Linux VM 上で OpenClaw Gateway ゲートウェイを永続的な状態で 24 時間 365 日稼働させる
title: Azure
x-i18n:
    generated_at: "2026-04-02T07:44:59Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: dcdcf6dcf5096cd21e1b64f455656f7d77b477d03e9a088db74c6e988c3031db
    source_path: install/azure.md
    workflow: 15
---

# Azure Linux VM 上の OpenClaw

このガイドでは、Azure CLI を使用して Azure Linux VM をセットアップし、Network Security Group（NSG）のハードニングを適用し、SSH アクセス用に Azure Bastion を構成し、OpenClaw をインストールします。

## 実施する内容

- Azure CLI を使用して Azure ネットワーキング（VNet、サブネット、NSG）とコンピューティングリソースを作成する
- Network Security Group ルールを適用し、VM への SSH を Azure Bastion からのみ許可する
- Azure Bastion を使用して SSH アクセスを行う（VM にパブリック IP なし）
- インストーラースクリプトで OpenClaw をインストールする
- Gateway ゲートウェイを検証する

## 必要なもの

- コンピューティングおよびネットワークリソースを作成する権限を持つ Azure サブスクリプション
- Azure CLI がインストール済みであること（必要に応じて [Azure CLI のインストール手順](https://learn.microsoft.com/cli/azure/install-azure-cli) を参照）
- SSH キーペア（必要に応じて生成方法をこのガイドで説明します）
- 約 20〜30 分

## デプロイの設定

<Steps>
  <Step title="Azure CLI にサインイン">
    ```bash
    az login
    az extension add -n ssh
    ```

    `ssh` 拡張機能は Azure Bastion のネイティブ SSH トンネリングに必要です。

  </Step>

  <Step title="必要なリソースプロバイダーを登録（初回のみ）">
    ```bash
    az provider register --namespace Microsoft.Compute
    az provider register --namespace Microsoft.Network
    ```

    登録を確認します。両方が `Registered` と表示されるまで待ちます。

    ```bash
    az provider show --namespace Microsoft.Compute --query registrationState -o tsv
    az provider show --namespace Microsoft.Network --query registrationState -o tsv
    ```

  </Step>

  <Step title="デプロイ変数を設定">
    ```bash
    RG="rg-openclaw"
    LOCATION="westus2"
    VNET_NAME="vnet-openclaw"
    VNET_PREFIX="10.40.0.0/16"
    VM_SUBNET_NAME="snet-openclaw-vm"
    VM_SUBNET_PREFIX="10.40.2.0/24"
    BASTION_SUBNET_PREFIX="10.40.1.0/26"
    NSG_NAME="nsg-openclaw-vm"
    VM_NAME="vm-openclaw"
    ADMIN_USERNAME="openclaw"
    BASTION_NAME="bas-openclaw"
    BASTION_PIP_NAME="pip-openclaw-bastion"
    ```

    名前と CIDR 範囲は環境に合わせて調整してください。Bastion サブネットは少なくとも `/26` が必要です。

  </Step>

  <Step title="SSH キーを選択">
    既存の公開鍵がある場合はそれを使用します：

    ```bash
    SSH_PUB_KEY="$(cat ~/.ssh/id_ed25519.pub)"
    ```

    SSH キーがまだない場合は生成します：

    ```bash
    ssh-keygen -t ed25519 -a 100 -f ~/.ssh/id_ed25519 -C "you@example.com"
    SSH_PUB_KEY="$(cat ~/.ssh/id_ed25519.pub)"
    ```

  </Step>

  <Step title="VM サイズと OS ディスクサイズを選択">
    ```bash
    VM_SIZE="Standard_B2as_v2"
    OS_DISK_SIZE_GB=64
    ```

    サブスクリプションとリージョンで利用可能な VM サイズと OS ディスクサイズを選択してください：

    - 軽い使用量ではまず小さいサイズから始めて、後でスケールアップする
    - より重い自動化、より多くのチャネル、またはより大きなモデル/ツールワークロードには、より多くの vCPU/RAM/ディスクを使用する
    - リージョンまたはサブスクリプションのクォータで VM サイズが利用できない場合は、最も近い利用可能な SKU を選択する

    ターゲットリージョンで利用可能な VM サイズを一覧表示します：

    ```bash
    az vm list-skus --location "${LOCATION}" --resource-type virtualMachines -o table
    ```

    現在の vCPU とディスクの使用量/クォータを確認します：

    ```bash
    az vm list-usage --location "${LOCATION}" -o table
    ```

  </Step>
</Steps>

## Azure リソースのデプロイ

<Steps>
  <Step title="リソースグループを作成">
    ```bash
    az group create -n "${RG}" -l "${LOCATION}"
    ```
  </Step>

  <Step title="ネットワークセキュリティグループを作成">
    NSG を作成し、Bastion サブネットからのみ VM に SSH できるようにルールを追加します。

    ```bash
    az network nsg create \
      -g "${RG}" -n "${NSG_NAME}" -l "${LOCATION}"

    # Bastion サブネットからの SSH のみ許可
    az network nsg rule create \
      -g "${RG}" --nsg-name "${NSG_NAME}" \
      -n AllowSshFromBastionSubnet --priority 100 \
      --access Allow --direction Inbound --protocol Tcp \
      --source-address-prefixes "${BASTION_SUBNET_PREFIX}" \
      --destination-port-ranges 22

    # パブリックインターネットからの SSH を拒否
    az network nsg rule create \
      -g "${RG}" --nsg-name "${NSG_NAME}" \
      -n DenyInternetSsh --priority 110 \
      --access Deny --direction Inbound --protocol Tcp \
      --source-address-prefixes Internet \
      --destination-port-ranges 22

    # 他の VNet ソースからの SSH を拒否
    az network nsg rule create \
      -g "${RG}" --nsg-name "${NSG_NAME}" \
      -n DenyVnetSsh --priority 120 \
      --access Deny --direction Inbound --protocol Tcp \
      --source-address-prefixes VirtualNetwork \
      --destination-port-ranges 22
    ```

    ルールは優先度順に評価されます（番号が小さいほど先に評価）：Bastion トラフィックは 100 で許可され、その他のすべての SSH は 110 と 120 でブロックされます。

  </Step>

  <Step title="仮想ネットワークとサブネットを作成">
    VM サブネット（NSG 付き）を持つ VNet を作成し、次に Bastion サブネットを追加します。

    ```bash
    az network vnet create \
      -g "${RG}" -n "${VNET_NAME}" -l "${LOCATION}" \
      --address-prefixes "${VNET_PREFIX}" \
      --subnet-name "${VM_SUBNET_NAME}" \
      --subnet-prefixes "${VM_SUBNET_PREFIX}"

    # NSG を VM サブネットにアタッチ
    az network vnet subnet update \
      -g "${RG}" --vnet-name "${VNET_NAME}" \
      -n "${VM_SUBNET_NAME}" --nsg "${NSG_NAME}"

    # AzureBastionSubnet — Azure が要求する名前
    az network vnet subnet create \
      -g "${RG}" --vnet-name "${VNET_NAME}" \
      -n AzureBastionSubnet \
      --address-prefixes "${BASTION_SUBNET_PREFIX}"
    ```

  </Step>

  <Step title="VM を作成">
    VM にはパブリック IP がありません。SSH アクセスは Azure Bastion 経由のみです。

    ```bash
    az vm create \
      -g "${RG}" -n "${VM_NAME}" -l "${LOCATION}" \
      --image "Canonical:ubuntu-24_04-lts:server:latest" \
      --size "${VM_SIZE}" \
      --os-disk-size-gb "${OS_DISK_SIZE_GB}" \
      --storage-sku StandardSSD_LRS \
      --admin-username "${ADMIN_USERNAME}" \
      --ssh-key-values "${SSH_PUB_KEY}" \
      --vnet-name "${VNET_NAME}" \
      --subnet "${VM_SUBNET_NAME}" \
      --public-ip-address "" \
      --nsg ""
    ```

    `--public-ip-address ""` はパブリック IP の割り当てを防ぎます。`--nsg ""` は NIC ごとの NSG 作成をスキップします（サブネットレベルの NSG がセキュリティを処理します）。

    **再現性:** 上記のコマンドでは Ubuntu イメージに `latest` を使用しています。特定のバージョンを固定するには、利用可能なバージョンを一覧表示して `latest` を置き換えてください：

    ```bash
    az vm image list \
      --publisher Canonical --offer ubuntu-24_04-lts \
      --sku server --all -o table
    ```

  </Step>

  <Step title="Azure Bastion を作成">
    Azure Bastion は、パブリック IP を公開せずに VM へのマネージド SSH アクセスを提供します。CLI ベースの `az network bastion ssh` にはトンネリングが有効な Standard SKU が必要です。

    ```bash
    az network public-ip create \
      -g "${RG}" -n "${BASTION_PIP_NAME}" -l "${LOCATION}" \
      --sku Standard --allocation-method Static

    az network bastion create \
      -g "${RG}" -n "${BASTION_NAME}" -l "${LOCATION}" \
      --vnet-name "${VNET_NAME}" \
      --public-ip-address "${BASTION_PIP_NAME}" \
      --sku Standard --enable-tunneling true
    ```

    Bastion のプロビジョニングは通常 5〜10 分かかりますが、リージョンによっては最大 15〜30 分かかる場合があります。

  </Step>
</Steps>

## OpenClaw のインストール

<Steps>
  <Step title="Azure Bastion 経由で VM に SSH 接続">
    ```bash
    VM_ID="$(az vm show -g "${RG}" -n "${VM_NAME}" --query id -o tsv)"

    az network bastion ssh \
      --name "${BASTION_NAME}" \
      --resource-group "${RG}" \
      --target-resource-id "${VM_ID}" \
      --auth-type ssh-key \
      --username "${ADMIN_USERNAME}" \
      --ssh-key ~/.ssh/id_ed25519
    ```

  </Step>

  <Step title="OpenClaw をインストール（VM シェル内）">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh -o /tmp/install.sh
    bash /tmp/install.sh
    rm -f /tmp/install.sh
    ```

    インストーラーは Node LTS と依存関係がまだ存在しない場合はインストールし、OpenClaw をインストールし、オンボーディングウィザードを起動します。詳細は[インストール](/install)を参照してください。

  </Step>

  <Step title="Gateway ゲートウェイを検証">
    オンボーディング完了後：

    ```bash
    openclaw gateway status
    ```

    多くの企業 Azure チームはすでに GitHub Copilot ライセンスを持っています。その場合は、OpenClaw のオンボーディングウィザードで GitHub Copilot プロバイダーを選択することをお勧めします。[GitHub Copilot プロバイダー](/providers/github-copilot)を参照してください。

  </Step>
</Steps>

## コストに関する考慮事項

Azure Bastion Standard SKU は約 **\$140/月**、VM（Standard_B2as_v2）は約 **\$55/月** かかります。

コストを削減するには：

- 使用しないときは **VM を割り当て解除** します（コンピューティング課金は停止、ディスク課金は継続）。VM が割り当て解除されている間、OpenClaw Gateway ゲートウェイにはアクセスできません。再び稼働させたいときに再起動してください：

  ```bash
  az vm deallocate -g "${RG}" -n "${VM_NAME}"
  az vm start -g "${RG}" -n "${VM_NAME}"   # 後で再起動
  ```

- **不要なときは Bastion を削除** し、SSH アクセスが必要なときに再作成します。Bastion は最大のコスト要因ですが、プロビジョニングには数分しかかかりません。
- **Basic Bastion SKU** を使用します（約 \$38/月）。ポータルベースの SSH のみが必要で、CLI トンネリング（`az network bastion ssh`）が不要な場合に適しています。

## クリーンアップ

このガイドで作成したすべてのリソースを削除するには：

```bash
az group delete -n "${RG}" --yes --no-wait
```

これにより、リソースグループとその中のすべて（VM、VNet、NSG、Bastion、パブリック IP）が削除されます。

## 次のステップ

- メッセージングチャネルのセットアップ: [チャネル](/channels)
- ローカルデバイスをノードとしてペアリング: [ノード](/nodes)
- Gateway ゲートウェイの設定: [Gateway ゲートウェイの設定](/gateway/configuration)
- GitHub Copilot モデルプロバイダーを使用した OpenClaw Azure デプロイの詳細: [OpenClaw on Azure with GitHub Copilot](https://github.com/johnsonshi/openclaw-azure-github-copilot)
