FROM node:22-bookworm-slim

USER root

ARG KUBECTL_VERSION=v1.33.5
ARG HELM_VERSION=v3.17.1
ARG TERRAFORM_VERSION=1.14.5
ARG OPENCLAW_VERSION=2026.3.9
ARG OPENCLAW_LOCAL_TARBALL=openclaw-local.tgz
ARG OPENCLAW_FOUNDRY_VERSION=1.3.1
ARG QMD_VERSION=1.1.5
ARG VAULT_VERSION=v1.21.2
ARG BOUNDARY_VERSION=v0.20.1
ARG ARGOCD_VERSION=v3.3.2
ARG SENTRY_CLI_VERSION=3.3.2
ARG DUNE_CLI_VERSION=0.1.5
# Pin the Vercel CLI to keep the SRE runtime aligned with the main runtime image.
# See docs/reference/RELEASING.md for coordinated version bumps.
ARG OPENCLAW_VERCEL_CLI_VERSION=50.37.0
ARG TARGETARCH

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    awscli \
    bash \
    ca-certificates \
    curl \
    gh \
    git \
    gzip \
    jq \
    postgresql-client \
    ripgrep \
    tar \
    unzip \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

COPY ${OPENCLAW_LOCAL_TARBALL} /tmp/openclaw-local.tgz
RUN mkdir -p /srv/openclaw/repos/openclaw-sre \
  && if [ -s /tmp/openclaw-local.tgz ]; then \
      tar -xzf /tmp/openclaw-local.tgz -C /srv/openclaw/repos/openclaw-sre --strip-components=1 package; \
      npm install -g --no-fund --no-audit /tmp/openclaw-local.tgz; \
    else \
      npm install -g --no-fund --no-audit "openclaw@${OPENCLAW_VERSION}"; \
    fi \
  && npm install -g --no-fund --no-audit "@tobilu/qmd@${QMD_VERSION}" "vercel@${OPENCLAW_VERCEL_CLI_VERSION}" \
  && vercel --version >/dev/null \
  && rm -f /tmp/openclaw-local.tgz

RUN export FOUNDRY_DIR=/opt/foundry \
  && curl -fsSL https://foundry.paradigm.xyz | bash \
  && /opt/foundry/bin/foundryup --install "${OPENCLAW_FOUNDRY_VERSION}" \
  && chmod -R a+rX /opt/foundry \
  && ln -sf /opt/foundry/bin/forge /usr/local/bin/forge \
  && ln -sf /opt/foundry/bin/cast /usr/local/bin/cast \
  && ln -sf /opt/foundry/bin/anvil /usr/local/bin/anvil \
  && ln -sf /opt/foundry/bin/chisel /usr/local/bin/chisel \
  && forge --version >/dev/null \
  && cast --version >/dev/null \
  && anvil --version >/dev/null \
  && chisel --version >/dev/null

