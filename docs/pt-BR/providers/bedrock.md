---
summary: "Use modelos do Amazon Bedrock (API Converse) com o OpenClaw"
read_when:
  - Voce quer usar modelos do Amazon Bedrock com o OpenClaw
  - Voce precisa configurar credenciais/região da AWS para chamadas de modelo
title: "Amazon Bedrock"
---

# Amazon Bedrock

O OpenClaw pode usar modelos do **Amazon Bedrock** por meio do provedor de
streaming **Bedrock Converse** do pi‑ai. A autenticação do Bedrock usa a
**cadeia padrão de credenciais do AWS SDK**, não uma chave de API.

## O que o pi‑ai oferece

- Provedor: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Autenticação: credenciais da AWS (variáveis de ambiente, configuração compartilhada ou role da instância)
- Região: `AWS_REGION` ou `AWS_DEFAULT_REGION` (padrão: `us-east-1`)

## Descoberta automática de modelos

Se credenciais da AWS forem detectadas, o OpenClaw pode descobrir automaticamente
modelos do Bedrock que oferecem suporte a **streaming** e **saída de texto**. A
descoberta usa `bedrock:ListFoundationModels` e é armazenada em cache (padrão: 1 hora).

As opções de configuração ficam em `models.bedrockDiscovery`:

```json5
{
  models: {
    bedrockDiscovery: {
      enabled: true,
      region: "us-east-1",
      providerFilter: ["anthropic", "amazon"],
      refreshInterval: 3600,
      defaultContextWindow: 32000,
      defaultMaxTokens: 4096,
    },
  },
}
```

Notas:

- `enabled` assume como padrão `true` quando credenciais da AWS estão presentes.
- `region` assume como padrão `AWS_REGION` ou `AWS_DEFAULT_REGION`, depois `us-east-1`.
- `providerFilter` corresponde aos nomes de provedores do Bedrock (por exemplo, `anthropic`).
- `refreshInterval` está em segundos; defina como `0` para desativar o cache.
- `defaultContextWindow` (padrão: `32000`) e `defaultMaxTokens` (padrão: `4096`)
  são usados para modelos descobertos (substitua se voce conhecer os limites do seu modelo).

## Configuração (manual)

1. Garanta que as credenciais da AWS estejam disponíveis no **host do gateway**:

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"
# Optional:
export AWS_SESSION_TOKEN="..."
export AWS_PROFILE="your-profile"
# Optional (Bedrock API key/bearer token):
export AWS_BEARER_TOKEN_BEDROCK="..."
```

2. Adicione um provedor e um modelo do Bedrock à sua configuração (nenhum `apiKey` é necessário):

```json5
{
  models: {
    providers: {
      "amazon-bedrock": {
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
        models: [
          {
            id: "us.anthropic.claude-opus-4-6-v1:0",
            name: "Claude Opus 4.6 (Bedrock)",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1:0" },
    },
  },
}
```

## Roles de Instância do EC2

Ao executar o OpenClaw em uma instância EC2 com uma role do IAM anexada, o AWS SDK
usará automaticamente o serviço de metadados da instância (IMDS) para autenticação.
No entanto, a detecção de credenciais do OpenClaw atualmente verifica apenas
variáveis de ambiente, não credenciais do IMDS.

**Solução alternativa:** Defina `AWS_PROFILE=default` para sinalizar que credenciais da AWS
estão disponíveis. A autenticação real ainda usa a role da instância via IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Permissões do IAM necessárias** para a role da instância EC2:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (para descoberta automática)

Ou anexe a política gerenciada `AmazonBedrockFullAccess`.

**Configuração rápida:**

```bash
# 1. Create IAM role and instance profile
aws iam create-role --role-name EC2-Bedrock-Access \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy --role-name EC2-Bedrock-Access \
  --policy-arn arn:aws:iam::aws:policy/AmazonBedrockFullAccess

aws iam create-instance-profile --instance-profile-name EC2-Bedrock-Access
aws iam add-role-to-instance-profile \
  --instance-profile-name EC2-Bedrock-Access \
  --role-name EC2-Bedrock-Access

# 2. Attach to your EC2 instance
aws ec2 associate-iam-instance-profile \
  --instance-id i-xxxxx \
  --iam-instance-profile Name=EC2-Bedrock-Access

# 3. On the EC2 instance, enable discovery
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# 4. Set the workaround env vars
echo 'export AWS_PROFILE=default' >> ~/.bashrc
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc
source ~/.bashrc

# 5. Verify models are discovered
openclaw models list
```

## Notas

- O Bedrock exige **acesso ao modelo** habilitado na sua conta/região da AWS.
- A descoberta automática precisa da permissão `bedrock:ListFoundationModels`.
- Se voce usa perfis, defina `AWS_PROFILE` no host do gateway.
- O OpenClaw expõe a origem da credencial nesta ordem: `AWS_BEARER_TOKEN_BEDROCK`,
  depois `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, depois `AWS_PROFILE`, e então a
  cadeia padrão do AWS SDK.
- O suporte a raciocínio depende do modelo; verifique o card do modelo do Bedrock
  para as capacidades atuais.
- Se voce preferir um fluxo de chave gerenciado, também pode colocar um proxy
  compatível com OpenAI na frente do Bedrock e configurá-lo como um provedor OpenAI.
