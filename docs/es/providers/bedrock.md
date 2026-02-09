---
summary: "Use modelos de Amazon Bedrock (API Converse) con OpenClaw"
read_when:
  - Desea usar modelos de Amazon Bedrock con OpenClaw
  - Necesita configurar credenciales/región de AWS para llamadas al modelo
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw puede usar modelos de **Amazon Bedrock** mediante el proveedor de streaming **Bedrock Converse** de pi‑ai. La autenticación de Bedrock usa la **cadena de credenciales predeterminada del SDK de AWS**, no una clave de API.

## Lo que piIrlandai apoya

- Proveedor: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Autenticación: credenciales de AWS (variables de entorno, configuración compartida o rol de instancia)
- Región: `AWS_REGION` o `AWS_DEFAULT_REGION` (predeterminado: `us-east-1`)

## Descubrimiento automático de modelos

Si se detectan credenciales de AWS, OpenClaw puede descubrir automáticamente modelos de Bedrock que admiten **streaming** y **salida de texto**. El descubrimiento usa `bedrock:ListFoundationModels` y se almacena en caché (predeterminado: 1 hora).

Las opciones de configuración se encuentran bajo `models.bedrockDiscovery`:

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

- `enabled` se establece de forma predeterminada en `true` cuando hay credenciales de AWS presentes.
- `region` se establece de forma predeterminada en `AWS_REGION` o `AWS_DEFAULT_REGION`, luego `us-east-1`.
- `providerFilter` coincide con los nombres de proveedores de Bedrock (por ejemplo, `anthropic`).
- `refreshInterval` está en segundos; establezca `0` para deshabilitar la caché.
- `defaultContextWindow` (predeterminado: `32000`) y `defaultMaxTokens` (predeterminado: `4096`)
  se usan para los modelos descubiertos (anule si conoce los límites de su modelo).

## Configuración (manual)

1. Asegúrese de que las credenciales de AWS estén disponibles en el **host del Gateway**:

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

2. Agregue un proveedor de Bedrock y un modelo a su configuración (no se requiere `apiKey`):

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

## Roles de instancia de EC2

Al ejecutar OpenClaw en una instancia EC2 con un rol de IAM adjunto, el SDK de AWS usará automáticamente el servicio de metadatos de la instancia (IMDS) para la autenticación.
Sin embargo, la detección de credenciales de OpenClaw actualmente solo verifica variables de entorno, no credenciales de IMDS.

**Solución alternativa:** Establezca `AWS_PROFILE=default` para indicar que hay credenciales de AWS disponibles. La autenticación real sigue usando el rol de instancia vía IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Permisos de IAM requeridos** para el rol de instancia de EC2:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (para el descubrimiento automático)

O adjunte la política administrada `AmazonBedrockFullAccess`.

**Configuración rápida:**

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

- Bedrock requiere que el **acceso al modelo** esté habilitado en su cuenta/región de AWS.
- El descubrimiento automático necesita el permiso `bedrock:ListFoundationModels`.
- Si usa perfiles, establezca `AWS_PROFILE` en el host del Gateway.
- OpenClaw muestra la fuente de credenciales en este orden: `AWS_BEARER_TOKEN_BEDROCK`,
  luego `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, luego `AWS_PROFILE`, y luego la
  cadena predeterminada del SDK de AWS.
- La compatibilidad con razonamiento depende del modelo; consulte la ficha del modelo de Bedrock para conocer las capacidades actuales.
- Si prefiere un flujo de claves administradas, también puede colocar un proxy compatible con OpenAI delante de Bedrock y configurarlo como un proveedor de OpenAI en su lugar.
