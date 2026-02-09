---
summary: "Use OAuth de Qwen (nivel gratuito) en OpenClaw"
read_when:
  - Quiere usar Qwen con OpenClaw
  - Quiere acceso OAuth de nivel gratuito a Qwen Coder
title: "Qwen"
---

# Qwen

Qwen ofrece un flujo OAuth de nivel gratuito para los modelos Qwen Coder y Qwen Vision
(2.000 solicitudes/día, sujeto a los límites de tasa de Qwen).

## Habilitar el plugin

```bash
openclaw plugins enable qwen-portal-auth
```

Reinicie el Gateway después de habilitarlo.

## Autenticar

```bash
openclaw models auth login --provider qwen-portal --set-default
```

Esto ejecuta el flujo OAuth de código de dispositivo de Qwen y escribe una entrada de proveedor en su
`models.json` (más un alias `qwen` para cambio rápido).

## IDs de modelos

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Cambie de modelo con:

```bash
openclaw models set qwen-portal/coder-model
```

## Reutilizar el inicio de sesión de Qwen Code CLI

Si ya inició sesión con la Qwen Code CLI, OpenClaw sincronizará las credenciales
desde `~/.qwen/oauth_creds.json` cuando cargue el almacén de autenticación. Aún necesita una
entrada `models.providers.qwen-portal` (use el comando de inicio de sesión anterior para crear una).

## Notas

- Los tokens se renuevan automáticamente; vuelva a ejecutar el comando de inicio de sesión si la renovación falla o se revoca el acceso.
- URL base predeterminada: `https://portal.qwen.ai/v1` (anúlela con
  `models.providers.qwen-portal.baseUrl` si Qwen proporciona un endpoint diferente).
- Consulte [Model providers](/concepts/model-providers) para reglas a nivel de proveedor.
