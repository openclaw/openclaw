ARG NODE_IMAGE=node:24.15.0-bookworm
FROM ${NODE_IMAGE}

# GNU time and procps are the only additions required for phase-local RSS and
# process attribution; Git/Corepack/Node come from the pinned Node image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps time \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/lib/git-pnpm-memory-phase.sh /usr/local/bin/openclaw-git-pnpm-memory-phase
RUN chmod 0755 /usr/local/bin/openclaw-git-pnpm-memory-phase
