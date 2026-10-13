# Trusted Telegram proof harness image. Build before admitting candidate source.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7
WORKDIR /harness
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git rsync curl sudo python3 \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN chmod -R a+rX /harness && corepack enable && corepack pnpm install --frozen-lockfile \
    && mkdir /candidate /out \
    && find . -type d -name node_modules -prune -exec cp -a --parents {} /candidate \; \
    && chown pwuser:pwuser /out \
    && OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=8192 OPENCLAW_BUILD_PRIVATE_QA=1 corepack pnpm build qaRuntime
ENV CI=true
