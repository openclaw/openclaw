---
summary: "Flujo de la app de macOS para controlar un gateway remoto de OpenClaw sobre SSH"
read_when:
  - Configurando o depurando control remoto de Mac
title: "Control Remoto"
---

# OpenClaw Remoto (macOS ⇄ host remoto)

Este flujo permite que la app de macOS actúe como un control remoto completo para un gateway de OpenClaw ejecutándose en otro host (escritorio/servidor). Es la función **Remote over SSH** (ejecución remota) de la app. Todas las características—verificaciones de salud, reenvío de Voice Wake y Web Chat—reutilizan la misma configuración remota SSH desde _Settings → General_.

## Modos

- **Local (this Mac)**: Todo se ejecuta en la laptop. No hay SSH involucrado.
- **Remote over SSH (predeterminado)**: Los comandos de OpenClaw se ejecutan en el host remoto. La app de Mac abre una conexión SSH con `-o BatchMode` más tu identidad/clave elegida y un port-forward local.
- **Remote direct (ws/wss)**: Sin túnel SSH. La app de Mac se conecta a la URL del gateway directamente (por ejemplo, vía Tailscale Serve o un proxy inverso HTTPS público).

## Transportes remotos

El modo remoto soporta dos transportes:

- **Túnel SSH** (predeterminado): Usa `ssh -N -L ...` para reenviar el puerto del gateway a localhost. El gateway verá la IP del nodo como `127.0.0.1` porque el túnel es loopback.
- **Direct (ws/wss)**: Se conecta directamente a la URL del gateway. El gateway ve la IP real del cliente.

## Prerrequisitos en el host remoto

1. Instalar Node + pnpm y construir/instalar el CLI de OpenClaw (`pnpm install && pnpm build && pnpm link --global`).
2. Asegurar que `openclaw` esté en PATH para shells no interactivos (enlace simbólico en `/usr/local/bin` o `/opt/homebrew/bin` si es necesario).
3. Abrir SSH con autenticación de clave. Recomendamos IPs de **Tailscale** para alcance estable fuera de LAN.

## Configuración de la app de macOS

1. Abre _Settings → General_.
2. Bajo **OpenClaw runs**, elige **Remote over SSH** y establece:
   - **Transport**: **SSH tunnel** o **Direct (ws/wss)**.
   - **SSH target**: `user@host` (`:port` opcional).
     - Si el gateway está en la misma LAN y anuncia Bonjour, selecciónalo de la lista descubierta para autocompletar este campo.
   - **Gateway URL** (Direct solamente): `wss://gateway.example.ts.net` (o `ws://...` para local/LAN).
   - **Identity file** (avanzado): ruta a tu clave.
   - **Project root** (avanzado): ruta de checkout remoto usada para comandos.
   - **CLI path** (avanzado): ruta opcional a un punto de entrada/binario `openclaw` ejecutable (autocompletado cuando se anuncia).
3. Presiona **Test remote**. El éxito indica que el `openclaw status --json` remoto se ejecuta correctamente. Los fallos generalmente significan problemas de PATH/CLI; exit 127 significa que el CLI no se encuentra remotamente.
4. Las verificaciones de salud y Web Chat ahora se ejecutarán a través de este túnel SSH automáticamente.

## Web Chat

- **Túnel SSH**: Web Chat se conecta al gateway sobre el puerto WebSocket de control reenviado (predeterminado 18789).
- **Direct (ws/wss)**: Web Chat se conecta directamente a la URL del gateway configurada.
- Ya no hay un servidor HTTP de WebChat separado.

## Permisos

- El host remoto necesita las mismas aprobaciones TCC que local (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications). Ejecuta el onboarding en esa máquina para otorgarlos una vez.
- Los nodos anuncian su estado de permisos vía `node.list` / `node.describe` para que los agentes sepan qué está disponible.

## Notas de seguridad

- Prefiere binds de loopback en el host remoto y conéctate vía SSH o Tailscale.
- Si vinculas el Gateway a una interfaz que no es loopback, requiere autenticación de token/contraseña.
- Ve [Security](/es-ES/gateway/security) y [Tailscale](/es-ES/gateway/tailscale).

## Flujo de login de WhatsApp (remoto)

- Ejecuta `openclaw channels login --verbose` **en el host remoto**. Escanea el QR con WhatsApp en tu teléfono.
- Vuelve a ejecutar login en ese host si la autenticación expira. La verificación de salud revelará problemas de enlace.

## Solución de problemas

- **exit 127 / not found**: `openclaw` no está en PATH para shells no-login. Añádelo a `/etc/paths`, tu rc de shell, o enlace simbólico en `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: verifica alcance SSH, PATH, y que Baileys esté logueado (`openclaw status --json`).
- **Web Chat atascado**: confirma que el gateway esté ejecutándose en el host remoto y que el puerto reenviado coincida con el puerto WS del gateway; la UI requiere una conexión WS saludable.
- **Node IP muestra 127.0.0.1**: esperado con el túnel SSH. Cambia **Transport** a **Direct (ws/wss)** si deseas que el gateway vea la IP real del cliente.
- **Voice Wake**: las frases de activación se reenvían automáticamente en modo remoto; no se necesita un reenviador separado.

## Sonidos de notificación

Elige sonidos por notificación desde scripts con `openclaw` y `node.invoke`, ej.:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Ya no hay un toggle de "sonido predeterminado" global en la app; los llamantes eligen un sonido (o ninguno) por solicitud.
