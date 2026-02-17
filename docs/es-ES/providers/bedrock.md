---
summary: "Usa modelos de Amazon Bedrock (API Converse) con OpenClaw"
read_when:
  - Quieres usar modelos de Amazon Bedrock con OpenClaw
  - Necesitas configurar credenciales/región de AWS para llamadas a modelos
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw puede usar modelos de **Amazon Bedrock** mediante el proveedor de streaming **Bedrock Converse** de pi-ai. La autenticación de Bedrock usa la **cadena de credenciales por defecto del SDK de AWS**, no una clave de API.

## Lo que soporta pi-ai

- Proveedor: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Autenticación: Credenciales de AWS (variables de entorno, configuración compartida o rol de instancia)
- Región: `AWS_REGION` o `AWS_DEFAULT_REGION` (por defecto: `us-east-1`)

## Descubrimiento automático de modelos

Si se detectan credenciales de AWS, OpenClaw puede descubrir automáticamente modelos de Bedrock que soporten **streaming** y **salida de texto**. El descubrimiento usa `bedrock:ListFoundationModels` y se almacena en caché (por defecto: 1 hora).

Las opciones de configuración están bajo `models.bedrockDiscovery`:

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

- `enabled` está en `true` por defecto cuando hay credenciales de AWS presentes.
- `region` por defecto es `AWS_REGION` o `AWS_DEFAULT_REGION`, luego `us-east-1`.
- `providerFilter` coincide con nombres de proveedor de Bedrock (por ejemplo `anthropic`).
- `refreshInterval` está en segundos; establece en `0` para deshabilitar el caché.
- `defaultContextWindow` (por defecto: `32000`) y `defaultMaxTokens` (por defecto: `4096`)
  se usan para modelos descubiertos (anula si conoces los límites de tu modelo).

## Configuración (manual)

1. Asegúrate de que las credenciales de AWS estén disponibles en el **host del gateway**:

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"
# Opcional:
export AWS_SESSION_TOKEN="..."
export AWS_PROFILE="your-profile"
# Opcional (clave de API/token bearer de Bedrock):
export AWS_BEARER_TOKEN_BEDROCK="..."
```

2. Agrega un proveedor de Bedrock y un modelo a tu configuración (no se requiere `apiKey`):

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

Al ejecutar OpenClaw en una instancia EC2 con un rol IAM adjunto, el SDK de AWS usará automáticamente el servicio de metadatos de instancia (IMDS) para autenticación. Sin embargo, la detección de credenciales de OpenClaw actualmente solo verifica variables de entorno, no credenciales de IMDS.

**Solución alternativa:** Establece `AWS_PROFILE=default` para señalar que hay credenciales de AWS disponibles. La autenticación real aún usa el rol de instancia mediante IMDS.

```bash
# Agrega a ~/.bashrc o tu perfil de shell
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Permisos IAM requeridos** para el rol de instancia EC2:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (para descubrimiento automático)

O adjunta la política administrada `AmazonBedrockFullAccess`.

**Configuración rápida:**

```bash
# 1. Crear rol IAM y perfil de instancia
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

# 2. Adjuntar a tu instancia EC2
aws ec2 associate-iam-instance-profile \
  --instance-id i-xxxxx \
  --iam-instance-profile Name=EC2-Bedrock-Access

# 3. En la instancia EC2, habilitar el descubrimiento
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# 4. Establecer las variables de entorno de la solución alternativa
echo 'export AWS_PROFILE=default' >> ~/.bashrc
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc
source ~/.bashrc

# 5. Verificar que se descubran los modelos
openclaw models list
```

## Notas

- Bedrock requiere **acceso a modelos** habilitado en tu cuenta/región de AWS.
- El descubrimiento automático necesita el permiso `bedrock:ListFoundationModels`.
- Si usas perfiles, establece `AWS_PROFILE` en el host del gateway.
- OpenClaw expone la fuente de credenciales en este orden: `AWS_BEARER_TOKEN_BEDROCK`,
  luego `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, luego `AWS_PROFILE`, luego la
  cadena por defecto del SDK de AWS.
- El soporte de razonamiento depende del modelo; verifica la tarjeta del modelo de Bedrock para
  capacidades actuales.
- Si prefieres un flujo de clave administrado, también puedes colocar un
  proxy compatible con OpenAI frente a Bedrock y configurarlo como un proveedor de OpenAI en su lugar.
