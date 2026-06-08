# openclaw/Dockerfile (Build-Context: Projekt-Root -> context: .)
FROM node:22.19-bullseye-slim

WORKDIR /app

# Corepack / pnpm vorbereiten (falls pnpm verwendet wird)
RUN corepack enable || true

# Kopiere package.json + lockfile aus dem openclaw-Ordner für besseres Caching
# (Diese Pfade sind relativ zum Build-Context '.')
COPY openclaw/package.json ./package.json
COPY openclaw/pnpm-lock.yaml ./pnpm-lock.yaml

# Install: pnpm wenn lock vorhanden, sonst npm
RUN if [ -f pnpm-lock.yaml ]; then \
      corepack prepare pnpm@latest --activate && pnpm install --frozen-lockfile --prod; \
    else \
      npm install --production; \
    fi

# Kopiere restliche relevante Dateien in das Image
COPY openclaw ./openclaw
# Optional: repo-weites extensions-Verzeichnis (falls vorhanden)
COPY openclaw/extensions ./extensions

EXPOSE 8080

# Start the openclaw launcher (Pfad relativ zu /app im Image)
CMD ["node", "openclaw/openclaw.mjs"]
