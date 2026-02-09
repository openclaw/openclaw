---
summary: "Autenticação de modelos: OAuth, chaves de API e setup-token"
read_when:
  - Depurando autenticação de modelos ou expiração de OAuth
  - Documentando autenticação ou armazenamento de credenciais
title: "Autenticação"
---

# Autenticação

O OpenClaw oferece suporte a OAuth e chaves de API para provedores de modelos. Para contas da Anthropic, recomendamos usar uma **chave de API**. Para acesso por assinatura do Claude, use o token de longa duração criado por `claude setup-token`.

Veja [/concepts/oauth](/concepts/oauth) para o fluxo completo de OAuth e o layout de armazenamento.

## Configuração recomendada da Anthropic (chave de API)

Se você estiver usando a Anthropic diretamente, use uma chave de API.

1. Crie uma chave de API no Console da Anthropic.
2. Coloque-a no **host do gateway** (a máquina que executa `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Se o Gateway roda sob systemd/launchd, prefira colocar a chave em
   `~/.openclaw/.env` para que o daemon possa lê-la:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Em seguida, reinicie o daemon (ou reinicie o processo do Gateway) e verifique novamente:

```bash
openclaw models status
openclaw doctor
```

Se você preferir não gerenciar variáveis de ambiente por conta própria, o assistente de integração inicial pode armazenar chaves de API para uso pelo daemon: `openclaw onboard`.

Veja [Help](/help) para detalhes sobre herança de env (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd).

## Anthropic: setup-token (autenticação por assinatura)

Para a Anthropic, o caminho recomendado é uma **chave de API**. Se você estiver usando uma assinatura do Claude, o fluxo de setup-token também é suportado. Execute-o no **host do gateway**:

```bash
claude setup-token
```

Depois, cole-o no OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Se o token foi criado em outra máquina, cole-o manualmente:

```bash
openclaw models auth paste-token --provider anthropic
```

Se você vir um erro da Anthropic como:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…use uma chave de API da Anthropic em vez disso.

Entrada manual de token (qualquer provedor; grava `auth-profiles.json` + atualiza a configuração):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Verificação amigável para automação (sai com `1` quando expirado/ausente, `2` quando prestes a expirar):

```bash
openclaw models status --check
```

Scripts opcionais de operações (systemd/Termux) estão documentados aqui:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` requer um TTY interativo.

## Verificando o status de autenticação do modelo

```bash
openclaw models status
openclaw doctor
```

## Controlando qual credencial é usada

### Por sessão (comando de chat)

Use `/model <alias-or-id>@<profileId>` para fixar uma credencial de provedor específica para a sessão atual (ids de perfil de exemplo: `anthropic:default`, `anthropic:work`).

Use `/model` (ou `/model list`) para um seletor compacto; use `/model status` para a visualização completa (candidatos + próximo perfil de autenticação, além de detalhes do endpoint do provedor quando configurados).

### Por agente (sobrescrita via CLI)

Defina uma sobrescrita explícita da ordem de perfis de autenticação para um agente (armazenada no `auth-profiles.json` desse agente):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Use `--agent <id>` para direcionar um agente específico; omita para usar o agente padrão configurado.

## Solução de problemas

### “Nenhuma credencial encontrada”

Se o perfil de token da Anthropic estiver ausente, execute `claude setup-token` no
**host do gateway**, depois verifique novamente:

```bash
openclaw models status
```

### Token prestes a expirar/expirado

Execute `openclaw models status` para confirmar qual perfil está expirando. Se o perfil
estiver ausente, execute novamente `claude setup-token` e cole o token outra vez.

## Requisitos

- Assinatura Claude Max ou Pro (para `claude setup-token`)
- Claude Code CLI instalada (comando `claude` disponível)
