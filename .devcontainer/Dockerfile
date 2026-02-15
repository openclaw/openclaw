FROM mcr.microsoft.com/devcontainers/universal:2

USER root

# Remove stale Yarn apt source that breaks apt-get update in this base image
RUN rm -f /etc/apt/sources.list.d/yarn.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends systemd systemd-sysv && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Create required journald directory
RUN mkdir -p /run/systemd/journal

# Mask unnecessary services to reduce startup overhead
RUN systemctl mask apt-daily.service apt-daily-upgrade.service

# Start systemd as PID 1
ENTRYPOINT ["/lib/systemd/systemd"]
