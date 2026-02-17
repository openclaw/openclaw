---
summary: "Inicia sesión en GitHub Copilot desde OpenClaw usando el flujo de dispositivo"
read_when:
  - Quieres usar GitHub Copilot como proveedor de modelo
  - Necesitas el flujo `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
---

# GitHub Copilot

## ¿Qué es GitHub Copilot?

GitHub Copilot es el asistente de codificación con IA de GitHub. Proporciona acceso a modelos de Copilot para tu cuenta y plan de GitHub. OpenClaw puede usar Copilot como proveedor de modelo de dos maneras diferentes.

## Dos formas de usar Copilot en OpenClaw

### 1) Proveedor integrado de GitHub Copilot (`github-copilot`)

Usa el flujo nativo de inicio de sesión por dispositivo para obtener un token de GitHub, luego intercámbialo por tokens de API de Copilot cuando OpenClaw se ejecute. Esta es la ruta **por defecto** y más simple porque no requiere VS Code.

### 2) Plugin de Copilot Proxy (`copilot-proxy`)

Usa la extensión de VS Code **Copilot Proxy** como puente local. OpenClaw se comunica con el endpoint `/v1` del proxy y usa la lista de modelos que configures allí. Elige esto cuando ya ejecutes Copilot Proxy en VS Code o necesites enrutar a través de él. Debes habilitar el plugin y mantener la extensión de VS Code en ejecución.

Usa GitHub Copilot como proveedor de modelo (`github-copilot`). El comando de inicio de sesión ejecuta el flujo de dispositivo de GitHub, guarda un perfil de autenticación y actualiza tu configuración para usar ese perfil.

## Configuración mediante CLI

```bash
openclaw models auth login-github-copilot
```

Se te pedirá que visites una URL e ingreses un código de un solo uso. Mantén la terminal abierta hasta que se complete.

### Flags opcionales

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Establecer un modelo por defecto

```bash
openclaw models set github-copilot/gpt-4o
```

### Fragmento de configuración

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Notas

- Requiere un TTY interactivo; ejecútalo directamente en una terminal.
- La disponibilidad de modelos de Copilot depende de tu plan; si un modelo es rechazado, prueba
  con otro ID (por ejemplo `github-copilot/gpt-4.1`).
- El inicio de sesión almacena un token de GitHub en el almacén de perfiles de autenticación y lo intercambia por un
  token de API de Copilot cuando OpenClaw se ejecuta.
