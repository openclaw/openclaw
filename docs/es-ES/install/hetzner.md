---
summary: "Ejecutar OpenClaw Gateway 24/7 en un VPS económico de Hetzner (Docker) con estado duradero y binarios integrados"
read_when:
  - Quieres OpenClaw ejecutándose 24/7 en un VPS en la nube (no tu laptop)
  - Quieres un Gateway de grado producción, siempre activo en tu propio VPS
  - Quieres control total sobre persistencia, binarios y comportamiento de reinicio
  - Estás ejecutando OpenClaw en Docker en Hetzner o un proveedor similar
title: "Hetzner"
---

# OpenClaw en Hetzner (Docker, Guía VPS de Producción)

## Objetivo

Ejecutar un OpenClaw Gateway persistente en un VPS de Hetzner usando Docker, con estado duradero, binarios integrados y comportamiento de reinicio seguro.

Si quieres "OpenClaw 24/7 por ~$5", esta es la configuración confiable más simple.
Los precios de Hetzner cambian; elige el VPS Debian/Ubuntu más pequeño y escala si encuentras OOMs.

## ¿Qué estamos haciendo (en términos simples)?

- Rentar un pequeño servidor Linux (VPS Hetzner)
- Instalar Docker (runtime de aplicación aislada)
- Iniciar el OpenClaw Gateway en Docker
- Persistir `~/.openclaw` + `~/.openclaw/workspace` en el host (sobrevive a reinicios/reconstrucciones)
- Acceder a la UI de Control desde tu laptop vía túnel SSH

Se puede acceder al Gateway vía:

- Reenvío de puerto SSH desde tu laptop
- Exposición directa de puerto si administras firewall y tokens tú mismo

Esta guía asume Ubuntu o Debian en Hetzner.  
Si estás en otro VPS Linux, mapea los paquetes correspondientes.
Para el flujo Docker genérico, consulta [Docker](/es-ES/install/docker).

---

## Ruta rápida (operadores experimentados)

1. Provisionar VPS Hetzner
2. Instalar Docker
3. Clonar repositorio OpenClaw
4. Crear directorios persistentes en el host
5. Configurar `.env` y `docker-compose.yml`
6. Integrar binarios requeridos en la imagen
7. `docker compose up -d`
8. Verificar persistencia y acceso al Gateway

---

## Lo que necesitas

- VPS Hetzner con acceso root
- Acceso SSH desde tu laptop
- Comodidad básica con SSH + copiar/pegar
- ~20 minutos
- Docker y Docker Compose
- Credenciales de autenticación de modelo
- Credenciales de proveedor opcionales
  - QR de WhatsApp
  - Token de bot de Telegram
  - OAuth de Gmail

---

## 1) Provisionar el VPS

Crea un VPS Ubuntu o Debian en Hetzner.

Conéctate como root:

```bash
ssh root@TU_IP_VPS
```

Esta guía asume que el VPS tiene estado.
No lo trates como infraestructura desechable.

---

## 2) Instalar Docker (en el VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Verifica:

```bash
docker --version
docker compose version
```

---

## 3) Clonar el repositorio OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Esta guía asume que construirás una imagen personalizada para garantizar persistencia de binarios.

---

## 4) Crear directorios persistentes en el host

Los contenedores Docker son efímeros.
Todo el estado de larga duración debe vivir en el host.

```bash
mkdir -p /root/.openclaw/workspace

# Establecer propiedad al usuario del contenedor (uid 1000):
chown -R 1000:1000 /root/.openclaw
```

---

## 5) Configurar variables de entorno

Crea `.env` en la raíz del repositorio.

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

Genera secretos fuertes:

```bash
openssl rand -hex 32
```

**No hagas commit de este archivo.**

---

## 6) Configuración de Docker Compose

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
      # Recomendado: mantén el Gateway solo-loopback en el VPS; accede vía túnel SSH.
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
        "--allow-unconfigured",
      ]
```

`--allow-unconfigured` es solo para conveniencia de bootstrap, no es un reemplazo de una configuración apropiada del gateway. Aún establece autenticación (`gateway.auth.token` o contraseña) y usa configuraciones de bind seguras para tu despliegue.

---

## 7) Integrar binarios requeridos en la imagen (crítico)

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

## 8) Construir y lanzar

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

## 9) Verificar Gateway

```bash
docker compose logs -f openclaw-gateway
```

Éxito:

```
[gateway] listening on ws://0.0.0.0:18789
```

Desde tu laptop:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@TU_IP_VPS
```

Abre:

`http://127.0.0.1:18789/`

Pega tu token del gateway.

---

## Qué persiste dónde (fuente de verdad)

OpenClaw se ejecuta en Docker, pero Docker no es la fuente de verdad.
Todo el estado de larga duración debe sobrevivir a reinicios, reconstrucciones y reinicios del sistema.

| Componente               | Ubicación                         | Mecanismo de persistencia | Notas                                |
| ------------------------ | --------------------------------- | ------------------------- | ------------------------------------ |
| Configuración del Gateway | `/home/node/.openclaw/`          | Montaje de volumen host   | Incluye `openclaw.json`, tokens      |
| Perfiles de autenticación de modelo | `/home/node/.openclaw/` | Montaje de volumen host   | Tokens OAuth, claves API             |
| Configuraciones de skills | `/home/node/.openclaw/skills/`   | Montaje de volumen host   | Estado a nivel de skill              |
| Workspace del agente     | `/home/node/.openclaw/workspace/` | Montaje de volumen host   | Código y artefactos del agente       |
| Sesión de WhatsApp       | `/home/node/.openclaw/`          | Montaje de volumen host   | Preserva login QR                    |
| Keyring de Gmail         | `/home/node/.openclaw/`          | Montaje de volumen host + contraseña | Requiere `GOG_KEYRING_PASSWORD` |
| Binarios externos        | `/usr/local/bin/`                | Imagen Docker             | Deben integrarse en tiempo de construcción |
| Runtime de Node          | Sistema de archivos del contenedor | Imagen Docker            | Reconstruido cada build de imagen    |
| Paquetes del OS          | Sistema de archivos del contenedor | Imagen Docker            | No instalar en runtime               |
| Contenedor Docker        | Efímero                          | Reiniciable               | Seguro de destruir                   |

---

## Infraestructura como Código (Terraform)

Para equipos que prefieren flujos de trabajo de infraestructura como código, una configuración de Terraform mantenida por la comunidad proporciona:

- Configuración modular de Terraform con gestión de estado remoto
- Aprovisionamiento automatizado vía cloud-init
- Scripts de despliegue (bootstrap, deploy, backup/restore)
- Reforzamiento de seguridad (firewall, UFW, acceso solo SSH)
- Configuración de túnel SSH para acceso al gateway

**Repositorios:**

- Infraestructura: [openclaw-terraform-hetzner](https://github.com/andreesg/openclaw-terraform-hetzner)
- Configuración Docker: [openclaw-docker-config](https://github.com/andreesg/openclaw-docker-config)

Este enfoque complementa la configuración Docker de arriba con despliegues reproducibles, infraestructura versionada y recuperación ante desastres automatizada.

> **Nota:** Mantenido por la comunidad. Para problemas o contribuciones, consulta los enlaces de repositorio arriba.
