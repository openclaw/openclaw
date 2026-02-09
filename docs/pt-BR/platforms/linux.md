---
summary: "Suporte a Linux + status do aplicativo complementar"
read_when:
  - Procurando o status do aplicativo complementar para Linux
  - Planejando cobertura de plataformas ou contribuições
title: "Aplicativo Linux"
---

# Aplicativo Linux

O Gateway é totalmente compatível com Linux. **Node é o runtime recomendado**.
Bun não é recomendado para o Gateway (bugs no WhatsApp/Telegram).

Aplicativos complementares nativos para Linux estão planejados. Contribuições são bem-vindas se você quiser ajudar a criar um.

## Caminho rápido para iniciantes (VPS)

1. Instale Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Do seu laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Abra `http://127.0.0.1:18789/` e cole seu token

Guia passo a passo para VPS: [exe.dev](/install/exe-dev)

## Instalação

- [Primeiros passos](/start/getting-started)
- [Instalação e atualizações](/install/updating)
- Fluxos opcionais: [Bun (experimental)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Runbook do Gateway](/gateway)
- [Configuração](/gateway/configuration)

## Instalação do serviço do Gateway (CLI)

Use um destes:

```
openclaw onboard --install-daemon
```

Ou:

```
openclaw gateway install
```

Ou:

```
openclaw configure
```

Selecione **Gateway service** quando solicitado.

Reparar/migrar:

```
openclaw doctor
```

## Controle do sistema (unit de usuário do systemd)

O OpenClaw instala um serviço **de usuário** do systemd por padrão. Use um serviço
**do sistema** para servidores compartilhados ou sempre ativos. O exemplo completo da unit e as orientações
estão no [runbook do Gateway](/gateway).

Configuração mínima:

Crie `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Ative-o:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
