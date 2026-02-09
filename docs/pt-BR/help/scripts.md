---
summary: "Scripts do repositório: propósito, escopo e notas de segurança"
read_when:
  - Ao executar scripts do repositório
  - Ao adicionar ou alterar scripts em ./scripts
title: "Scripts"
---

# Scripts

O diretório `scripts/` contém scripts auxiliares para fluxos de trabalho locais e tarefas de operações.
Use-os quando uma tarefa estiver claramente vinculada a um script; caso contrário, prefira a CLI.

## Convenções

- Os scripts são **opcionais** a menos que sejam referenciados na documentação ou em checklists de release.
- Prefira superfícies da CLI quando existirem (exemplo: monitoramento de autenticação usa `openclaw models status --check`).
- Presuma que os scripts são específicos do host; leia-os antes de executar em uma nova máquina.

## Scripts de monitoramento de autenticação

Os scripts de monitoramento de autenticação estão documentados aqui:
[/automation/auth-monitoring](/automation/auth-monitoring)

## Ao adicionar scripts

- Mantenha os scripts focados e documentados.
- Adicione uma breve entrada no documento relevante (ou crie um se estiver faltando).
