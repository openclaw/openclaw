---
summary: "Ejecute OpenClaw Gateway 24/7 en una VM de GCP Compute Engine (Docker) con estado duradero"
read_when:
  - Quiere OpenClaw funcionando 24/7 en GCP
  - Quiere un Gateway siempre activo, de nivel producción, en su propia VM
  - Quiere control total sobre la persistencia, los binarios y el comportamiento de reinicio
title: "GCP"
---

# OpenClaw en GCP Compute Engine (Docker, Guía de VPS en producción)

## Objetivo

Ejecutar un OpenClaw Gateway persistente en una VM de GCP Compute Engine usando Docker, con estado duradero, binarios integrados y un comportamiento de reinicio seguro.

Si quiere “OpenClaw 24/7 por ~$5–12/mes”, esta es una configuración confiable en Google Cloud.
El precio varía según el tipo de máquina y la región; elija la VM más pequeña que se ajuste a su carga de trabajo y escale si encuentra OOM.

## ¿Qué estamos haciendo (en términos simples)?

- Crear un proyecto de GCP y habilitar la facturación
- Crear una VM de Compute Engine
- Instalar Docker (entorno de ejecución de aplicaciones aislado)
- Iniciar el OpenClaw Gateway en Docker
- Persistir `~/.openclaw` + `~/.openclaw/workspace` en el host (sobrevive reinicios/reconstrucciones)
- Acceder a la UI de Control desde su laptop mediante un túnel SSH

Se puede acceder al Gateway mediante:

- Reenvío de puertos SSH desde su laptop
- Exposición directa de puertos si usted gestiona el firewall y los tokens por su cuenta

Esta guía usa Debian en GCP Compute Engine.
Ubuntu también funciona; mapee los paquetes según corresponda.
Para el flujo genérico de Docker, vea [Docker](/install/docker).

---

## Ruta rápida (operadores con experiencia)

1. Crear proyecto de GCP + habilitar la API de Compute Engine
2. Crear VM de Compute Engine (e2-small, Debian 12, 20GB)
3. Conectarse por SSH a la VM
4. Instalar Docker
5. Clonar el repositorio de OpenClaw
6. Crear directorios persistentes en el host
7. Configurar `.env` y `docker-compose.yml`
8. Integrar los binarios requeridos, compilar y lanzar

---

## Lo que necesita

- Cuenta de GCP (elegible para el nivel gratuito con e2-micro)
- CLI de gcloud instalada (o usar Cloud Console)
- Acceso SSH desde su laptop
- Comodidad básica con SSH + copiar/pegar
- ~20–30 minutos
- Docker y Docker Compose
- Credenciales de autenticación del modelo
- Credenciales opcionales de proveedores
  - Código QR de WhatsApp
  - Token de bot de Telegram
  - OAuth de Gmail

---

## 1. Instalar la CLI de gcloud (o usar la Consola)

**Opción A: CLI de gcloud** (recomendado para automatización)

