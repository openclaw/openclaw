---
summary: "Ejecutar OpenClaw Gateway 24/7 en una VM de GCP Compute Engine (Docker) con estado duradero"
read_when:
  - Quieres OpenClaw ejecutándose 24/7 en GCP
  - Quieres un Gateway de grado producción, siempre activo en tu propia VM
  - Quieres control total sobre persistencia, binarios y comportamiento de reinicio
title: "GCP"
---

# OpenClaw en GCP Compute Engine (Docker, Guía VPS de Producción)

## Objetivo

Ejecutar un OpenClaw Gateway persistente en una VM de GCP Compute Engine usando Docker, con estado duradero, binarios integrados y comportamiento de reinicio seguro.

Si quieres "OpenClaw 24/7 por ~$5-12/mes", esta es una configuración confiable en Google Cloud.
Los precios varían según el tipo de máquina y la región; elige la VM más pequeña que se ajuste a tu carga de trabajo y escala si encuentras OOMs.

## ¿Qué estamos haciendo (en términos simples)?

- Crear un proyecto GCP y habilitar facturación
- Crear una VM de Compute Engine
- Instalar Docker (runtime de aplicación aislada)
- Iniciar el OpenClaw Gateway en Docker
- Persistir `~/.openclaw` + `~/.openclaw/workspace` en el host (sobrevive a reinicios/reconstrucciones)
- Acceder a la UI de Control desde tu laptop vía túnel SSH

Se puede acceder al Gateway vía:

- Reenvío de puerto SSH desde tu laptop
- Exposición directa de puerto si administras firewall y tokens tú mismo

Esta guía usa Debian en GCP Compute Engine.
Ubuntu también funciona; mapea los paquetes correspondientes.
Para el flujo Docker genérico, consulta [Docker](/es-ES/install/docker).

---

## Ruta rápida (operadores experimentados)

1. Crear proyecto GCP + habilitar API de Compute Engine
2. Crear VM de Compute Engine (e2-small, Debian 12, 20GB)
3. SSH a la VM
4. Instalar Docker
5. Clonar repositorio OpenClaw
6. Crear directorios persistentes en el host
7. Configurar `.env` y `docker-compose.yml`
8. Integrar binarios requeridos, construir y lanzar

---

## Lo que necesitas

- Cuenta GCP (tier gratuito elegible para e2-micro)
- gcloud CLI instalado (o usar Cloud Console)
- Acceso SSH desde tu laptop
- Comodidad básica con SSH + copiar/pegar
- ~20-30 minutos
- Docker y Docker Compose
- Credenciales de autenticación de modelo
- Credenciales de proveedor opcionales
  - QR de WhatsApp
  - Token de bot de Telegram
  - OAuth de Gmail

---

## 1) Instalar gcloud CLI (o usar Console)

**Opción A: gcloud CLI** (recomendado para automatización)

Instala desde [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Inicializa y autentica:

```bash
gcloud init
gcloud auth login
```

**Opción B: Cloud Console**

Todos los pasos se pueden hacer vía la UI web en [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2) Crear un proyecto GCP

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Habilita facturación en [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (requerido para Compute Engine).

Habilita la API de Compute Engine:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. Ve a IAM & Admin > Create Project
2. Nómbralo y créalo
3. Habilita facturación para el proyecto
4. Navega a APIs & Services > Enable APIs > busca "Compute Engine API" > Enable

---

## 3) Crear la VM

**Tipos de máquina:**

| Tipo     | Especificaciones             | Costo                  | Notas                      |
| -------- | ---------------------------- | ---------------------- | -------------------------- |
| e2-small | 2 vCPU, 2GB RAM              | ~$12/mes               | Recomendado                |
| e2-micro | 2 vCPU (compartido), 1GB RAM | Elegible tier gratuito | Puede tener OOM bajo carga |

**CLI:**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Console:**

1. Ve a Compute Engine > VM instances > Create instance
2. Name: `openclaw-gateway`
3. Region: `us-central1`, Zone: `us-central1-a`
4. Machine type: `e2-small`
5. Boot disk: Debian 12, 20GB
6. Create

---

## 4) SSH a la VM

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

Haz clic en el botón "SSH" junto a tu VM en el panel de Compute Engine.

Nota: La propagación de claves SSH puede tomar 1-2 minutos después de la creación de la VM. Si la conexión es rechazada, espera y reintenta.

---

## 5) Instalar Docker (en la VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Cierra sesión y vuelve a entrar para que el cambio de grupo tome efecto:

```bash
exit
```

Luego vuelve a hacer SSH:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Verifica:

```bash
docker --version
docker compose version
```

---

## 6) Clonar el repositorio OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Esta guía asume que construirás una imagen personalizada para garantizar persistencia de binarios.

---

## 7) Crear directorios persistentes en el host

Los contenedores Docker son efímeros.
Todo el estado de larga duración debe vivir en el host.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8) Configurar variables de entorno

Crea `.env` en la raíz del repositorio.

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

Genera secretos fuertes:

```bash
openssl rand -hex 32
```

**No hagas commit de este archivo.**

---

## 9) Configuración de Docker Compose

Crea o actualiza `docker-compose.yml`.

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
      # Recomendado: mantén el Gateway solo-loopback en la VM; accede vía túnel SSH.
      # Para exponerlo públicamente, elimina el prefijo `127.0.0.1:` y configura firewall apropiadamente.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"
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

## 10) Integrar binarios requeridos en la imagen (crítico)

Instalar binarios dentro de un contenedor en ejecución es una trampa.
Cualquier cosa instalada en tiempo de ejecución se perderá al reiniciar.

Todos los binarios externos requeridos por skills deben instalarse en tiempo de construcción de imagen.

Los ejemplos a continuación muestran solo tres binarios comunes:

- `gog` para acceso a Gmail
- `goplaces` para Google Places
- `wacli` para WhatsApp

Estos son ejemplos, no una lista completa.
Puedes instalar tantos binarios como necesites usando el mismo patrón.

Si agregas nuevos skills más tarde que dependen de binarios adicionales, debes:

1. Actualizar el Dockerfile
2. Reconstruir la imagen
3. Reiniciar los contenedores

**Ejemplo de Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Ejemplo binario 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Ejemplo binario 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Ejemplo binario 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Agrega más binarios abajo usando el mismo patrón

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

## 11) Construir y lanzar

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Verifica binarios:

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

## 12) Verificar Gateway

```bash
docker compose logs -f openclaw-gateway
```

Éxito:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13) Acceder desde tu laptop

