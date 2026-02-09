---
summary: "persistência de permissões no macOS (TCC) e requisitos de assinatura"
read_when:
  - Depuração de prompts de permissão do macOS ausentes ou travados
  - Empacotamento ou assinatura do app para macOS
  - Alteração de IDs de bundle ou caminhos de instalação do app
title: "Permissões do macOS"
---

# permissões do macOS (TCC)

As concessões de permissão no macOS são frágeis. O TCC associa uma concessão de permissão à
assinatura de código do app, ao identificador de bundle e ao caminho no disco. Se qualquer
um desses mudar, o macOS trata o app como novo e pode descartar ou ocultar os prompts.

## Requisitos para permissões estáveis

- Mesmo caminho: execute o app a partir de um local fixo (para o OpenClaw, `dist/OpenClaw.app`).
- Mesmo identificador de bundle: alterar o ID do bundle cria uma nova identidade de permissão.
- App assinado: builds sem assinatura ou com assinatura ad-hoc não persistem permissões.
- Assinatura consistente: use um certificado real Apple Development ou Developer ID
  para que a assinatura permaneça estável entre rebuilds.

Assinaturas ad-hoc geram uma nova identidade a cada build. O macOS vai esquecer concessões
anteriores, e os prompts podem desaparecer completamente até que as entradas obsoletas
sejam limpas.

## Checklist de recuperação quando os prompts desaparecem

1. Encerre o app.
2. Remova a entrada do app em Ajustes do Sistema -> Privacidade e Segurança.
3. Reabra o app a partir do mesmo caminho e conceda as permissões novamente.
4. Se o prompt ainda não aparecer, redefina as entradas do TCC com `tccutil` e tente novamente.
5. Algumas permissões só reaparecem após uma reinicialização completa do macOS.

Exemplos de redefinição (substitua o ID do bundle conforme necessário):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Permissões de Arquivos e Pastas (Mesa/Documents/Downloads)

O macOS também pode restringir Mesa, Documentos e Downloads para processos de terminal/em segundo plano. Se leituras de arquivos ou listagens de diretórios travarem, conceda acesso ao mesmo contexto de processo que executa as operações de arquivo (por exemplo, Terminal/iTerm, app iniciado por LaunchAgent ou processo SSH).

Solução alternativa: mova os arquivos para o workspace do OpenClaw (`~/.openclaw/workspace`) se você quiser evitar concessões por pasta.

Se você estiver testando permissões, sempre assine com um certificado real. Builds ad-hoc
são aceitáveis apenas para execuções locais rápidas em que permissões não importam.
