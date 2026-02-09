---
summary: "Inicie sesión en GitHub Copilot desde OpenClaw usando el flujo de dispositivo"
read_when:
  - Desea usar GitHub Copilot como proveedor de modelos
  - Necesita el flujo `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
---

# GitHub Copilot

## ¿Qué es GitHub Copilot?

GitHub Copilot es el asistente de codificación con IA de GitHub. Proporciona acceso a
modelos de Copilot para su cuenta y plan de GitHub. OpenClaw puede usar Copilot como
proveedor de modelos de dos maneras diferentes.

## Dos maneras de usar Copilot en OpenClaw

### 1. Proveedor integrado de GitHub Copilot (`github-copilot`)

Use el flujo nativo de inicio de sesión por dispositivo para obtener un token de
GitHub y luego intercambiarlo por tokens de la API de Copilot cuando se ejecute
OpenClaw. Esta es la ruta **predeterminada** y la más sencilla porque no requiere
VS Code.

### 2. Plugin Copilot Proxy (`copilot-proxy`)

Use la extensión de VS Code **Copilot Proxy** como un puente local. OpenClaw se
comunica con el endpoint `/v1` del proxy y usa la lista de modelos que
configure allí. Elija esta opción cuando ya ejecute Copilot Proxy en VS Code o
necesite enrutar a través de él.
Debe habilitar el plugin y mantener la extensión de
VS Code en ejecución.

Use GitHub Copilot como proveedor de modelos (`github-copilot`). El comando de inicio
de sesión ejecuta el flujo de dispositivo de GitHub, guarda un perfil de
autenticación y actualiza su configuración para usar ese perfil.

## Configuración de la CLI

```bash
openclaw models auth login-github-copilot
```

Se le pedirá que visite una URL e ingrese un código de un solo uso. Mantenga la
terminal abierta hasta que se complete.

### Flags opcionales

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Establecer un modelo predeterminado

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

- Requiere un TTY interactivo; ejecútelo directamente en una terminal.
- La disponibilidad de modelos de Copilot depende de su plan; si un modelo es
  rechazado, pruebe con otro ID (por ejemplo `github-copilot/gpt-4.1`).
- El inicio de sesión almacena un token de GitHub en el almacén de perfiles de
  autenticación y lo intercambia por un token de la API de Copilot cuando se ejecuta
  OpenClaw.
