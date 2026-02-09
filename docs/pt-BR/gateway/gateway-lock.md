---
summary: "Proteção de singleton do Gateway usando o bind do listener WebSocket"
read_when:
  - Ao executar ou depurar o processo do gateway
  - Ao investigar a imposição de instância única
title: "Bloqueio do Gateway"
---

# Bloqueio do Gateway

Última atualização: 2025-12-11

## Por quê

- Garantir que apenas uma instância do gateway seja executada por porta base no mesmo host; gateways adicionais devem usar perfis isolados e portas exclusivas.
- Sobreviver a falhas/SIGKILL sem deixar arquivos de bloqueio obsoletos.
- Falhar rapidamente com um erro claro quando a porta de controle já estiver ocupada.

## Mecanismo

- O gateway faz o bind do listener WebSocket (padrão `ws://127.0.0.1:18789`) imediatamente na inicialização usando um listener TCP exclusivo.
- Se o bind falhar com `EADDRINUSE`, a inicialização lança `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- O SO libera o listener automaticamente em qualquer encerramento do processo, incluindo falhas e SIGKILL — não é necessário um arquivo de bloqueio separado nem etapa de limpeza.
- No desligamento, o gateway fecha o servidor WebSocket e o servidor HTTP subjacente para liberar a porta prontamente.

## Superfície de erros

- Se outro processo mantiver a porta, a inicialização lança `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Outras falhas de bind aparecem como `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`.

## Notas operacionais

- Se a porta estiver ocupada por _outro_ processo, o erro é o mesmo; libere a porta ou escolha outra com `openclaw gateway --port <port>`.
- O app do macOS ainda mantém sua própria proteção leve por PID antes de iniciar o gateway; o bloqueio em tempo de execução é imposto pelo bind do WebSocket.