Crea un túnel SSH para reenviar el puerto del Gateway:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Abre en tu navegador:

`http://127.0.0.1:18789/`

Pega tu token del gateway.

---

## Qué persiste dónde (fuente de verdad)

OpenClaw se ejecuta en Docker, pero Docker no es la fuente de verdad.
Todo el estado de larga duración debe sobrevivir a reinicios, reconstrucciones y reinicios del sistema.

| Componente                          | Ubicación                          | Mecanismo de persistencia            | Notas                                      |
| ----------------------------------- | ---------------------------------- | ------------------------------------ | ------------------------------------------ |
| Configuración del Gateway           | `/home/node/.openclaw/`            | Montaje de volumen host              | Incluye `openclaw.json`, tokens            |
| Perfiles de autenticación de modelo | `/home/node/.openclaw/`            | Montaje de volumen host              | Tokens OAuth, claves API                   |
| Configuraciones de skills           | `/home/node/.openclaw/skills/`     | Montaje de volumen host              | Estado a nivel de skill                    |
| Workspace del agente                | `/home/node/.openclaw/workspace/`  | Montaje de volumen host              | Código y artefactos del agente             |
| Sesión de WhatsApp                  | `/home/node/.openclaw/`            | Montaje de volumen host              | Preserva login QR                          |
| Keyring de Gmail                    | `/home/node/.openclaw/`            | Montaje de volumen host + contraseña | Requiere `GOG_KEYRING_PASSWORD`            |
| Binarios externos                   | `/usr/local/bin/`                  | Imagen Docker                        | Deben integrarse en tiempo de construcción |
| Runtime de Node                     | Sistema de archivos del contenedor | Imagen Docker                        | Reconstruido cada build de imagen          |
| Paquetes del OS                     | Sistema de archivos del contenedor | Imagen Docker                        | No instalar en runtime                     |
| Contenedor Docker                   | Efímero                            | Reiniciable                          | Seguro de destruir                         |

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

## Resolución de problemas

**Conexión SSH rechazada**

La propagación de claves SSH puede tomar 1-2 minutos después de la creación de la VM. Espera y reintenta.

**Problemas de OS Login**

Verifica tu perfil de OS Login:

```bash
gcloud compute os-login describe-profile
```

Asegúrate de que tu cuenta tenga los permisos IAM requeridos (Compute OS Login o Compute OS Admin Login).

**Sin memoria (OOM)**

Si usas e2-micro y tienes OOM, actualiza a e2-small o e2-medium:

```bash
# Detén la VM primero
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Cambia tipo de máquina
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Inicia la VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## Cuentas de servicio (mejor práctica de seguridad)

Para uso personal, tu cuenta de usuario predeterminada funciona bien.

Para automatización o pipelines de CI/CD, crea una cuenta de servicio dedicada con permisos mínimos:

1. Crear una cuenta de servicio:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Otorga el rol Compute Instance Admin (o rol personalizado más estrecho):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Evita usar el rol Owner para automatización. Usa el principio de menor privilegio.

Consulta [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) para detalles de roles IAM.

---

## Próximos pasos

- Configurar canales de mensajería: [Canales](/es-ES/channels)
- Emparejar dispositivos locales como nodos: [Nodos](/es-ES/nodes)
- Configurar el Gateway: [Configuración del gateway](/es-ES/gateway/configuration)
