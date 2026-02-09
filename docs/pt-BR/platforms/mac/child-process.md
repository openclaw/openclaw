---
summary: "Ciclo de vida do Gateway no macOS (launchd)"
read_when:
  - Integrando o app do mac com o ciclo de vida do gateway
title: "Ciclo de vida do Gateway"
---

# Ciclo de vida do Gateway no macOS

O app do macOS **gerencia o Gateway via launchd** por padrão e não inicia
o Gateway como um processo filho. Ele primeiro tenta se anexar a um
Gateway já em execução na porta configurada; se nenhum estiver acessível,
ele habilita o serviço do launchd por meio da CLI externa `openclaw`
(sem runtime embutido). Isso oferece inicialização automática confiável
no login e reinício em caso de falhas.

O modo de processo filho (Gateway iniciado diretamente pelo app) **não é usado**
hoje.
Se você precisar de um acoplamento mais estreito com a UI, execute
o Gateway manualmente em um terminal.

## Comportamento padrão (launchd)

- O app instala um LaunchAgent por usuário rotulado como `bot.molt.gateway`
  (ou `bot.molt.<profile>` ao usar `--profile`/`OPENCLAW_PROFILE`; o legado `com.openclaw.*` é compatível).
- Quando o modo Local está habilitado, o app garante que o LaunchAgent esteja carregado e
  inicia o Gateway se necessário.
- Os logs são gravados no caminho de logs do gateway do launchd (visível em Configurações de depuração).

Comandos comuns:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Substitua o rótulo por `bot.molt.<profile>` ao executar um perfil nomeado.

## Builds de desenvolvimento não assinadas

`scripts/restart-mac.sh --no-sign` é para builds locais rápidos quando você não tem
chaves de assinatura. Para impedir que o launchd aponte para um binário de relay não assinado, ele:

- Grava `~/.openclaw/disable-launchagent`.

Execuções assinadas de `scripts/restart-mac.sh` limpam essa substituição se o marcador
estiver presente. Para redefinir manualmente:

```bash
rm ~/.openclaw/disable-launchagent
```

## Modo somente de anexação

Para forçar o app do macOS a **nunca instalar ou gerenciar o launchd**, inicie-o com
`--attach-only` (ou `--no-launchd`). Isso define `~/.openclaw/disable-launchagent`,
então o app apenas se anexa a um Gateway já em execução. Você pode alternar o mesmo
comportamento em Configurações de depuração.

## Modo remoto

O modo remoto nunca inicia um Gateway local. O app usa um túnel SSH para o
host remoto e se conecta por esse túnel.

## Por que preferimos o launchd

- Inicialização automática no login.
- Semântica integrada de reinício/KeepAlive.
- Logs e supervisão previsíveis.

Se um modo verdadeiro de processo filho voltar a ser necessário, ele deve ser
documentado como um modo separado e explícito, apenas para desenvolvimento.
