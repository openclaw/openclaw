---
summary: "Flujo de la app de macOS para controlar un Gateway de OpenClaw remoto a través de SSH"
read_when:
  - Configuración o depuración del control remoto de mac en macOS
title: "Control remoto"
---

# OpenClaw remoto (macOS ⇄ host remoto)

Este flujo permite que la app de macOS actúe como un control remoto completo para un Gateway de OpenClaw que se ejecuta en otro host (escritorio/servidor). Es la función de la app **Remote over SSH** (ejecución remota). Todas las funciones—comprobaciones de estado, reenvío de Voice Wake y Web Chat—reutilizan la misma configuración SSH remota desde _Settings → General_.

## Modos

- **Local (this Mac)**: Todo se ejecuta en la laptop. No hay SSH.
- **Remote over SSH (default)**: Los comandos de OpenClaw se ejecutan en el host remoto. La app de mac abre una conexión SSH con `-o BatchMode` más la identidad/clave elegida y un reenvío de puertos local.
- **Remote direct (ws/wss)**: Sin túnel SSH. La app de mac se conecta directamente a la URL del Gateway (por ejemplo, vía Tailscale Serve o un proxy inverso HTTPS público).

## Transportes remotos

El modo remoto admite dos transportes:

- **SSH tunnel** (predeterminado): Usa `ssh -N -L ...` para reenviar el puerto del Gateway a localhost. El Gateway verá la IP del nodo como `127.0.0.1` porque el túnel es de loopback.
- **Direct (ws/wss)**: Se conecta directamente a la URL del Gateway. El Gateway ve la IP real del cliente.

## Prerrequisitos en el host remoto

1. Instale Node + pnpm y construya/instale la CLI de OpenClaw (`pnpm install && pnpm build && pnpm link --global`).
2. Asegúrese de que `openclaw` esté en PATH para shells no interactivos (haga un symlink en `/usr/local/bin` o `/opt/homebrew/bin` si es necesario).
3. Abra SSH con autenticación por clave. Recomendamos IPs de **Tailscale** para una conectividad estable fuera de la LAN.

## Configuración de la app de macOS

1. Abra _Settings → General_.
2. En **OpenClaw runs**, elija **Remote over SSH** y configure:
   - **Transport**: **SSH tunnel** o **Direct (ws/wss)**.
   - **SSH target**: `user@host` (`:port` opcional).
     - Si el Gateway está en la misma LAN y anuncia Bonjour, selecciónelo de la lista descubierta para autocompletar este campo.
   - **Gateway URL** (solo Direct): `wss://gateway.example.ts.net` (o `ws://...` para local/LAN).
   - **Identity file** (avanzado): ruta a su clave.
   - **Project root** (avanzado): ruta del checkout remoto usada para los comandos.
   - **CLI path** (avanzado): ruta opcional a un entrypoint/binario ejecutable de `openclaw` (se completa automáticamente cuando se anuncia).
3. Haga clic en **Test remote**. El éxito indica que el `openclaw status --json` remoto se ejecuta correctamente. Los fallos suelen indicar problemas de PATH/CLI; el código 127 significa que la CLI no se encuentra de forma remota.
4. Las comprobaciones de estado y Web Chat ahora se ejecutarán automáticamente a través de este túnel SSH.

## Web Chat

- **SSH tunnel**: Web Chat se conecta al Gateway a través del puerto de control WebSocket reenviado (predeterminado 18789).
- **Direct (ws/wss)**: Web Chat se conecta directamente a la URL del Gateway configurada.
- Ya no existe un servidor HTTP separado de WebChat.

## Permisos

- El host remoto necesita las mismas aprobaciones TCC que el local (Automatización, Accesibilidad, Grabación de pantalla, Micrófono, Reconocimiento de voz, Notificaciones). Ejecute el onboarding en esa máquina para concederlos una vez.
- Los nodos anuncian su estado de permisos mediante `node.list` / `node.describe` para que los agentes sepan qué está disponible.

## Notas de seguridad

- Prefiera enlaces a loopback en el host remoto y conéctese vía SSH o Tailscale.
- Si vincula el Gateway a una interfaz que no sea loopback, exija autenticación por token/contraseña.
- Consulte [Security](/gateway/security) y [Tailscale](/gateway/tailscale).

## Flujo de inicio de sesión de WhatsApp (remoto)

- Ejecute `openclaw channels login --verbose` **en el host remoto**. Escanee el QR con WhatsApp en su teléfono.
- Vuelva a ejecutar el inicio de sesión en ese host si la autenticación expira. La comprobación de estado mostrará problemas de enlace.

## Solución de problemas

- **exit 127 / not found**: `openclaw` no está en PATH para shells sin inicio de sesión. Añádalo a `/etc/paths`, a su rc del shell, o haga un symlink en `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: verifique la conectividad SSH, PATH y que Baileys haya iniciado sesión (`openclaw status --json`).
- **Web Chat stuck**: confirme que el Gateway se esté ejecutando en el host remoto y que el puerto reenviado coincida con el puerto WS del Gateway; la UI requiere una conexión WS saludable.
- **Node IP shows 127.0.0.1**: es esperado con el túnel SSH. Cambie **Transport** a **Direct (ws/wss)** si desea que el Gateway vea la IP real del cliente.
- **Voice Wake**: las frases de activación se reenvían automáticamente en modo remoto; no se necesita un reenviador separado.

## Sonidos de notificación

Elija sonidos por notificación desde scripts con `openclaw` y `node.invoke`, por ejemplo:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Ya no existe un interruptor global de “sonido predeterminado” en la app; quienes llaman eligen un sonido (o ninguno) por solicitud.
