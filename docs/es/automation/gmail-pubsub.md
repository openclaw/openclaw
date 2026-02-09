---
summary: "Push de Gmail Pub/Sub conectado a webhooks de OpenClaw mediante gogcli"
read_when:
  - Conectar disparadores de la bandeja de entrada de Gmail a OpenClaw
  - Configurar push de Pub/Sub para despertar al agente
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

Objetivo: vigilancia de Gmail -> push de Pub/Sub -> `gog gmail watch serve` -> webhook de OpenClaw.

## Prereqs

- `gcloud` instalado e iniciado sesión ([guía de instalación](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) instalado y autorizado para la cuenta de Gmail ([gogcli.sh](https://gogcli.sh/)).
- Hooks de OpenClaw habilitados (ver [Webhooks](/automation/webhook)).
- `tailscale` con sesión iniciada ([tailscale.com](https://tailscale.com/)). La configuración compatible usa Tailscale Funnel para el endpoint HTTPS público.
  Otros servicios de túnel pueden funcionar, pero son DIY/no compatibles y requieren cableado manual.
  Por ahora, Tailscale es lo que admitimos.

Ejemplo de configuración de hook (habilitar el mapeo preestablecido de Gmail):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

Para entregar el resumen de Gmail a una superficie de chat, sobrescriba el preajuste con un mapeo
que establezca `deliver` + opcional `channel`/`to`:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

Si desea un canal fijo, establezca `channel` + `to`. De lo contrario, `channel: "last"`
usa la última ruta de entrega (vuelve a WhatsApp).

Para forzar un modelo más económico para ejecuciones de Gmail, establezca `model` en el mapeo
(`provider/model` o alias). Si impone `agents.defaults.models`, inclúyalo allí.

Para establecer un modelo predeterminado y un nivel de razonamiento específicamente para hooks de Gmail, agregue
`hooks.gmail.model` / `hooks.gmail.thinking` en su configuración:

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

Notas:

- `model`/`thinking` por hook en el mapeo aún sobrescribe estos valores predeterminados.
- Orden de respaldo: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → primario (auth/límites de tasa/timeouts).
- Si se establece `agents.defaults.models`, el modelo de Gmail debe estar en la lista de permitidos.
- El contenido del hook de Gmail se envuelve con límites de seguridad de contenido externo de forma predeterminada.
  Para desactivar (peligroso), establezca `hooks.gmail.allowUnsafeExternalContent: true`.

Para personalizar aún más el manejo del payload, agregue `hooks.mappings` o un módulo de transformación JS/TS
bajo `hooks.transformsDir` (ver [Webhooks](/automation/webhook)).

## Asistente (recomendado)

Use el asistente de OpenClaw para conectar todo (instala dependencias en macOS vía brew):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Valores predeterminados:

- Usa Tailscale Funnel para el endpoint público de push.
- Escribe la configuración `hooks.gmail` para `openclaw webhooks gmail run`.
- Habilita el preajuste del hook de Gmail (`hooks.presets: ["gmail"]`).

Nota de ruta: cuando `tailscale.mode` está habilitado, OpenClaw establece automáticamente
`hooks.gmail.serve.path` en `/` y mantiene la ruta pública en
`hooks.gmail.tailscale.path` (predeterminado `/gmail-pubsub`) porque Tailscale
elimina el prefijo set-path antes de hacer proxy.
Si necesita que el backend reciba la ruta con prefijo, establezca
`hooks.gmail.tailscale.target` (o `--tailscale-target`) en una URL completa como
`http://127.0.0.1:8788/gmail-pubsub` y haga coincidir `hooks.gmail.serve.path`.

¿Quiere un endpoint personalizado? Use `--push-endpoint <url>` o `--tailscale off`.

Nota de plataforma: en macOS el asistente instala `gcloud`, `gogcli` y `tailscale`
mediante Homebrew; en Linux instálelos manualmente primero.

Inicio automático del Gateway (recomendado):

- Cuando se establecen `hooks.enabled=true` y `hooks.gmail.account`, el Gateway inicia
  `gog gmail watch serve` al arrancar y renueva automáticamente la vigilancia.
- Establezca `OPENCLAW_SKIP_GMAIL_WATCHER=1` para excluirse (útil si ejecuta el daemon usted mismo).
- No ejecute el daemon manual al mismo tiempo, o se encontrará con
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

Daemon manual (inicia `gog gmail watch serve` + renovación automática):

```bash
openclaw webhooks gmail run
```

## Configuración única

1. Seleccione el proyecto de GCP **que es propietario del cliente OAuth** usado por `gog`.

```bash
gcloud auth login
gcloud config set project <project-id>
```

Nota: la vigilancia de Gmail requiere que el tema de Pub/Sub exista en el mismo proyecto que el cliente OAuth.

2. Habilite las APIs:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Cree un tema:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Permita que el push de Gmail publique:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Iniciar la vigilancia

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Guarde el `history_id` de la salida (para depuración).

## Ejecutar el manejador de push

Ejemplo local (auth con token compartido):

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

Notas:

- `--token` protege el endpoint de push (`x-gog-token` o `?token=`).
- `--hook-url` apunta a OpenClaw `/hooks/gmail` (mapeado; ejecución aislada + resumen al principal).
- `--include-body` y `--max-bytes` controlan el fragmento del cuerpo enviado a OpenClaw.

Recomendado: `openclaw webhooks gmail run` envuelve el mismo flujo y renueva automáticamente la vigilancia.

## Exponer el manejador (avanzado, no compatible)

Si necesita un túnel que no sea Tailscale, conéctelo manualmente y use la URL pública en la suscripción de push
(no compatible, sin protecciones):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Use la URL generada como endpoint de push:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Producción: use un endpoint HTTPS estable y configure Pub/Sub OIDC JWT, luego ejecute:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Prueba

Envíe un mensaje a la bandeja de entrada vigilada:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Verifique el estado de la vigilancia y el historial:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## Solución de problemas

- `Invalid topicName`: discrepancia de proyecto (el tema no está en el proyecto del cliente OAuth).
- `User not authorized`: falta `roles/pubsub.publisher` en el tema.
- Mensajes vacíos: el push de Gmail solo proporciona `historyId`; obtenga los datos mediante `gog gmail history`.

## Limpieza

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
