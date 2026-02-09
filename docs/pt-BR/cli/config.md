---
summary: "Referência da CLI para `openclaw config` (obter/definir/remover valores de configuração)"
read_when:
  - Você quer ler ou editar a configuração de forma não interativa
title: "configuração"
---

# `openclaw config`

Auxiliares de configuração: obter/definir/remover valores por caminho. Execute sem um subcomando para abrir
o assistente de configuração (o mesmo que `openclaw configure`).

## Exemplos

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Caminhos

Os caminhos usam notação por ponto ou colchetes:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Use o índice da lista de agentes para direcionar um agente específico:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Valores

Os valores são analisados como JSON5 quando possível; caso contrário, são tratados como strings.
Use `--json` para exigir a análise JSON5.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Reinicie o gateway após as edições.
