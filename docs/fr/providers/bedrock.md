---
summary: "Utilisez les modèles Amazon Bedrock (API Converse) avec OpenClaw"
read_when:
  - Vous souhaitez utiliser des modèles Amazon Bedrock avec OpenClaw
  - Vous avez besoin de la configuration des identifiants/région AWS pour les appels de modèles
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw peut utiliser les modèles **Amazon Bedrock** via le fournisseur de streaming **Bedrock Converse** de pi‑ai. L’authentification Bedrock utilise la **chaîne d’identifiants par défaut du SDK AWS**, et non une clé API.

## Ce que Pi-ai prend en charge

- Fournisseur : `amazon-bedrock`
- API : `bedrock-converse-stream`
- Authentification : identifiants AWS (variables d’environnement, configuration partagée ou rôle d’instance)
- Région : `AWS_REGION` ou `AWS_DEFAULT_REGION` (par défaut : `us-east-1`)

## Découverte automatique des modèles

Si des identifiants AWS sont détectés, OpenClaw peut découvrir automatiquement les modèles Bedrock qui prennent en charge le **streaming** et la **sortie texte**. La découverte utilise `bedrock:ListFoundationModels` et est mise en cache (par défaut : 1 heure).

Les options de configuration se trouvent sous `models.bedrockDiscovery` :

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

Remarques :

- `enabled` a pour valeur par défaut `true` lorsque des identifiants AWS sont présents.
- `region` a pour valeur par défaut `AWS_REGION` ou `AWS_DEFAULT_REGION`, puis `us-east-1`.
- `providerFilter` correspond aux noms des fournisseurs Bedrock (par exemple `anthropic`).
- `refreshInterval` est en secondes ; définissez `0` pour désactiver la mise en cache.
- `defaultContextWindow` (par défaut : `32000`) et `defaultMaxTokens` (par défaut : `4096`)
  sont utilisés pour les modèles découverts (remplacez-les si vous connaissez les limites de votre modèle).

## Configuration (manuelle)

1. Assurez-vous que des identifiants AWS sont disponibles sur l’**hôte de la Gateway (passerelle)** :

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

2. Ajoutez un fournisseur Bedrock et un modèle à votre configuration (aucun `apiKey` requis) :

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

## Rôles d’instance EC2

Lors de l’exécution d’OpenClaw sur une instance EC2 avec un rôle IAM attaché, le SDK AWS utilisera automatiquement le service de métadonnées d’instance (IMDS) pour l’authentification.
Cependant, la détection des identifiants d’OpenClaw ne vérifie actuellement que les variables d’environnement, et non les identifiants IMDS.

**Solution de contournement :** définissez `AWS_PROFILE=default` pour indiquer que des identifiants AWS sont disponibles. L’authentification réelle utilise toujours le rôle d’instance via IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Autorisations IAM requises** pour le rôle d’instance EC2 :

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (pour la découverte automatique)

Ou attachez la stratégie gérée `AmazonBedrockFullAccess`.

**Configuration rapide :**

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

## Remarques

- Bedrock nécessite l’activation de l’**accès aux modèles** dans votre compte/région AWS.
- La découverte automatique nécessite l’autorisation `bedrock:ListFoundationModels`.
- Si vous utilisez des profils, définissez `AWS_PROFILE` sur l’hôte de la Gateway (passerelle).
- OpenClaw expose la source des identifiants dans l’ordre suivant : `AWS_BEARER_TOKEN_BEDROCK`,
  puis `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, puis `AWS_PROFILE`, puis la
  chaîne par défaut du SDK AWS.
- La prise en charge du raisonnement dépend du modèle ; consultez la fiche du modèle Bedrock pour connaître les capacités actuelles.
- Si vous préférez un flux de clés géré, vous pouvez également placer un proxy compatible OpenAI devant Bedrock et le configurer comme fournisseur OpenAI à la place.
