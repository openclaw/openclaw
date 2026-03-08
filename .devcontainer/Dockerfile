FROM mcr.microsoft.com/devcontainers/universal:2

USER root

# Work around a known issue in the mcr.microsoft.com/devcontainers/universal:2 base image
# by removing a stale Yarn apt source that breaks apt-get update, then install systemd + dbus (needed for systemctl --user).
RUN rm -f /etc/apt/sources.list.d/yarn.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        systemd \
        systemd-sysv \
        dbus \
        dbus-user-session && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Switch back to the codespace user so Codespaces can resolve remoteUser properly.
USER codespace

# Do NOT set ENTRYPOINT — Codespaces requires the default entrypoint.
# systemd will be started as a user service manager via postStartCommand.
