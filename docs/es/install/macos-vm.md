---
summary: "Ejecute OpenClaw en una VM de macOS en sandbox (local u hospedada) cuando necesite aislamiento o iMessage"
read_when:
  - Desea OpenClaw aislado de su entorno principal de macOS
  - Desea integración con iMessage (BlueBubbles) en un sandbox
  - Desea un entorno de macOS reiniciable que pueda clonar
  - Desea comparar opciones de VM de macOS locales vs hospedadas
title: "VMs de macOS"
---

# OpenClaw en VMs de macOS (Sandboxing)

## Valor predeterminado recomendado (la mayoría de los usuarios)

- **VPS Linux pequeño** para un Gateway siempre activo y de bajo costo. Vea [VPS hosting](/vps).
- **Hardware dedicado** (Mac mini o equipo Linux) si desea control total y una **IP residencial** para automatización de navegador. Muchos sitios bloquean IPs de centros de datos, por lo que la navegación local suele funcionar mejor.
- **Híbrido:** mantenga el Gateway en un VPS económico y conecte su Mac como **nodo** cuando necesite automatización de navegador/UI. Vea [Nodes](/nodes) y [Gateway remote](/gateway/remote).

Use una VM de macOS cuando necesite específicamente capacidades exclusivas de macOS (iMessage/BlueBubbles) o quiera un aislamiento estricto de su Mac diario.

## Opciones de VM de macOS

### VM local en su Mac Apple Silicon (Lume)

Ejecute OpenClaw en una VM de macOS en sandbox en su Mac Apple Silicon existente usando [Lume](https://cua.ai/docs/lume).

Esto le ofrece:

- Entorno completo de macOS en aislamiento (su host se mantiene limpio)
- Soporte de iMessage vía BlueBubbles (imposible en Linux/Windows)
- Restablecimiento instantáneo clonando VMs
- Sin hardware adicional ni costos de nube

### Proveedores de Mac hospedados (nube)

Si desea macOS en la nube, los proveedores de Mac hospedados también funcionan:

- [MacStadium](https://www.macstadium.com/) (Macs hospedados)
- Otros proveedores de Mac hospedados también funcionan; siga su documentación de VM + SSH

Una vez que tenga acceso SSH a una VM de macOS, continúe en el paso 6 a continuación.

---

## Ruta rápida (Lume, usuarios experimentados)

1. Instale Lume
2. `lume create openclaw --os macos --ipsw latest`
3. Complete el Asistente de configuración, habilite Remote Login (SSH)
4. `lume run openclaw --no-display`
5. Acceda por SSH, instale OpenClaw, configure canales
6. Listo

---

## Lo que necesita (Lume)

- Mac Apple Silicon (M1/M2/M3/M4)
- macOS Sequoia o posterior en el host
- ~60 GB de espacio libre en disco por VM
- ~20 minutos

---

## 1. Instalar Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Si `~/.local/bin` no está en su PATH:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Verifique:

```bash
lume --version
```

Documentación: [Instalación de Lume](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. Crear la VM de macOS

```bash
lume create openclaw --os macos --ipsw latest
```

Esto descarga macOS y crea la VM. Se abre automáticamente una ventana VNC.

Nota: La descarga puede tardar un tiempo según su conexión.

---

## 3. Completar el Asistente de configuración

En la ventana VNC:

1. Seleccione idioma y región
2. Omita el Apple ID (o inicie sesión si desea iMessage más adelante)
3. Cree una cuenta de usuario (recuerde el nombre de usuario y la contraseña)
4. Omita todas las funciones opcionales

Después de completar la configuración, habilite SSH:

1. Abra System Settings → General → Sharing
2. Habilite "Remote Login"

---

## 4. Obtener la dirección IP de la VM

```bash
lume get openclaw
```

Busque la dirección IP (generalmente `192.168.64.x`).

---

## 5. Acceder por SSH a la VM

```bash
ssh youruser@192.168.64.X
```

Reemplace `youruser` con la cuenta que creó y la IP con la IP de su VM.

---

## 6. Instalar OpenClaw

Dentro de la VM:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Siga las indicaciones de incorporación para configurar su proveedor de modelos (Anthropic, OpenAI, etc.).

---

## 7. Configurar canales

Edite el archivo de configuración:

```bash
nano ~/.openclaw/openclaw.json
```

Agregue sus canales:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

Luego inicie sesión en WhatsApp (escanee el QR):

```bash
openclaw channels login
```

---

## 8. Ejecutar la VM sin interfaz (headless)

Detenga la VM y reiníciela sin pantalla:

```bash
lume stop openclaw
lume run openclaw --no-display
```

La VM se ejecuta en segundo plano. El daemon de OpenClaw mantiene el Gateway en funcionamiento.

Para verificar el estado:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Bonus: integración con iMessage

Esta es la característica clave de ejecutar en macOS. Use [BlueBubbles](https://bluebubbles.app) para agregar iMessage a OpenClaw.

Dentro de la VM:

1. Descargue BlueBubbles desde bluebubbles.app
2. Inicie sesión con su Apple ID
3. Habilite la Web API y establezca una contraseña
4. Apunte los webhooks de BlueBubbles a su gateway (ejemplo: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

Agregue a su configuración de OpenClaw:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

Reinicie el gateway. Ahora su agente puede enviar y recibir iMessages.

Detalles completos de configuración: [BlueBubbles channel](/channels/bluebubbles)

---

## Guardar una imagen dorada

Antes de personalizar más, haga una instantánea de su estado limpio:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Restablecer en cualquier momento:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## Ejecutando 24/7

Mantenga la VM en ejecución mediante:

- Mantener su Mac conectado a la corriente
- Deshabilitar el reposo en System Settings → Energy Saver
- Usar `caffeinate` si es necesario

Para un funcionamiento realmente siempre activo, considere un Mac mini dedicado o un VPS pequeño. Vea [VPS hosting](/vps).

---

## Solución de problemas

| Problema                         | Solución                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No puede acceder por SSH a la VM | Verifique que "Remote Login" esté habilitado en System Settings de la VM                                             |
| La IP de la VM no aparece        | Espere a que la VM termine de arrancar, ejecute `lume get openclaw` nuevamente                                       |
| Comando Lume no encontrado       | Agregue `~/.local/bin` a su PATH                                                                                     |
| El QR de WhatsApp no escanea     | Asegúrese de haber iniciado sesión en la VM (no en el host) al ejecutar `openclaw channels login` |

---

## Documentos relacionados

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (avanzado)
- [Docker Sandboxing](/install/docker) (enfoque alternativo de aislamiento)
