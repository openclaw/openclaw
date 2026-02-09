---
summary: "OAuth en OpenClaw: intercambio de tokens, almacenamiento y patrones de múltiples cuentas"
read_when:
  - Quiere comprender OAuth en OpenClaw de extremo a extremo
  - Ha tenido problemas de invalidación de tokens / cierre de sesión
  - Quiere flujos de autenticación con setup-token u OAuth
  - Quiere múltiples cuentas o enrutamiento por perfiles
title: "OAuth"
---

# OAuth

OpenClaw admite “autenticación por suscripción” mediante OAuth para proveedores que la ofrecen (en particular **OpenAI Codex (ChatGPT OAuth)**). Para suscripciones de Anthropic, use el flujo **setup-token**. Esta página explica:

- cómo funciona el **intercambio de tokens** de OAuth (PKCE)
- dónde se **almacenan** los tokens (y por qué)
- cómo manejar **múltiples cuentas** (perfiles + anulaciones por sesión)

OpenClaw también admite **plugins de proveedor** que incluyen sus propios flujos de OAuth o de clave de API. Ejecútelos mediante:

```bash
openclaw models auth login --provider <id>
```

## El sumidero de tokens (por qué existe)

Los proveedores OAuth suelen emitir un **nuevo token de actualización** durante los flujos de inicio de sesión/actualización. Algunos proveedores (o clientes OAuth) pueden invalidar tokens de actualización anteriores cuando se emite uno nuevo para el mismo usuario/aplicación.

Síntoma práctico:

- inicia sesión mediante OpenClaw _y_ mediante Claude Code / Codex CLI → uno de ellos termina “cerrando sesión” de forma aleatoria más tarde

Para reducir esto, OpenClaw trata `auth-profiles.json` como un **sumidero de tokens**:

- el runtime lee las credenciales desde **un solo lugar**
- podemos mantener múltiples perfiles y enrutarlos de forma determinista

## Almacenamiento (dónde viven los tokens)

Los secretos se almacenan **por agente**:

- Perfiles de autenticación (OAuth + claves de API): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Caché de runtime (gestionada automáticamente; no la edite): `~/.openclaw/agents/<agentId>/agent/auth.json`

Archivo heredado solo para importación (aún compatible, pero no es el almacén principal):

- `~/.openclaw/credentials/oauth.json` (importado a `auth-profiles.json` en el primer uso)

Todo lo anterior también respeta `$OPENCLAW_STATE_DIR` (anulación del directorio de estado). Referencia completa: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (autenticación por suscripción)

Ejecute `claude setup-token` en cualquier máquina y luego péguelo en OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Si generó el token en otro lugar, péguelo manualmente:

```bash
openclaw models auth paste-token --provider anthropic
```

Verifique:

```bash
openclaw models status
```

## Intercambio OAuth (cómo funciona el inicio de sesión)

Los flujos interactivos de inicio de sesión de OpenClaw están implementados en `@mariozechner/pi-ai` y conectados a los asistentes/comandos.

### Anthropic (Claude Pro/Max) setup-token

Forma del flujo:

1. ejecute `claude setup-token`
2. pegue el token en OpenClaw
3. almacénelo como un perfil de autenticación por token (sin actualización)

La ruta del asistente es `openclaw onboard` → opción de autenticación `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Forma del flujo (PKCE):

1. generar verificador/desafío PKCE + `state` aleatorio
2. abrir `https://auth.openai.com/oauth/authorize?...`
3. intentar capturar el callback en `http://127.0.0.1:1455/auth/callback`
4. si el callback no puede enlazarse (o está remoto/sin interfaz), pegar la URL/código de redirección
5. intercambiar en `https://auth.openai.com/oauth/token`
6. extraer `accountId` del token de acceso y almacenar `{ access, refresh, expires, accountId }`

La ruta del asistente es `openclaw onboard` → opción de autenticación `openai-codex`.

## Actualización + caducidad

Los perfiles almacenan una marca de tiempo `expires`.

En tiempo de ejecución:

- si `expires` está en el futuro → use el token de acceso almacenado
- si está caducado → actualice (bajo un bloqueo de archivo) y sobrescriba las credenciales almacenadas

El flujo de actualización es automático; por lo general no necesita gestionar los tokens manualmente.

## Múltiples cuentas (perfiles) + enrutamiento

Dos patrones:

### 1. Preferido: agentes separados

Si quiere que “personal” y “trabajo” nunca interactúen, use agentes aislados (sesiones + credenciales + espacio de trabajo separados):

```bash
openclaw agents add work
openclaw agents add personal
```

Luego configure la autenticación por agente (asistente) y enrute los chats al agente correcto.

### 2. Avanzado: múltiples perfiles en un solo agente

`auth-profiles.json` admite múltiples ID de perfil para el mismo proveedor.

Elija qué perfil se usa:

- globalmente mediante el orden de configuración (`auth.order`)
- por sesión mediante `/model ...@<profileId>`

Ejemplo (anulación por sesión):

- `/model Opus@anthropic:work`

Cómo ver qué ID de perfil existen:

- `openclaw channels list --json` (muestra `auth[]`)

Documentación relacionada:

- [/concepts/model-failover](/concepts/model-failover) (reglas de rotación + enfriamiento)
- [/tools/slash-commands](/tools/slash-commands) (superficie de comandos)