RUN set -eux; \
  arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
  case "$arch" in \
    amd64) kube_arch="amd64"; helm_arch="amd64"; argocd_arch="amd64"; hashicorp_arch="amd64"; sentry_arch="x86_64" ;; \
    arm64) kube_arch="arm64"; helm_arch="arm64"; argocd_arch="arm64"; hashicorp_arch="arm64"; sentry_arch="aarch64" ;; \
    *) echo "Unsupported arch: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${kube_arch}/kubectl"; \
  chmod +x /usr/local/bin/kubectl; \
  curl -fsSL -o /tmp/helm.tar.gz "https://get.helm.sh/helm-${HELM_VERSION}-linux-${helm_arch}.tar.gz"; \
  tar -C /tmp -xzf /tmp/helm.tar.gz; \
  mv "/tmp/linux-${helm_arch}/helm" /usr/local/bin/helm; \
  chmod +x /usr/local/bin/helm; \
  curl -fsSL -o /tmp/terraform.zip "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${hashicorp_arch}.zip"; \
  unzip -p /tmp/terraform.zip terraform >/usr/local/bin/terraform; \
  chmod +x /usr/local/bin/terraform; \
  vault_version="${VAULT_VERSION#v}"; \
  curl -fsSL -o /tmp/vault.zip "https://releases.hashicorp.com/vault/${vault_version}/vault_${vault_version}_linux_${hashicorp_arch}.zip"; \
  unzip -p /tmp/vault.zip vault >/usr/local/bin/vault; \
  chmod +x /usr/local/bin/vault; \
  boundary_version="${BOUNDARY_VERSION#v}"; \
  curl -fsSL -o /tmp/boundary.zip "https://releases.hashicorp.com/boundary/${boundary_version}/boundary_${boundary_version}_linux_${hashicorp_arch}.zip"; \
  unzip -p /tmp/boundary.zip boundary >/usr/local/bin/boundary; \
  chmod +x /usr/local/bin/boundary; \
  curl -fsSL -o /usr/local/bin/sentry-cli "https://github.com/getsentry/sentry-cli/releases/download/${SENTRY_CLI_VERSION}/sentry-cli-Linux-${sentry_arch}"; \
  chmod +x /usr/local/bin/sentry-cli; \
  curl -fsSL -o /usr/local/bin/argocd "https://github.com/argoproj/argo-cd/releases/download/${ARGOCD_VERSION}/argocd-linux-${argocd_arch}"; \
  chmod +x /usr/local/bin/argocd; \
  curl -fsSL -o /tmp/dune-cli.tar.gz "https://github.com/duneanalytics/cli/releases/download/v${DUNE_CLI_VERSION}/dune-cli_${DUNE_CLI_VERSION}_linux_${arch}.tar.gz"; \
  tar -C /tmp -xzf /tmp/dune-cli.tar.gz dune; \
  mv /tmp/dune /usr/local/bin/dune; \
  chmod +x /usr/local/bin/dune; \
  aws --version >/dev/null 2>&1; \
  jq --version >/dev/null; \
  rg --version >/dev/null; \
  git --version >/dev/null; \
  gh --version >/dev/null; \
  kubectl version --client=true --output=yaml >/dev/null; \
  helm version --short >/dev/null; \
  terraform version -json >/dev/null; \
  vault --version >/dev/null; \
  boundary version >/dev/null; \
  sentry-cli --version >/dev/null; \
  argocd version --client >/dev/null; \
  dune --version >/dev/null; \
  rm -rf \
    /tmp/helm.tar.gz \
    "/tmp/linux-${helm_arch}" \
    /tmp/terraform.zip \
    /tmp/vault.zip \
    /tmp/boundary.zip \
    /tmp/dune-cli.tar.gz

RUN mkdir -p /srv/openclaw/repos \
  && chown -R node:node /srv/openclaw

COPY --chown=node:node morpho-infra /srv/openclaw/repos/morpho-infra
COPY --chown=node:node morpho-infra-helm /srv/openclaw/repos/morpho-infra-helm
COPY --chown=node:node openclaw-sre /srv/openclaw/repos/openclaw-sre

RUN ACPX_VERSION="$(node -p "require('/usr/local/lib/node_modules/openclaw/extensions/acpx/package.json').dependencies.acpx")" \
  && [ "$ACPX_VERSION" != "undefined" ] \
  && [ -n "$ACPX_VERSION" ] \
  && npm --prefix /usr/local/lib/node_modules/openclaw/extensions/acpx install --omit=dev --no-save "acpx@${ACPX_VERSION}" \
  && chmod -R a+rX /usr/local/lib/node_modules/openclaw/extensions/acpx \
  && find /usr/local/lib/node_modules/openclaw/extensions/acpx/node_modules/.bin -type f -exec chmod 755 {} + \
  && for skill_root in \
    /usr/local/lib/node_modules/openclaw/skills/morpho-sre \
    /srv/openclaw/repos/openclaw-sre/skills/morpho-sre; do \
      mkdir -p "${skill_root}/scripts"; \
      find "${skill_root}" -maxdepth 1 -type f -name '*.sh' | while read -r script; do \
        name="$(basename "$script")"; \
        ln -sf "../${name}" "${skill_root}/scripts/${name}"; \
      done; \
    done

USER node
