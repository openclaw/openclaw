FROM node:22-alpine

WORKDIR /app

COPY harvester-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY harvester-server.mjs ./harvester-server.mjs

EXPOSE 8080

CMD ["node", "harvester-server.mjs"]
