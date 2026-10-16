# Trusted Telegram proof harness image. Build before admitting candidate source.
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
WORKDIR /harness
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git rsync curl sudo python3 \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN chmod -R a+rX /harness && corepack enable && corepack pnpm install --frozen-lockfile \
    && node --import ./scripts/tsx.mjs scripts/ensure-playwright-chromium.mts --require-playwright-chromium \
    && mkdir /candidate /out \
    && find . -type d -name node_modules -prune -exec cp -a --parents {} /candidate \; \
    && chown pwuser:pwuser /out \
    && OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=8192 OPENCLAW_BUILD_PRIVATE_QA=1 corepack pnpm build qaRuntime
ENV CI=true
