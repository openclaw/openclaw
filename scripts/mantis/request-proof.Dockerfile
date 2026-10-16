# Trusted harness image. Build before admitting any candidate source.
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
WORKDIR /harness
COPY . .
RUN chmod -R a+rX /harness && corepack enable && corepack pnpm install --frozen-lockfile \
    && node --import ./scripts/tsx.mjs scripts/ensure-playwright-chromium.mts --require-playwright-chromium \
    && mkdir /candidate /out \
    && find . -type d -name node_modules -prune -exec cp -a --parents {} /candidate \; \
    && chown pwuser:pwuser /out
ENV CI=true
