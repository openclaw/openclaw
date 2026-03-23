---
summary: "Run OpenClaw Gateway on Azure Container Apps — free-tier eligible, no VMs, managed HTTPS, managed identity"
read_when:
  - You want OpenClaw running 24/7 on Azure without managing VMs
  - You want a serverless container deployment on Azure with free-tier pricing
  - You want Azure Container Apps to host the OpenClaw Gateway with auto-TLS
  - You want the cheapest possible Azure deployment for OpenClaw
  - You want managed identity and Key Vault for secure secret management
title: "Azure Container Apps"
---

# OpenClaw on Azure Container Apps

This guide deploys the OpenClaw Gateway as a container on Azure Container Apps — a managed, serverless container environment. No VMs, no Kubernetes cluster, no SSH keys, and no SSL certificates to manage.

Compared to the [Azure VM guide](/install/azure) (~\$195/month with Bastion), this approach targets the Azure free tier and bills only for actual usage — typically **under \$10/month** for light workloads and **\$0** while idle.

## What you will do

- Create a resource group and Azure Container Registry (ACR)
- Build and push the OpenClaw container image to ACR with managed identity (no admin credentials)
- Create an Azure Container Apps environment with persistent storage
- Deploy the Gateway with managed HTTPS ingress
- Store secrets securely in Azure Key Vault
- Access the Control UI via the auto-assigned FQDN

## What you need

