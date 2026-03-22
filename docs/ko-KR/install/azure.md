---
title: "Azure"
summary: "내구성 있는 상태를 갖춘 Azure Linux VM 에서 OpenClaw Gateway 를 24/7 실행"
read_when:
  - Network Security Group 강화를 통해 Azure 에서 OpenClaw 를 24/7 실행하고 싶을 때
  - 자체 Azure Linux VM 에서 프로덕션급 상시 가동 OpenClaw Gateway 를 원할 때
  - Azure Bastion SSH 를 통한 안전한 관리를 원할 때
x-i18n:
  source_path: docs/install/azure.md
---

# Azure Linux VM 에서 OpenClaw

이 가이드는 Azure CLI 로 Azure Linux VM 을 설정하고, Network Security Group (NSG) 강화를 적용하고, SSH 접근을 위한 Azure Bastion 을 구성하고, OpenClaw 를 설치합니다.

## 수행할 작업

- Azure CLI 로 Azure 네트워킹 (VNet, 서브넷, NSG) 및 컴퓨팅 리소스 생성
- VM SSH 가 Azure Bastion 에서만 허용되도록 Network Security Group 규칙 적용
- SSH 접근을 위한 Azure Bastion 사용 (VM 에 공용 IP 없음)
- 설치 스크립트로 OpenClaw 설치
- Gateway 확인

## 필요한 것

