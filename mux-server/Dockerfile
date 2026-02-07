FROM node:22-bookworm-slim

WORKDIR /workspace
RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile

EXPOSE 18891
CMD ["node", "--import", "tsx", "mux-server/src/server.ts"]
