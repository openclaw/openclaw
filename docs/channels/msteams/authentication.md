---
summary: "Certificate and managed identity authentication for the Microsoft Teams bot"
read_when:
  - Replacing a client secret with a certificate or managed identity
  - Deploying the Teams bot on AKS with workload identity
title: "Microsoft Teams authentication"
sidebarTitle: "Authentication"
---

Federated authentication for the Teams bot, and how it compares with a client secret.

## Federated authentication (certificate plus managed identity)

For production, OpenClaw supports **federated authentication** as an alternative to client secrets, via `channels.msteams.authType: "federated"`. Two methods:

### Option A: Certificate-based authentication

Use a PEM certificate registered with your Entra ID app registration.

**Setup:**

1. Generate or obtain a certificate (PEM format with private key).
2. Entra ID → App Registration → **Certificates & secrets** → **Certificates** → upload the public certificate.

**Config:**

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      tenantId: "<TENANT_ID>",
      authType: "federated",
      certificatePath: "/path/to/cert.pem",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

**Env vars:**

- `MSTEAMS_AUTH_TYPE=federated`
- `MSTEAMS_CERTIFICATE_PATH=/path/to/cert.pem`

### Option B: Azure Managed Identity

Use Azure Managed Identity for passwordless authentication on Azure infrastructure (AKS, App Service, Azure VMs).

**How it works:**

1. The bot pod/VM has a managed identity (system- or user-assigned).
2. A federated identity credential links the managed identity to the Entra ID app registration.
3. At runtime, OpenClaw uses `@azure/identity` to acquire tokens from the Azure IMDS endpoint.
4. The token is passed to the Teams SDK for bot authentication.

**Prerequisites:**

- Azure infrastructure with managed identity enabled (AKS workload identity, App Service, VM).
- Federated identity credential created on the Entra ID app registration.
- Network access to IMDS (`169.254.169.254:80`) from the pod/VM.

**Config (system-assigned managed identity):**

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      tenantId: "<TENANT_ID>",
      authType: "federated",
      useManagedIdentity: true,
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

**Config (user-assigned managed identity):** add `managedIdentityClientId: "<MI_CLIENT_ID>"` to the block above.

**Env vars:**

- `MSTEAMS_AUTH_TYPE=federated`
- `MSTEAMS_USE_MANAGED_IDENTITY=true`
- `MSTEAMS_MANAGED_IDENTITY_CLIENT_ID=<client-id>` (user-assigned only)

### AKS Workload Identity setup

For AKS deployments using workload identity:

1. **Enable workload identity** on your AKS cluster.
2. **Create a federated identity credential** on the Entra ID app registration:

   ```bash
   az ad app federated-credential create --id <APP_OBJECT_ID> --parameters '{
     "name": "my-bot-workload-identity",
     "issuer": "<AKS_OIDC_ISSUER_URL>",
     "subject": "system:serviceaccount:<NAMESPACE>:<SERVICE_ACCOUNT>",
     "audiences": ["api://AzureADTokenExchange"]
   }'
   ```

3. **Annotate the Kubernetes service account** with the app client ID:

   ```yaml
   apiVersion: v1
   kind: ServiceAccount
   metadata:
     name: my-bot-sa
     annotations:
       azure.workload.identity/client-id: "<APP_CLIENT_ID>"
   ```

4. **Label the pod** for workload identity injection:

   ```yaml
   metadata:
     labels:
       azure.workload.identity/use: "true"
   ```

5. **Allow network access** to IMDS (`169.254.169.254`): if using NetworkPolicy, add an egress rule for `169.254.169.254/32` on port 80.

### Auth type comparison

| Method               | Config                                         | Pros                               | Cons                                  |
| -------------------- | ---------------------------------------------- | ---------------------------------- | ------------------------------------- |
| **Client secret**    | `appPassword`                                  | Simple setup                       | Secret rotation required, less secure |
| **Certificate**      | `authType: "federated"` + `certificatePath`    | No shared secret over network      | Certificate management overhead       |
| **Managed Identity** | `authType: "federated"` + `useManagedIdentity` | Passwordless, no secrets to manage | Azure infrastructure required         |

`certificateThumbprint` can be set alongside `certificatePath` but is not read by the auth path today; it is accepted for forward compatibility only.

**Default:** when `authType` is unset, OpenClaw uses client-secret authentication (`appPassword`). Existing configs keep working unchanged.