- 컴퓨팅 및 네트워크 리소스를 생성할 수 있는 권한이 있는 Azure 구독
- Azure CLI 설치 (필요한 경우 [Azure CLI 설치 단계](https://learn.microsoft.com/cli/azure/install-azure-cli) 참고)
- SSH 키 쌍 (필요한 경우 생성 방법을 가이드에서 다룸)
- 약 20-30 분

## 배포 구성

<Steps>
  <Step title="Azure CLI 로그인">
    ```bash
    az login
    az extension add -n ssh
    ```

    `ssh` 확장은 Azure Bastion 네이티브 SSH 터널링에 필요합니다.

  </Step>

  <Step title="필수 리소스 프로바이더 등록 (일회성)">
    ```bash
    az provider register --namespace Microsoft.Compute
    az provider register --namespace Microsoft.Network
    ```

    등록 확인. 둘 다 `Registered` 로 표시될 때까지 기다리세요.

    ```bash
    az provider show --namespace Microsoft.Compute --query registrationState -o tsv
    az provider show --namespace Microsoft.Network --query registrationState -o tsv
    ```

  </Step>

  <Step title="배포 변수 설정">
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

    환경에 맞게 이름과 CIDR 범위를 조정하세요. Bastion 서브넷은 최소 `/26` 이어야 합니다.

  </Step>

  <Step title="SSH 키 선택">
    기존 공개 키가 있으면 사용하세요:

    ```bash
    SSH_PUB_KEY="$(cat ~/.ssh/id_ed25519.pub)"
    ```

    SSH 키가 아직 없으면 생성하세요:

    ```bash
    ssh-keygen -t ed25519 -a 100 -f ~/.ssh/id_ed25519 -C "you@example.com"
    SSH_PUB_KEY="$(cat ~/.ssh/id_ed25519.pub)"
    ```

  </Step>

  <Step title="VM 크기 및 OS 디스크 크기 선택">
    ```bash
    VM_SIZE="Standard_B2as_v2"
    OS_DISK_SIZE_GB=64
    ```

    구독과 리전에서 사용 가능한 VM 크기 및 OS 디스크 크기를 선택하세요:

    - 가벼운 사용에는 작은 크기로 시작하고 나중에 확장
    - 더 많은 자동화, 더 많은 채널, 더 큰 모델/도구 워크로드에는 더 많은 vCPU/RAM/디스크 사용
    - VM 크기가 리전이나 구독 할당량에서 사용할 수 없으면 가장 가까운 사용 가능한 SKU 선택

    대상 리전에서 사용 가능한 VM 크기 나열:

    ```bash
    az vm list-skus --location "${LOCATION}" --resource-type virtualMachines -o table
    ```

    현재 vCPU 및 디스크 사용/할당량 확인:

    ```bash
    az vm list-usage --location "${LOCATION}" -o table
    ```

  </Step>
</Steps>

## Azure 리소스 배포

<Steps>
  <Step title="리소스 그룹 생성">
    ```bash
    az group create -n "${RG}" -l "${LOCATION}"
    ```
  </Step>

  <Step title="네트워크 보안 그룹 생성">
    NSG 를 생성하고 Bastion 서브넷만 VM 에 SSH 할 수 있도록 규칙을 추가합니다.

    ```bash
    az network nsg create \
      -g "${RG}" -n "${NSG_NAME}" -l "${LOCATION}"

    # Bastion 서브넷에서만 SSH 허용
    az network nsg rule create \
      -g "${RG}" --nsg-name "${NSG_NAME}" \
      -n AllowSshFromBastionSubnet --priority 100 \
      --access Allow --direction Inbound --protocol Tcp \
      --source-address-prefixes "${BASTION_SUBNET_PREFIX}" \
      --destination-port-ranges 22

    # 공용 인터넷에서 SSH 거부
    az network nsg rule create \
      -g "${RG}" --nsg-name "${NSG_NAME}" \
      -n DenyInternetSsh --priority 110 \
      --access Deny --direction Inbound --protocol Tcp \
      --source-address-prefixes Internet \
      --destination-port-ranges 22

    # 다른 VNet 소스에서 SSH 거부
    az network nsg rule create \
      -g "${RG}" --nsg-name "${NSG_NAME}" \
      -n DenyVnetSsh --priority 120 \
      --access Deny --direction Inbound --protocol Tcp \
      --source-address-prefixes VirtualNetwork \
      --destination-port-ranges 22
    ```

    규칙은 우선순위 (가장 낮은 숫자 먼저) 에 따라 평가됩니다: Bastion 트래픽은 100 에서 허용되고, 다른 모든 SSH 는 110 과 120 에서 차단됩니다.

  </Step>

  <Step title="가상 네트워크 및 서브넷 생성">
    VM 서브넷 (NSG 연결) 이 있는 VNet 을 생성한 다음 Bastion 서브넷을 추가합니다.

    ```bash
    az network vnet create \
      -g "${RG}" -n "${VNET_NAME}" -l "${LOCATION}" \
      --address-prefixes "${VNET_PREFIX}" \
      --subnet-name "${VM_SUBNET_NAME}" \
      --subnet-prefixes "${VM_SUBNET_PREFIX}"

    # VM 서브넷에 NSG 연결
    az network vnet subnet update \
      -g "${RG}" --vnet-name "${VNET_NAME}" \
      -n "${VM_SUBNET_NAME}" --nsg "${NSG_NAME}"

    # AzureBastionSubnet — 이름은 Azure 에서 필수
    az network vnet subnet create \
      -g "${RG}" --vnet-name "${VNET_NAME}" \
      -n AzureBastionSubnet \
      --address-prefixes "${BASTION_SUBNET_PREFIX}"
    ```

  </Step>

  <Step title="VM 생성">
    VM 에는 공용 IP 가 없습니다. SSH 접근은 Azure Bastion 을 통해서만 가능합니다.

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

    `--public-ip-address ""` 는 공용 IP 할당을 방지합니다. `--nsg ""` 는 NIC 별 NSG 생성을 건너뜁니다 (서브넷 수준 NSG 가 보안을 처리합니다).

    **재현성:** 위 명령은 Ubuntu 이미지에 `latest` 를 사용합니다. 특정 버전을 고정하려면 사용 가능한 버전을 나열하고 `latest` 를 교체하세요:

    ```bash
    az vm image list \
      --publisher Canonical --offer ubuntu-24_04-lts \
      --sku server --all -o table
    ```

  </Step>

  <Step title="Azure Bastion 생성">
    Azure Bastion 은 공용 IP 를 노출하지 않고 VM 에 관리형 SSH 접근을 제공합니다. CLI 기반 `az network bastion ssh` 에는 터널링이 활성화된 Standard SKU 가 필요합니다.

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

    Bastion 프로비저닝은 일반적으로 5-10 분이 걸리지만 일부 리전에서는 최대 15-30 분이 걸릴 수 있습니다.

  </Step>
</Steps>

## OpenClaw 설치

<Steps>
  <Step title="Azure Bastion 을 통해 VM 에 SSH">
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

  <Step title="OpenClaw 설치 (VM 셸에서)">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh -o /tmp/install.sh
    bash /tmp/install.sh
    rm -f /tmp/install.sh
    ```

    설치 프로그램은 Node LTS 및 의존성이 아직 없으면 설치하고, OpenClaw 를 설치하고, 온보딩 마법사를 시작합니다. 자세한 내용은 [설치](/install)를 참고하세요.

  </Step>

  <Step title="Gateway 확인">
    온보딩 완료 후:

    ```bash
    openclaw gateway status
    ```

    대부분의 기업 Azure 팀은 이미 GitHub Copilot 라이선스를 보유하고 있습니다. 해당하는 경우 OpenClaw 온보딩 마법사에서 GitHub Copilot 프로바이더를 선택하는 것을 권장합니다. [GitHub Copilot 프로바이더](/providers/github-copilot)를 참고하세요.

  </Step>
</Steps>

## 비용 고려사항

Azure Bastion Standard SKU 는 약 **월 $140**, VM (Standard_B2as_v2) 은 약 **월 $55** 입니다.

비용을 줄이려면:

- 사용하지 않을 때 **VM 할당 해제** (컴퓨팅 과금 중지; 디스크 요금은 유지). VM 이 할당 해제된 동안 OpenClaw Gateway 에 접근할 수 없습니다 -- 다시 필요할 때 재시작하세요:

  ```bash
  az vm deallocate -g "${RG}" -n "${VM_NAME}"
  az vm start -g "${RG}" -n "${VM_NAME}"   # 나중에 재시작
  ```

- SSH 접근이 필요할 때 **Bastion 을 삭제하고 다시 생성**. Bastion 이 가장 큰 비용 구성 요소이며 프로비저닝에 몇 분밖에 걸리지 않습니다.
- 포탈 기반 SSH 만 필요하고 CLI 터널링 (`az network bastion ssh`) 이 필요 없다면 **Basic Bastion SKU** (약 월 $38) 를 사용하세요.

## 정리

이 가이드에서 생성한 모든 리소스를 삭제하려면:

```bash
az group delete -n "${RG}" --yes --no-wait
```

리소스 그룹과 그 안의 모든 것 (VM, VNet, NSG, Bastion, 공용 IP) 을 제거합니다.

## 다음 단계

- 메시징 채널 설정: [채널](/channels)
- 로컬 장치를 노드로 페어링: [노드](/nodes)
- Gateway 구성: [Gateway 구성](/gateway/configuration)
- GitHub Copilot 모델 프로바이더를 사용한 OpenClaw Azure 배포에 대한 자세한 내용: [Azure 에서 GitHub Copilot 으로 OpenClaw](https://github.com/johnsonshi/openclaw-azure-github-copilot)
