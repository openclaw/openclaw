---
summary: "Referência da CLI para `openclaw hooks` (hooks de agente)"
read_when:
  - Você quer gerenciar hooks de agente
  - Você quer instalar ou atualizar hooks
title: "hooks"
---

# `openclaw hooks`

Gerencie hooks de agente (automações orientadas a eventos para comandos como `/new`, `/reset` e a inicialização do gateway).

Relacionados:

- Hooks: [Hooks](/automation/hooks)
- Hooks de plugin: [Plugins](/tools/plugin#plugin-hooks)

## Listar todos os hooks

```bash
openclaw hooks list
```

Liste todos os hooks descobertos nos diretórios de workspace, gerenciados e empacotados.

**Opções:**

- `--eligible`: Mostrar apenas hooks elegíveis (requisitos atendidos)
- `--json`: Saída em JSON
- `-v, --verbose`: Mostrar informações detalhadas, incluindo requisitos ausentes

**Exemplo de saída:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**Exemplo (detalhado):**

```bash
openclaw hooks list --verbose
```

Mostra requisitos ausentes para hooks não elegíveis.

**Exemplo (JSON):**

```bash
openclaw hooks list --json
```

Retorna JSON estruturado para uso programático.

## Obter informações do hook

```bash
openclaw hooks info <name>
```

Mostra informações detalhadas sobre um hook específico.

**Argumentos:**

- `<name>`: Nome do hook (por exemplo, `session-memory`)

**Opções:**

- `--json`: Saída em JSON

**Exemplo:**

```bash
openclaw hooks info session-memory
```

**Saída:**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## Verificar elegibilidade dos hooks

```bash
openclaw hooks check
```

Mostra um resumo do status de elegibilidade dos hooks (quantos estão prontos vs. não prontos).

**Opções:**

- `--json`: Saída em JSON

**Exemplo de saída:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## Habilitar um hook

```bash
openclaw hooks enable <name>
```

Habilite um hook específico adicionando-o à sua configuração (`~/.openclaw/config.json`).

**Nota:** Hooks gerenciados por plugins mostram `plugin:<id>` em `openclaw hooks list` e
não podem ser habilitados/desabilitados aqui. Em vez disso, habilite/desabilite o plugin.

**Argumentos:**

- `<name>`: Nome do hook (por exemplo, `session-memory`)

**Exemplo:**

```bash
openclaw hooks enable session-memory
```

**Saída:**

```
✓ Enabled hook: 💾 session-memory
```

**O que ele faz:**

- Verifica se o hook existe e é elegível
- Atualiza `hooks.internal.entries.<name>.enabled = true` na sua configuração
- Salva a configuração em disco

**Após habilitar:**

- Reinicie o gateway para que os hooks sejam recarregados (reinício do app da barra de menu no macOS ou reinicie o processo do gateway em dev).

## Desabilitar um hook

```bash
openclaw hooks disable <name>
```

Desabilite um hook específico atualizando sua configuração.

**Argumentos:**

- `<name>`: Nome do hook (por exemplo, `command-logger`)

**Exemplo:**

```bash
openclaw hooks disable command-logger
```

**Saída:**

```
⏸ Disabled hook: 📝 command-logger
```

**Após desabilitar:**

- Reinicie o gateway para que os hooks sejam recarregados

## Instalar hooks

```bash
openclaw hooks install <path-or-spec>
```

Instale um pacote de hooks a partir de uma pasta/arquivo local ou do npm.

**O que ele faz:**

- Copia o pacote de hooks para `~/.openclaw/hooks/<id>`
- Habilita os hooks instalados em `hooks.internal.entries.*`
- Registra a instalação em `hooks.internal.installs`

**Opções:**

- `-l, --link`: Vincular um diretório local em vez de copiar (adiciona-o a `hooks.internal.load.extraDirs`)

**Arquivos suportados:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**Exemplos:**

```bash
# Local directory
openclaw hooks install ./my-hook-pack

# Local archive
openclaw hooks install ./my-hook-pack.zip

# NPM package
openclaw hooks install @openclaw/my-hook-pack

# Link a local directory without copying
openclaw hooks install -l ./my-hook-pack
```

## Atualizar hooks

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

Atualize pacotes de hooks instalados (apenas instalações via npm).

**Opções:**

- `--all`: Atualizar todos os pacotes de hooks rastreados
- `--dry-run`: Mostrar o que mudaria sem gravar

## Hooks empacotados

### session-memory

Salva o contexto da sessão na memória quando você executa `/new`.

**Habilitar:**

```bash
openclaw hooks enable session-memory
```

**Saída:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**Veja:** [documentação do session-memory](/automation/hooks#session-memory)

### command-logger

Registra todos os eventos de comando em um arquivo de auditoria centralizado.

**Habilitar:**

```bash
openclaw hooks enable command-logger
```

**Saída:** `~/.openclaw/logs/commands.log`

**Ver logs:**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Veja:** [documentação do command-logger](/automation/hooks#command-logger)

### soul-evil

Troca conteúdo `SOUL.md` injetado por `SOUL_EVIL.md` durante uma janela de purge ou por chance aleatória.

**Habilitar:**

```bash
openclaw hooks enable soul-evil
```

**Veja:** [Hook SOUL Evil](/hooks/soul-evil)

### boot-md

Executa `BOOT.md` quando o gateway inicia (após os canais iniciarem).

**Eventos**: `gateway:startup`

**Habilitar**:

```bash
openclaw hooks enable boot-md
```

**Veja:** [documentação do boot-md](/automation/hooks#boot-md)
