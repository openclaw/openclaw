---
summary: "Referência da CLI para `openclaw node` (host de node headless)"
read_when:
  - Executando o host de node headless
  - Pareando um node que não seja macOS para system.run
title: "node"
---

# `openclaw node`

Execute um **host de node headless** que se conecta ao WebSocket do Gateway e expõe
`system.run` / `system.which` nesta máquina.

## Por que usar um host de node?

Use um host de node quando voce quiser que agentes **executem comandos em outras máquinas** da sua
rede sem instalar um aplicativo complementar completo do macOS nelas.

Casos de uso comuns:

- Executar comandos em caixas Linux/Windows remotas (servidores de build, máquinas de laboratório, NAS).
- Manter a execução **em sandbox** no gateway, mas delegar execuções aprovadas para outros hosts.
- Fornecer um destino de execução leve e headless para automação ou nós de CI.

A execução ainda é protegida por **aprovações de exec** e listas de permissões por agente no
host de node, para que voce mantenha o acesso a comandos com escopo definido e explícito.

## Proxy de navegador (configuração zero)

Hosts de node anunciam automaticamente um proxy de navegador se `browser.enabled` não estiver
desativado no node. Isso permite que o agente use automação de navegador nesse node
sem configuração extra.

Desative no node, se necessário:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Executar (foreground)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Opções:

- `--host <host>`: Host do WebSocket do Gateway (padrão: `127.0.0.1`)
- `--port <port>`: Porta do WebSocket do Gateway (padrão: `18789`)
- `--tls`: Usar TLS para a conexão com o gateway
- `--tls-fingerprint <sha256>`: Impressão digital esperada do certificado TLS (sha256)
- `--node-id <id>`: Substituir o id do node (limpa o token de pareamento)
- `--display-name <name>`: Substituir o nome de exibição do node

## Serviço (background)

Instale um host de node headless como um serviço de usuário.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Opções:

- `--host <host>`: Host do WebSocket do Gateway (padrão: `127.0.0.1`)
- `--port <port>`: Porta do WebSocket do Gateway (padrão: `18789`)
- `--tls`: Usar TLS para a conexão com o gateway
- `--tls-fingerprint <sha256>`: Impressão digital esperada do certificado TLS (sha256)
- `--node-id <id>`: Substituir o id do node (limpa o token de pareamento)
- `--display-name <name>`: Substituir o nome de exibição do node
- `--runtime <runtime>`: Runtime do serviço (`node` ou `bun`)
- `--force`: Reinstalar/substituir se já estiver instalado

Gerenciar o serviço:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Use `openclaw node run` para um host de node em foreground (sem serviço).

Os comandos de serviço aceitam `--json` para saída legível por máquina.

## Pareamento

A primeira conexão cria uma solicitação de pareamento de node pendente no Gateway.
Aprove-a via:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

O host de node armazena seu id de node, token, nome de exibição e informações de conexão
com o gateway em `~/.openclaw/node.json`.

## Aprovações de exec

`system.run` é protegido por aprovações locais de exec:

- `~/.openclaw/exec-approvals.json`
- [Aprovações de exec](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (editar pelo Gateway)
