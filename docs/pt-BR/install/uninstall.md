---
summary: "Desinstale o OpenClaw completamente (CLI, serviço, estado, workspace)"
read_when:
  - Você quer remover o OpenClaw de uma máquina
  - O serviço do gateway ainda está em execução após a desinstalação
title: "Desinstalar"
---

# Desinstalar

Dois caminhos:

- **Caminho fácil** se `openclaw` ainda estiver instalado.
- **Remoção manual do serviço** se a CLI não existir mais, mas o serviço ainda estiver em execução.

## Caminho fácil (CLI ainda instalada)

Recomendado: use o desinstalador integrado:

```bash
openclaw uninstall
```

Não interativo (automação / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Passos manuais (mesmo resultado):

1. Pare o serviço do gateway:

```bash
openclaw gateway stop
```

2. Desinstale o serviço do gateway (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Exclua estado + configuração:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

Se você definiu `OPENCLAW_CONFIG_PATH` para um local personalizado fora do diretório de estado, exclua esse arquivo também.

4. Exclua seu workspace (opcional, remove arquivos do agente):

```bash
rm -rf ~/.openclaw/workspace
```

5. Remova a instalação da CLI (escolha a que você usou):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. Se você instalou o app do macOS:

```bash
rm -rf /Applications/OpenClaw.app
```

Notas:

- Se você usou perfis (`--profile` / `OPENCLAW_PROFILE`), repita o passo 3 para cada diretório de estado (os padrões são `~/.openclaw-<profile>`).
- Em modo remoto, o diretório de estado fica no **host do Gateway**, então execute os passos 1-4 lá também.

## Remoção manual do serviço (CLI não instalada)

Use isto se o serviço do gateway continuar em execução, mas `openclaw` estiver ausente.

### macOS (launchd)

O rótulo padrão é `bot.molt.gateway` (ou `bot.molt.<profile>`; o legado `com.openclaw.*` ainda pode existir):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

Se você usou um perfil, substitua o rótulo e o nome do plist por `bot.molt.<profile>`. Remova quaisquer plists legados `com.openclaw.*` se existirem.

### Linux (systemd user unit)

O nome padrão da unidade é `openclaw-gateway.service` (ou `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Tarefa Agendada)

O nome padrão da tarefa é `OpenClaw Gateway` (ou `OpenClaw Gateway (<profile>)`).
O script da tarefa fica dentro do seu diretório de estado.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Se você usou um perfil, exclua o nome de tarefa correspondente e `~\.openclaw-<profile>\gateway.cmd`.

## Instalação normal vs checkout de código-fonte

### Instalação normal (install.sh / npm / pnpm / bun)

Se você usou `https://openclaw.ai/install.sh` ou `install.ps1`, a CLI foi instalada com `npm install -g openclaw@latest`.
Remova-a com `npm rm -g openclaw` (ou `pnpm remove -g` / `bun remove -g` se você instalou dessa forma).

### Checkout de código-fonte (git clone)

Se você executa a partir de um checkout do repositório (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. Desinstale o serviço do gateway **antes** de excluir o repositório (use o caminho fácil acima ou a remoção manual do serviço).
2. Exclua o diretório do repositório.
3. Remova estado + workspace conforme mostrado acima.
