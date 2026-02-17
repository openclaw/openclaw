---
summary: "Ejecutar OpenClaw en una VM macOS sandboxed (local o alojada) cuando necesitas aislamiento o iMessage"
read_when:
  - Quieres OpenClaw aislado de tu entorno macOS principal
  - Quieres integración de iMessage (BlueBubbles) en un sandbox
  - Quieres un entorno macOS reiniciable que puedes clonar
  - Quieres comparar opciones de VM macOS local vs alojada
title: "VMs macOS"
---

# OpenClaw en VMs macOS (Sandboxing)

## Predeterminado recomendado (mayoría de usuarios)

- **VPS Linux pequeño** para un Gateway siempre activo y bajo costo. Consulta [Alojamiento VPS](/es-ES/vps).
- **Hardware dedicado** (Mac mini o caja Linux) si quieres control total y una **IP residencial** para automatización de navegador. Muchos sitios bloquean IPs de centros de datos, así que la navegación local suele funcionar mejor.
- **Híbrido:** mantén el Gateway en un VPS económico, y conecta tu Mac como un **nodo** cuando necesites automatización de navegador/UI. Consulta [Nodos](/es-ES/nodes) y [Gateway remoto](/es-ES/gateway/remote).

Usa una VM macOS cuando necesites específicamente capacidades solo-macOS (iMessage/BlueBubbles) o quieras aislamiento estricto de tu Mac diario.

## Opciones de VM macOS

### VM local en tu Mac Apple Silicon (Lume)

Ejecuta OpenClaw en una VM macOS sandboxed en tu Mac Apple Silicon existente usando [Lume](https://cua.ai/docs/lume).

Esto te da:

- Entorno macOS completo en aislamiento (tu host permanece limpio)
- Soporte iMessage vía BlueBubbles (imposible en Linux/Windows)
- Reinicio instantáneo clonando VMs
- Sin hardware extra o costos de nube

### Proveedores de Mac alojados (nube)

Si quieres macOS en la nube, los proveedores de Mac alojados también funcionan:

- [MacStadium](https://www.macstadium.com/) (Macs alojados)
- Otros proveedores de Mac alojados también funcionan; sigue sus docs de VM + SSH

Una vez que tengas acceso SSH a una VM macOS, continúa en el paso 6 a continuación.

---

## Ruta rápida (Lume, usuarios experimentados)

1. Instalar Lume
2. `lume create openclaw --os macos --ipsw latest`
3. Completar Setup Assistant, habilitar Remote Login (SSH)
4. `lume run openclaw --no-display`
5. SSH, instalar OpenClaw, configurar canales
6. Listo

---

## Lo que necesitas (Lume)

- Mac Apple Silicon (M1/M2/M3/M4)
- macOS Sequoia o posterior en el host
- ~60 GB de espacio libre en disco por VM
- ~20 minutos

---

## 1) Instalar Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Si `~/.local/bin` no está en tu PATH:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Verifica:

```bash
lume --version
```

Docs: [Instalación de Lume](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2) Crear la VM macOS

```bash
lume create openclaw --os macos --ipsw latest
```

Esto descarga macOS y crea la VM. Una ventana VNC se abre automáticamente.

Nota: La descarga puede tomar un tiempo dependiendo de tu conexión.

---

## 3) Completar Setup Assistant

En la ventana VNC:

1. Selecciona idioma y región
2. Omite Apple ID (o inicia sesión si quieres iMessage después)
3. Crea una cuenta de usuario (recuerda el nombre de usuario y contraseña)
4. Omite todas las características opcionales

Después de que se complete la configuración, habilita SSH:

1. Abre Ajustes del Sistema → General → Compartir
2. Habilita "Remote Login"

---

## 4) Obtener la dirección IP de la VM

```bash
lume get openclaw
```

Busca la dirección IP (usualmente `192.168.64.x`).

---

## 5) SSH a la VM

```bash
ssh tuusuario@192.168.64.X
```

Reemplaza `tuusuario` con la cuenta que creaste, y la IP con la IP de tu VM.

---

## 6) Instalar OpenClaw

Dentro de la VM:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Sigue los prompts de onboarding para configurar tu proveedor de modelo (Anthropic, OpenAI, etc.).

---

## 7) Configurar canales

Edita el archivo de configuración:

```bash
nano ~/.openclaw/openclaw.json
```

Agrega tus canales:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "TU_BOT_TOKEN"
    }
  }
}
```

Luego inicia sesión en WhatsApp (escanea QR):

```bash
openclaw channels login
```

---

## 8) Ejecutar la VM sin cabeza

Detén la VM y reinicia sin display:

```bash
lume stop openclaw
lume run openclaw --no-display
```

La VM se ejecuta en segundo plano. El daemon de OpenClaw mantiene el gateway ejecutándose.

Para verificar estado:

```bash
ssh tuusuario@192.168.64.X "openclaw status"
```

---

## Bonus: integración de iMessage

Esta es la característica estrella de ejecutar en macOS. Usa [BlueBubbles](https://bluebubbles.app) para agregar iMessage a OpenClaw.

Dentro de la VM:

1. Descarga BlueBubbles desde bluebubbles.app
2. Inicia sesión con tu Apple ID
3. Habilita la Web API y establece una contraseña
4. Apunta los webhooks de BlueBubbles a tu gateway (ejemplo: `https://tu-host-gateway:3000/bluebubbles-webhook?password=<password>`)

Agrega a tu configuración de OpenClaw:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "tu-contraseña-api",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

Reinicia el gateway. Ahora tu agente puede enviar y recibir iMessages.

Detalles completos de configuración: [Canal BlueBubbles](/es-ES/channels/bluebubbles)

---

## Guardar una imagen dorada

Antes de personalizar más, toma una instantánea de tu estado limpio:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Reinicia en cualquier momento:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## Ejecutar 24/7

Mantén la VM ejecutándose:

- Manteniendo tu Mac conectado
- Deshabilitando el suspender en Ajustes del Sistema → Energy Saver
- Usando `caffeinate` si es necesario

Para verdadero siempre activo, considera un Mac mini dedicado o un VPS pequeño. Consulta [Alojamiento VPS](/es-ES/vps).

---

## Resolución de problemas

| Problema                     | Solución                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| No puedo hacer SSH a la VM   | Verifica que "Remote Login" esté habilitado en los Ajustes del Sistema de la VM        |
| IP de VM no se muestra       | Espera a que la VM arranque completamente, ejecuta `lume get openclaw` de nuevo        |
| Comando Lume no encontrado   | Agrega `~/.local/bin` a tu PATH                                                         |
| QR de WhatsApp no escanea    | Asegúrate de estar conectado a la VM (no host) cuando ejecutes `openclaw channels login` |

---

## Docs relacionados

- [Alojamiento VPS](/es-ES/vps)
- [Nodos](/es-ES/nodes)
- [Gateway remoto](/es-ES/gateway/remote)
- [Canal BlueBubbles](/es-ES/channels/bluebubbles)
- [Inicio Rápido Lume](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Referencia CLI de Lume](https://cua.ai/docs/lume/reference/cli-reference)
- [Configuración de VM Desatendida](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (avanzado)
- [Sandboxing con Docker](/es-ES/install/docker) (enfoque de aislamiento alternativo)
