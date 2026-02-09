---
summary: "Modo de execução elevado e diretivas /elevated"
read_when:
  - Ao ajustar padrões do modo elevado, listas de permissões ou comportamento de comandos com barra
title: "Modo Elevado"
---

# Modo Elevado (diretivas /elevated)

## O que ele faz

- `/elevated on` roda no host do gateway e mantém aprovações de exec (igual a `/elevated ask`).
- `/elevated full` roda no host do gateway **e** aprova automaticamente exec (pula aprovações de exec).
- `/elevated ask` roda no host do gateway, mas mantém aprovações de exec (igual a `/elevated on`).
- `on`/`ask` **não** forçam `exec.security=full`; a política de segurança/pergunta configurada ainda se aplica.
- Só muda o comportamento quando o agente está **em sandbox** (caso contrário, o exec já roda no host).
- Formas de diretiva: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- Apenas `on|off|ask|full` são aceitas; qualquer outra retorna uma dica e não muda o estado.

## O que ele controla (e o que não controla)

- **Portões de disponibilidade**: `tools.elevated` é a base global. `agents.list[].tools.elevated` pode restringir ainda mais o modo elevado por agente (ambos precisam permitir).
- **Estado por sessão**: `/elevated on|off|ask|full` define o nível elevado para a chave da sessão atual.
- **Diretiva inline**: `/elevated on|ask|full` dentro de uma mensagem se aplica apenas àquela mensagem.
- **Grupos**: em chats de grupo, diretivas elevadas só são honradas quando o agente é mencionado. Mensagens somente de comando que ignoram requisitos de menção são tratadas como mencionadas.
- **Execução no host**: elevado força `exec` no host do gateway; `full` também define `security=full`.
- **Aprovações**: `full` pula aprovações de exec; `on`/`ask` as honram quando regras de lista de permissões/pergunta exigem.
- **Agentes fora de sandbox**: sem efeito para local; afeta apenas portões, logging e status.
- **A política de ferramentas ainda se aplica**: se `exec` for negado pela política de ferramentas, o modo elevado não pode ser usado.
- **Separado de `/exec`**: `/exec` ajusta padrões por sessão para remetentes autorizados e não requer modo elevado.

## Ordem de resolução

1. Diretiva inline na mensagem (aplica-se apenas àquela mensagem).
2. Substituição da sessão (definida ao enviar uma mensagem apenas com a diretiva).
3. Padrão global (`agents.defaults.elevatedDefault` na configuração).

## Definindo um padrão de sessão

- Envie uma mensagem que seja **apenas** a diretiva (espaços em branco são permitidos), por exemplo, `/elevated full`.
- Uma resposta de confirmação é enviada (`Elevated mode set to full...` / `Elevated mode disabled.`).
- Se o acesso elevado estiver desativado ou o remetente não estiver na lista de permissões aprovada, a diretiva responde com um erro acionável e não altera o estado da sessão.
- Envie `/elevated` (ou `/elevated:`) sem argumento para ver o nível elevado atual.

## Disponibilidade + listas de permissões

- Portão do recurso: `tools.elevated.enabled` (o padrão pode estar desligado via configuração mesmo que o código suporte).
- Lista de permissões do remetente: `tools.elevated.allowFrom` com listas por provedor (por exemplo, `discord`, `whatsapp`).
- Portão por agente: `agents.list[].tools.elevated.enabled` (opcional; só pode restringir ainda mais).
- Lista de permissões por agente: `agents.list[].tools.elevated.allowFrom` (opcional; quando definida, o remetente deve corresponder **tanto** à lista global quanto à por agente).
- Fallback do Discord: se `tools.elevated.allowFrom.discord` for omitido, a lista `channels.discord.dm.allowFrom` é usada como fallback. Defina `tools.elevated.allowFrom.discord` (mesmo `[]`) para substituir. Listas por agente **não** usam o fallback.
- Todos os portões devem passar; caso contrário, o modo elevado é tratado como indisponível.

## Logging + status

- Chamadas de exec em modo elevado são registradas no nível info.
- O status da sessão inclui o modo elevado (por exemplo, `elevated=ask`, `elevated=full`).
