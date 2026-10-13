FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /workspace/openclaw
COPY . .

# Source tests resolve workspace packages through aliases, outside the root
# dependency graph. Install their isolated links along with the root tools.
RUN OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL=1 pnpm install --frozen-lockfile --ignore-scripts

CMD ["bash"]
