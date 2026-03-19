---
summary: "Run OpenClaw Gateway 24/7 on an Azure Linux VM with durable state"
read_when:
  - You want OpenClaw running 24/7 on Azure with Network Security Group hardening
  - You want a production-grade, always-on OpenClaw Gateway on your own Azure Linux VM
  - You want secure administration with Azure Bastion SSH
  - You want repeatable deployments with Azure Resource Manager templates
title: "Azure"
---

# OpenClaw on Azure Linux VM

This guide sets up an Azure Linux VM, applies Network Security Group (NSG) hardening, configures Azure Bastion (managed Azure SSH entry point), and installs OpenClaw.

## What you’ll do

- Deploy Azure compute and network resources with Azure Resource Manager (ARM) templates
- Apply Azure Network Security Group (NSG) rules so VM SSH is allowed only from Azure Bastion
- Use Azure Bastion for SSH access
- Install OpenClaw with the installer script
- Verify the Gateway

## Before you start

You’ll need:

- An Azure subscription with permission to create compute and network resources
- Azure CLI installed (see [Azure CLI install steps](https://learn.microsoft.com/cli/azure/install-azure-cli) if needed)

<Steps>
  <Step title="Sign in to Azure CLI">
    ```bash
    az login # Sign in and select your Azure subscription
    az extension add -n ssh # Extension required for Azure Bastion SSH management
    ```
  </Step>

  <Step title="Register required resource providers (one-time)">
    ```bash
    az provider register --namespace Microsoft.Compute
    az provider register --namespace Microsoft.Network
    ```

    Verify Azure resource provider registration. Wait until both show `Registered`.

    ```bash
    az provider show --namespace Microsoft.Compute --query registrationState -o tsv
    az provider show --namespace Microsoft.Network --query registrationState -o tsv
    ```

  </Step>

  <Step title="Set deployment variables">
    ```bash
    RG="rg-openclaw"
    LOCATION="westus2"
    TEMPLATE_URI="https://raw.githubusercontent.com/openclaw/openclaw/main/infra/azure/templates/azuredeploy.json"
    PARAMS_URI="https://raw.githubusercontent.com/openclaw/openclaw/main/infra/azure/templates/azuredeploy.parameters.json"
    ```
  </Step>

  <Step title="Select SSH key">
    Use your existing public key if you have one:

    ```bash
    SSH_PUB_KEY="$(cat ~/.ssh/id_ed25519.pub)"
    ```

    If you don’t have an SSH key yet, run the following:

    ```bash
    ssh-keygen -t ed25519 -a 100 -f ~/.ssh/id_ed25519 -C "you@example.com"
    SSH_PUB_KEY="$(cat ~/.ssh/id_ed25519.pub)"
    ```

  </Step>

  <Step title="Select VM size and OS disk size">
    Set VM and disk sizing variables:

    ```bash
    VM_SIZE="Standard_B2as_v2"
    OS_DISK_SIZE_GB=64
    ```

    Choose a VM size and OS disk size that are available in your Azure subscription/region and matches your workload:

    - Start smaller for light usage and scale up later
    - Use more vCPU/RAM/OS disk size for heavier automation, more channels, or larger model/tool workloads
    - If a VM size is unavailable in your region or subscription quota, pick the closest available SKU

    List VM sizes available in your target region:

    ```bash
    az vm list-skus --location "${LOCATION}" --resource-type virtualMachines -o table
    ```

    Check your current VM vCPU and OS disk size usage/quota:

    ```bash
    az vm list-usage --location "${LOCATION}" -o table
    ```

  </Step>

  <Step title="Create the resource group">
    ```bash
    az group create -n "${RG}" -l "${LOCATION}"
    ```
  </Step>

  <Step title="Deploy resources">
    This command applies your selected SSH key, VM size, and OS disk size.

    ```bash
    az deployment group create \
      -g "${RG}" \
      --template-uri "${TEMPLATE_URI}" \
      --parameters "${PARAMS_URI}" \
      --parameters location="${LOCATION}" \
      --parameters vmSize="${VM_SIZE}" \
      --parameters osDiskSizeGb="${OS_DISK_SIZE_GB}" \
      --parameters sshPublicKey="${SSH_PUB_KEY}"
    ```

  </Step>

  <Step title="SSH into the VM through Azure Bastion">
    ```bash
    RG="rg-openclaw"
    VM_NAME="vm-openclaw"
    BASTION_NAME="bas-openclaw"
    ADMIN_USERNAME="openclaw"
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

  <Step title="Install OpenClaw (in the VM shell)">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh -o /tmp/openclaw-install.sh
    bash /tmp/openclaw-install.sh
    rm -f /tmp/openclaw-install.sh
    openclaw --version
    ```

    The installer script handles Node detection/installation and runs onboarding by default.

  </Step>

  <Step title="Verify the Gateway">
    After onboarding completes:

    ```bash
    openclaw gateway status
    ```

    Most enterprise Azure teams already have GitHub Copilot licenses. If that is your case, we recommend choosing the GitHub Copilot provider in the OpenClaw onboarding wizard. See [GitHub Copilot provider](/providers/github-copilot).

    The included ARM template uses Ubuntu image `version: "latest"` for convenience. If you need reproducible builds, pin a specific image version in `infra/azure/templates/azuredeploy.json` (you can list versions with `az vm image list --publisher Canonical --offer ubuntu-24_04-lts --sku server --all -o table`).

  </Step>
</Steps>

## Next steps

- Set up messaging channels: [Channels](/channels)
- Pair local devices as nodes: [Nodes](/nodes)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)
- For more details on OpenClaw Azure deployment with the GitHub Copilot model provider: [OpenClaw on Azure with GitHub Copilot](https://github.com/johnsonshi/openclaw-azure-github-copilot)