- An Azure subscription with permission to create container, storage, and Key Vault resources ([create a free account](https://azure.microsoft.com/free/) if needed)
- Azure CLI installed (see [Azure CLI install steps](https://learn.microsoft.com/cli/azure/install-azure-cli) if needed)
- Docker Desktop (or Docker Engine) to build the image locally — or skip local Docker entirely with ACR Tasks (cloud build)
- An API key for at least one model provider
- ~15-20 minutes

## Configure deployment

<Steps>
  <Step title="Sign in to Azure CLI">
    ```bash
    az login
    ```
  </Step>

  <Step title="Register required resource providers (one-time)">
    ```bash
    az provider register --namespace Microsoft.App
    az provider register --namespace Microsoft.OperationalInsights
    az provider register --namespace Microsoft.ContainerRegistry
    az provider register --namespace Microsoft.KeyVault
    ```

    Verify registration. Wait until all show `Registered`.

    ```bash
    az provider show --namespace Microsoft.App --query registrationState -o tsv
    az provider show --namespace Microsoft.OperationalInsights --query registrationState -o tsv
    az provider show --namespace Microsoft.ContainerRegistry --query registrationState -o tsv
    az provider show --namespace Microsoft.KeyVault --query registrationState -o tsv
    ```

  </Step>

  <Step title="Set deployment variables">
    ```bash
    RG="rg-openclaw-aca"
    LOCATION="eastus"
    ACR_NAME="acropenclaw${RANDOM}"
    ACA_ENV="env-openclaw"
    ACA_APP="openclaw-gateway"
    STORAGE_ACCOUNT="stopenclaw${RANDOM}"
    SHARE_NAME="openclaw-data"
    KV_NAME="kv-openclaw-${RANDOM}"
    ```

    Adjust names to fit your environment. ACR and Key Vault names must be globally unique — the `${RANDOM}` suffix helps avoid collisions.

  </Step>
</Steps>

## Deploy Azure resources

<Steps>
  <Step title="Create the resource group">
    ```bash
    az group create -n "${RG}" -l "${LOCATION}"
    ```
  </Step>

  <Step title="Create the container registry">
    ```bash
    az acr create -g "${RG}" -n "${ACR_NAME}" --sku Basic
    ```

    ACR Basic costs ~\$5/month and includes 10 GiB of storage. Admin credentials are not enabled — the Container App will pull images using managed identity instead.

    <Note>
    **Skip ACR entirely?** If you prefer to avoid the ~\$5/month ACR cost, you can use a pre-built public image from GitHub Container Registry. See the [Skip ACR with GHCR](#skip-acr-with-ghcr) section below.
    </Note>

  </Step>

  <Step title="Build and push the image">
    **Option A: Build in the cloud** (no local Docker required):

    ```bash
    az acr build -r "${ACR_NAME}" -t openclaw:latest \
      https://github.com/openclaw/openclaw.git
    ```

    **Option B: Build locally** and push:

    ```bash
    az acr login -n "${ACR_NAME}"
    docker build -t "${ACR_NAME}.azurecr.io/openclaw:latest" .
    docker push "${ACR_NAME}.azurecr.io/openclaw:latest"
    ```

  </Step>

  <Step title="Create persistent storage">
    Azure Container Apps supports Azure Files for persistent storage. This ensures Gateway state survives container restarts and redeployments.

    ```bash
    az storage account create \
      -g "${RG}" -n "${STORAGE_ACCOUNT}" -l "${LOCATION}" \
      --sku Standard_LRS --min-tls-version TLS1_2 \
      --allow-blob-public-access false

    STORAGE_KEY="$(az storage account keys list \
      -g "${RG}" -n "${STORAGE_ACCOUNT}" \
      --query '[0].value' -o tsv)"

    az storage share-rm create \
      -g "${RG}" --storage-account "${STORAGE_ACCOUNT}" \
      -n "${SHARE_NAME}" --quota 1
    ```

    Storage is hardened with TLS 1.2 minimum and public blob access disabled.

  </Step>

  <Step title="Create the Container Apps environment">
    ```bash
    az containerapp env create \
      -g "${RG}" -n "${ACA_ENV}" -l "${LOCATION}"
    ```
  </Step>

  <Step title="Attach file share to the environment">
    ```bash
    az containerapp env storage set \
      -g "${RG}" -n "${ACA_ENV}" \
      --storage-name openclawstorage \
      --azure-file-account-name "${STORAGE_ACCOUNT}" \
      --azure-file-account-key "${STORAGE_KEY}" \
      --azure-file-share-name "${SHARE_NAME}" \
      --access-mode ReadWrite
    ```
  </Step>

  <Step title="Create Azure Key Vault">
    Key Vault stores provider API keys securely. The Container App will access secrets via managed identity — no credentials in environment variables or config files.

    ```bash
    az keyvault create \
      -g "${RG}" -n "${KV_NAME}" -l "${LOCATION}" \
      --enable-rbac-authorization true
    ```

  </Step>

  <Step title="Deploy the container app with managed identity">
    Deploy the container app and enable system-assigned managed identity in one step:

    ```bash
    az containerapp create \
      -g "${RG}" -n "${ACA_APP}" \
      --environment "${ACA_ENV}" \
      --image "${ACR_NAME}.azurecr.io/openclaw:latest" \
      --registry-server "${ACR_NAME}.azurecr.io" \
      --registry-identity system \
      --system-assigned \
      --target-port 18789 \
      --ingress external \
      --min-replicas 1 --max-replicas 1 \
      --cpu 0.5 --memory 1Gi \
      --env-vars \
        "OPENCLAW_GATEWAY_PORT=18789" \
        "OPENCLAW_HOME=/data/.openclaw" \
      --args "gateway" "run" "--bind" "all" "--port" "18789"
    ```

    `--registry-identity system` tells Container Apps to pull images using the app's managed identity instead of ACR admin credentials. No passwords to manage or rotate.

    <Note>
    Set `--min-replicas 1` to keep the Gateway always running. Scaling to 0 stops the Gateway.
    OpenClaw is a single-instance gateway — do not scale above 1 replica.
    Using 0.5 vCPU / 1 GiB keeps costs low. Scale up to `--cpu 1.0 --memory 2Gi` if you hit OOMs or need more concurrency.
    </Note>

  </Step>

  <Step title="Grant ACR pull permission to the managed identity">
    ```bash
    IDENTITY_PRINCIPAL="$(az containerapp show -g "${RG}" -n "${ACA_APP}" \
      --query identity.principalId -o tsv)"

    ACR_ID="$(az acr show -g "${RG}" -n "${ACR_NAME}" --query id -o tsv)"

    az role assignment create \
      --assignee "${IDENTITY_PRINCIPAL}" \
      --role AcrPull \
      --scope "${ACR_ID}"
    ```

  </Step>

  <Step title="Grant Key Vault access to the managed identity">
    ```bash
    KV_ID="$(az keyvault show -g "${RG}" -n "${KV_NAME}" --query id -o tsv)"

    az role assignment create \
      --assignee "${IDENTITY_PRINCIPAL}" \
      --role "Key Vault Secrets User" \
      --scope "${KV_ID}"
    ```

  </Step>

  <Step title="Add the volume mount">
    Update the container app to mount the persistent file share:

    ```bash
    az containerapp show -g "${RG}" -n "${ACA_APP}" -o yaml > /tmp/aca-app.yaml
    ```

    Edit `/tmp/aca-app.yaml` to add the volume and volume mount under the template spec:

    ```yaml
    properties:
      template:
        volumes:
          - name: openclaw-vol
            storageName: openclawstorage
            storageType: AzureFile
        containers:
          - name: openclaw-gateway
            volumeMounts:
              - volumeName: openclaw-vol
                mountPath: /data/.openclaw
    ```

    Apply:

    ```bash
    az containerapp update -g "${RG}" -n "${ACA_APP}" --yaml /tmp/aca-app.yaml
    ```

  </Step>
</Steps>

## Access the Control UI

<Steps>
  <Step title="Get the application URL">
    ```bash
    FQDN="$(az containerapp show -g "${RG}" -n "${ACA_APP}" \
      --query properties.configuration.ingress.fqdn -o tsv)"
    echo "https://${FQDN}"
    ```

    Open the URL in your browser. Azure Container Apps provides a valid TLS certificate automatically — no certificate setup required.

  </Step>

  <Step title="Complete onboarding">
    Open a console session to run onboarding inside the container:

    ```bash
    az containerapp exec -g "${RG}" -n "${ACA_APP}" --command "openclaw onboard"
    ```

    Alternatively, store your provider API key in Key Vault and reference it as a Container Apps secret:

    ```bash
    az keyvault secret set \
      --vault-name "${KV_NAME}" \
      -n "provider-api-key" \
      --value "<YOUR_API_KEY>"

    KEY_VAULT_URI="$(az keyvault show -n "${KV_NAME}" --query properties.vaultUri -o tsv)"

    az containerapp secret set \
      -g "${RG}" -n "${ACA_APP}" \
      --secrets "provider-key=keyvaultref:${KEY_VAULT_URI}secrets/provider-api-key,identityref:system"

    az containerapp update \
      -g "${RG}" -n "${ACA_APP}" \
      --set-env-vars "ANTHROPIC_API_KEY=secretref:provider-key"
    ```

    This stores the API key in Key Vault (encrypted, auditable, centrally managed) and injects it at runtime via the managed identity — no plaintext secrets in your deployment config.

    Most enterprise Azure teams already have GitHub Copilot licenses. If that is your case, we recommend choosing the GitHub Copilot provider in the OpenClaw onboarding wizard. See [GitHub Copilot provider](/providers/github-copilot).

  </Step>

  <Step title="Verify the Gateway">
    ```bash
    az containerapp exec -g "${RG}" -n "${ACA_APP}" --command "openclaw gateway status"
    ```
  </Step>
</Steps>

## Configure channels (optional)

Use `az containerapp exec` to run CLI commands inside the running container:

```bash
# Telegram
az containerapp exec -g "${RG}" -n "${ACA_APP}" \
  --command "openclaw channels add --channel telegram --token '<token>'"

# Discord
az containerapp exec -g "${RG}" -n "${ACA_APP}" \
  --command "openclaw channels add --channel discord --token '<token>'"
```

Docs: [Telegram](/channels/telegram), [Discord](/channels/discord)

## Cost considerations

Azure Container Apps uses consumption-based pricing — you pay per-second for active vCPU and memory. Many resources qualify for Azure's free tier.

| Resource                                    | Approximate cost | Free tier                                   |
| ------------------------------------------- | ---------------- | ------------------------------------------- |
| Container Apps (0.5 vCPU, 1 GiB, always-on) | ~\$22/month      | First 180K vCPU-s and 360K GiB-s/month free |
| Azure Files (Standard, 1 GiB share)         | ~\$0.06/month    | 5 GiB included with storage free tier       |
| Container Registry (Basic)                  | ~\$5/month       | —                                           |
| Key Vault (secrets operations)              | ~\$0.03/month    | \$0.03 per 10,000 operations                |
| Log Analytics                               | ~\$0/month       | 5 GiB/month ingestion free                  |
| **Total (always-on)**                       | **~\$27/month**  |                                             |
| **Total (scale-to-zero, light use)**        | **~\$0-5/month** |                                             |

**To minimize costs:**

- **Scale to zero** when not in use (the Gateway will not be reachable while scaled down):

  ```bash
  az containerapp update -g "${RG}" -n "${ACA_APP}" --min-replicas 0
  az containerapp update -g "${RG}" -n "${ACA_APP}" --min-replicas 1  # restart later
  ```

- **Use smaller resource allocations.** The 0.25 vCPU / 0.5 GiB tier is the minimum and sufficient for light single-channel use.
- **Skip ACR** by using a pre-built public image (e.g., from GitHub Container Registry) to save ~\$5/month. See [Skip ACR with GHCR](#skip-acr-with-ghcr).
- **Use the Azure free account.** New Azure accounts include \$200 credit for 30 days and 12 months of popular free services.

Compared to the [VM guide](/install/azure) (~\$195/month with Bastion), Container Apps eliminates Bastion, VM, VNet, and NSG costs entirely.

## Skip ACR with GHCR

To avoid the ~\$5/month ACR cost, use a pre-built image from GitHub Container Registry. Replace the ACR steps above with:

```bash
az containerapp create \
  -g "${RG}" -n "${ACA_APP}" \
  --environment "${ACA_ENV}" \
  --image ghcr.io/openclaw/openclaw:latest \
  --system-assigned \
  --target-port 18789 \
  --ingress external \
  --min-replicas 1 --max-replicas 1 \
  --cpu 0.5 --memory 1Gi \
  --env-vars \
    "OPENCLAW_GATEWAY_PORT=18789" \
    "OPENCLAW_HOME=/data/.openclaw" \
  --args "gateway" "run" "--bind" "all" "--port" "18789"
```

This pulls the public image directly — no registry credentials, no ACR resource, and no managed identity role assignment for ACR. You still need the Key Vault and storage steps above.

## Security

This deployment provides secure defaults without manual hardening:

- **No SSH surface** — there is no VM to SSH into. Management is via `az containerapp exec` (Azure RBAC-protected).
- **Managed identity** — the Container App authenticates to ACR and Key Vault using a system-assigned managed identity. No passwords or service principal secrets to manage or rotate.
- **Key Vault secrets** — provider API keys are stored in Azure Key Vault (encrypted at rest, auditable access logs) and injected via managed identity references. No plaintext secrets in deployment config.
- **Managed HTTPS** — Azure Container Apps provides TLS certificates and terminates TLS automatically.
- **No public IP to manage** — the FQDN is fronted by the Azure Container Apps proxy.
- **Storage hardened** — TLS 1.2 minimum, public blob access disabled.
- **RBAC authorization** — Key Vault uses Azure RBAC (not access policies), providing fine-grained, auditable permission control.

## Cleanup

To delete all resources created by this guide:

```bash
az group delete -n "${RG}" --yes --no-wait
```

This removes the resource group and everything inside it (Container App, environment, ACR, storage account).

## Next steps

- Set up messaging channels: [Channels](/channels)
- Pair local devices as nodes: [Nodes](/nodes)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)
- For the Azure VM alternative (full OS control): [Azure VM](/install/azure)
