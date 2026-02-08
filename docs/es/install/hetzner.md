---
summary: "Ejecute OpenClaw Gateway 24/7 en un VPS económico de Hetzner (Docker) con estado duradero y binarios integrados"
read_when:
  - Desea OpenClaw ejecutándose 24/7 en un VPS en la nube (no en su laptop)
  - Desea un Gateway siempre activo y de nivel producción en su propio VPS
  - Desea control total sobre la persistencia, los binarios y el comportamiento de reinicio
  - Está ejecutando OpenClaw en Docker en Hetzner o un proveedor similar
title: "Hetzner"
x-i18n:
  source_path: install/hetzner.md
  source_hash: 84d9f24f1a803aa1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:33:54Z
---

# OpenClaw en Hetzner (Docker, Guía de VPS en producción)

## Objetivo

Ejecutar un Gateway persistente de OpenClaw en un VPS de Hetzner usando Docker, con estado duradero, binarios integrados y comportamiento de reinicio seguro.

Si desea “OpenClaw 24/7 por ~$5”, esta es la configuración confiable más sencilla.  
Los precios de Hetzner cambian; elija el VPS más pequeño de Debian/Ubuntu y escale si encuentra OOMs.

## ¿Qué estamos haciendo (en términos simples)?

- Alquilar un pequeño servidor Linux (VPS de Hetzner)
- Instalar Docker (runtime de aplicaciones aislado)
- Iniciar el Gateway de OpenClaw en Docker
- Persistir `~/.openclaw` + `~/.openclaw/workspace` en el host (sobrevive reinicios/reconstrucciones)
- Acceder a la IU de Control desde su laptop mediante un túnel SSH

Se puede acceder al Gateway mediante:

- Reenvío de puertos SSH desde su laptop
- Exposición directa de puertos si usted mismo gestiona el firewall y los tokens

Esta guía asume Ubuntu o Debian en Hetzner.  
Si está en otro VPS Linux, ajuste los paquetes según corresponda.  
Para el flujo genérico de Docker, consulte [Docker](/install/docker).

---

## Ruta rápida (operadores con experiencia)

1. Aprovisionar VPS de Hetzner
2. Instalar Docker
3. Clonar el repositorio de OpenClaw
4. Crear directorios persistentes en el host
5. Configurar `.env` y `docker-compose.yml`
6. Integrar los binarios requeridos en la imagen
7. `docker compose up -d`
8. Verificar la persistencia y el acceso al Gateway

---

## Lo que necesita

- VPS de Hetzner con acceso root
- Acceso SSH desde su laptop
- Comodidad básica con SSH + copiar/pegar
- ~20 minutos
- Docker y Docker Compose
- Credenciales de autenticación del modelo
- Credenciales opcionales de proveedores
  - QR de WhatsApp
  - Token de bot de Telegram
  - OAuth de Gmail

---

## 1) Aprovisionar el VPS

Cree un VPS Ubuntu o Debian en Hetzner.

Conéctese como root:

```bash
ssh root@YOUR_VPS_IP
```

Esta guía asume que el VPS es con estado.  
No lo trate como infraestructura desechable.

---

## 2) Instalar Docker (en el VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Verifique:

```bash
docker --version
docker compose version
```

---

## 3) Clonar el repositorio de OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Esta guía asume que construirá una imagen personalizada para garantizar la persistencia de binarios.

---

## 4) Crear directorios persistentes en el host

Los contenedores Docker son efímeros.  
Todo el estado de larga duración debe residir en el host.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5) Configurar variables de entorno

Cree `.env` en la raíz del repositorio.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/root/.openclaw
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Genere secretos fuertes:

```bash
openssl rand -hex 32
```

**No haga commit de este archivo.**

---

## 6) Configuración de Docker Compose

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
      # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VPS and need Canvas host.
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

## 7) Integrar los binarios requeridos en la imagen (crítico)

Instalar binarios dentro de un contenedor en ejecución es una trampa.  
Cualquier cosa instalada en tiempo de ejecución se perderá al reiniciar.

Todos los binarios externos requeridos por las Skills deben instalarse en el momento de construcción de la imagen.

Los ejemplos a continuación muestran solo tres binarios comunes:

- `gog` para acceso a Gmail
- `goplaces` para Google Places
- `wacli` para WhatsApp

Estos son ejemplos, no una lista completa.  
Puede instalar tantos binarios como necesite usando el mismo patrón.

Si agrega nuevas Skills más adelante que dependan de binarios adicionales, debe:

1. Actualizar el Dockerfile
2. Reconstruir la imagen
3. Reiniciar los contenedores

**Ejemplo de Dockerfile**

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

## 8) Construir y lanzar

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Verificar binarios:

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

## 9) Verificar el Gateway

```bash
docker compose logs -f openclaw-gateway
```

Éxito:

```
[gateway] listening on ws://0.0.0.0:18789
```

Desde su laptop:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Abra:

`http://127.0.0.1:18789/`

Pegue su token del Gateway.

---

## Qué persiste y dónde (fuente de la verdad)

OpenClaw se ejecuta en Docker, pero Docker no es la fuente de la verdad.  
Todo el estado de larga duración debe sobrevivir reinicios, reconstrucciones y reinicios del sistema.

| Componente                           | Ubicación                          | Mecanismo de persistencia     | Notas                               |
| ------------------------------------ | ---------------------------------- | ----------------------------- | ----------------------------------- |
| Configuración del Gateway            | `/home/node/.openclaw/`            | Montaje de volumen del host   | Incluye `openclaw.json`, tokens     |
| Perfiles de autenticación del modelo | `/home/node/.openclaw/`            | Montaje de volumen del host   | Tokens OAuth, claves de API         |
| Configuraciones de Skills            | `/home/node/.openclaw/skills/`     | Montaje de volumen del host   | Estado a nivel de Skill             |
| Espacio de trabajo del agente        | `/home/node/.openclaw/workspace/`  | Montaje de volumen del host   | Código y artefactos del agente      |
| Sesión de WhatsApp                   | `/home/node/.openclaw/`            | Montaje de volumen del host   | Conserva el inicio de sesión por QR |
| Llavero de Gmail                     | `/home/node/.openclaw/`            | Volumen del host + contraseña | Requiere `GOG_KEYRING_PASSWORD`     |
| Binarios externos                    | `/usr/local/bin/`                  | Imagen Docker                 | Deben integrarse en el build        |
| Runtime de Node                      | Sistema de archivos del contenedor | Imagen Docker                 | Se reconstruye en cada build        |
| Paquetes del SO                      | Sistema de archivos del contenedor | Imagen Docker                 | No instalar en tiempo de ejecución  |
| Contenedor Docker                    | Efímero                            | Reiniciable                   | Seguro de destruir                  |
