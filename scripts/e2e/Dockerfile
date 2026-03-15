# syntax=docker/dockerfile:1.7

FROM node:24-bookworm@sha256:9f3b13503acdf9bc1e0213ccb25ebe86ac881cad17636733a1da1be1d44509df

RUN corepack enable

WORKDIR /app

ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ui/package.json ./ui/package.json
COPY extensions/memory-core/package.json ./extensions/memory-core/package.json
COPY patches ./patches

RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.plugin-sdk.dts.json tsdown.config.ts vitest.config.ts vitest.e2e.config.ts openclaw.mjs ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
COPY docs ./docs
COPY skills ./skills
COPY ui ./ui
COPY extensions/memory-core ./extensions/memory-core
COPY vendor/a2ui/renderers/lit ./vendor/a2ui/renderers/lit
COPY apps/shared/OpenClawKit/Sources/OpenClawKit/Resources ./apps/shared/OpenClawKit/Sources/OpenClawKit/Resources
COPY apps/shared/OpenClawKit/Tools/CanvasA2UI ./apps/shared/OpenClawKit/Tools/CanvasA2UI

RUN pnpm build
RUN pnpm ui:build

RUN useradd --create-home --shell /bin/bash appuser \
  && chown -R appuser:appuser /app
USER appuser

CMD ["bash"]