Instale desde [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Inicialice y autentique:

```bash
gcloud init
gcloud auth login
```

**Opción B: Cloud Console**

Todos los pasos se pueden realizar mediante la UI web en [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. Crear un proyecto de GCP

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Habilite la facturación en [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (requerido para Compute Engine).

Habilite la API de Compute Engine:

```bash
gcloud services enable compute.googleapis.com
```

**Consola:**

1. Vaya a IAM y administración > Crear proyecto
2. Asígnele un nombre y créelo
3. Habilite la facturación para el proyecto
4. Navegue a APIs y servicios > Habilitar APIs > busque “Compute Engine API” > Habilitar

---

## 3. Crear la VM

**Tipos de máquina:**

| Tipo     | Especificaciones                                | Costo                    | Notas                |
| -------- | ----------------------------------------------- | ------------------------ | -------------------- |
| e2-small | 2 vCPU, 2GB RAM                                 | ~$12/mes | Recomendado          |
| e2-micro | 2 vCPU (compartido), 1GB RAM | Elegible nivel gratuito  | Puede OOM bajo carga |

**CLI:**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Consola:**

1. Vaya a Compute Engine > Instancias de VM > Crear instancia
2. Nombre: `openclaw-gateway`
3. Región: `us-central1`, Zona: `us-central1-a`
4. Tipo de máquina: `e2-small`
5. Disco de arranque: Debian 12, 20GB
6. Crear

---

## 4. Conectarse por SSH a la VM

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Consola:**

Haga clic en el botón “SSH” junto a su VM en el panel de Compute Engine.

Nota: La propagación de claves SSH puede tardar 1–2 minutos después de crear la VM. Si la conexión es rechazada, espere y reintente.

---

## 5. Instalar Docker (en la VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Cierre sesión y vuelva a iniciarla para que el cambio de grupo tenga efecto:

```bash
exit
```

Luego conéctese por SSH nuevamente:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Verifique:

```bash
docker --version
docker compose version
```

---

## 6. Clonar el repositorio de OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Esta guía asume que usted compilará una imagen personalizada para garantizar la persistencia de los binarios.

---

## 7. Crear directorios persistentes en el host

Los contenedores Docker son efímeros.
Todo el estado de larga duración debe vivir en el host.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. Configurar variables de entorno

Cree `.env` en la raíz del repositorio.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Genere secretos fuertes:

```bash
openssl rand -hex 32
```

**No confirme este archivo en el repositorio.**

---

## 9. Configuración de Docker Compose

Cree o actualice `docker-compose.yml`.

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE}
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VM and need Canvas host.
      # If you expose this publicly, read /gateway/security and firewall accordingly.
      # - "18793:18793"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "${OPENCLAW_GATEWAY_PORT}",
      ]
```

---

## 10. Integrar los binarios requeridos en la imagen (crítico)

Instalar binarios dentro de un contenedor en ejecución es una trampa.
Cualquier cosa instalada en tiempo de ejecución se perderá al reiniciar.

Todos los binarios externos requeridos por las skills deben instalarse en el momento de compilar la imagen.

Los ejemplos a continuación muestran solo tres binarios comunes:

- `gog` para acceso a Gmail
- `goplaces` para Google Places
- `wacli` para WhatsApp

Estos son ejemplos, no una lista completa.
Puede instalar tantos binarios como necesite usando el mismo patrón.

Si agrega nuevas skills más adelante que dependan de binarios adicionales, debe:

1. Actualizar el Dockerfile
2. Reconstruir la imagen
3. Reiniciar los contenedores

**Dockerfile de ejemplo**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

---

## 11. Compilar y lanzar

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Verifique los binarios:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Salida esperada:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 12. Verificar el Gateway

```bash
docker compose logs -f openclaw-gateway
```

Éxito:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. Acceder desde su laptop

Cree un túnel SSH para reenviar el puerto del Gateway:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Abra en su navegador:

`http://127.0.0.1:18789/`

Pegue su token del gateway.

---

## Qué persiste y dónde (fuente de la verdad)

OpenClaw se ejecuta en Docker, pero Docker no es la fuente de la verdad.
Todo el estado de larga duración debe sobrevivir a reinicios, reconstrucciones y reinicios del sistema.

| Componente                           | Ubicación                          | Mecanismo de persistencia     | Notas                                       |
| ------------------------------------ | ---------------------------------- | ----------------------------- | ------------------------------------------- |
| Configuración del Gateway            | `/home/node/.openclaw/`            | Montaje de volumen del host   | Incluye `openclaw.json`, tokens             |
| Perfiles de autenticación del modelo | `/home/node/.openclaw/`            | Montaje de volumen del host   | Tokens OAuth, claves de API                 |
| Configuraciones de skills            | `/home/node/.openclaw/skills/`     | Montaje de volumen del host   | Estado a nivel de skill                     |
| Espacio de trabajo del agente        | `/home/node/.openclaw/workspace/`  | Montaje de volumen del host   | Código y artefactos del agente              |
| Sesión de WhatsApp                   | `/home/node/.openclaw/`            | Montaje de volumen del host   | Conserva el inicio de sesión por QR         |
| Llavero de Gmail                     | `/home/node/.openclaw/`            | Volumen del host + contraseña | Requiere `GOG_KEYRING_PASSWORD`             |
| Binarios externos                    | `/usr/local/bin/`                  | Imagen Docker                 | Debe ser horneado en tiempo de construcción |
| Runtime de Node                      | Sistema de archivos del contenedor | Imagen Docker                 | Se reconstruye en cada compilación          |
| Paquetes del SO                      | Sistema de archivos del contenedor | Imagen Docker                 | No instalar en tiempo de ejecución          |
| Contenedor Docker                    | Efímero                            | Reiniciable                   | Seguro de destruir                          |

---

## Actualizaciones

Para actualizar OpenClaw en la VM:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Solución de problemas

**Conexión SSH rechazada**

La propagación de claves SSH puede tardar 1–2 minutos después de crear la VM. Espere y reintente.

**Problemas de OS Login**

Revise su perfil de OS Login:

```bash
gcloud compute os-login describe-profile
```

Asegúrese de que su cuenta tenga los permisos de IAM requeridos (Compute OS Login o Compute OS Admin Login).

**Falta de memoria (OOM)**

Si usa e2-micro y encuentra OOM, actualice a e2-small o e2-medium:

```bash
# Stop the VM first
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## Cuentas de servicio (mejor práctica de seguridad)

Para uso personal, su cuenta de usuario predeterminada funciona bien.

Para automatización o pipelines de CI/CD, cree una cuenta de servicio dedicada con permisos mínimos:

1. Cree una cuenta de servicio:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Otorgue el rol de Administrador de instancias de Compute (o un rol personalizado más restrictivo):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Evite usar el rol Owner para automatización. Use el principio de mínimo privilegio.

Vea [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) para detalles sobre roles de IAM.

---

## Siguientes pasos

- Configure canales de mensajería: [Channels](/channels)
- Empareje dispositivos locales como nodos: [Nodes](/nodes)
- Configure el Gateway: [Gateway configuration](/gateway/configuration)
