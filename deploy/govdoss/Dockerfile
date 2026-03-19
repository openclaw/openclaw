FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/openclaw.mjs ./openclaw.mjs
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src/govdoss ./src/govdoss
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/govdoss/api/start.ts"]
