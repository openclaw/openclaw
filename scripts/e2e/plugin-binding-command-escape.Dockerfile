FROM node:24-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /workspace/openclaw
COPY . .

RUN OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL=1 pnpm install --frozen-lockfile --ignore-scripts --filter openclaw

CMD ["bash"]
