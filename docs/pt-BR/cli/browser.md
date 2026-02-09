---
summary: "Referência da CLI para `openclaw browser` (perfis, abas, ações, relay da extensão)"
read_when:
  - Você usa `openclaw browser` e quer exemplos para tarefas comuns
  - Você quer controlar um navegador rodando em outra máquina via um host de nó
  - Você quer usar o relay da extensão do Chrome (anexar/desanexar via botão da barra de ferramentas)
title: "browser"
---

# `openclaw browser`

Gerencie o servidor de controle de navegador do OpenClaw e execute ações no navegador (abas, snapshots, capturas de tela, navegação, cliques, digitação).

Relacionado:

- Ferramenta de navegador + API: [Browser tool](/tools/browser)
- Relay da extensão do Chrome: [Chrome extension](/tools/chrome-extension)

## Flags comuns

- `--url <gatewayWsUrl>`: URL do WebSocket do Gateway (padrão a partir da configuração).
- `--token <token>`: token do Gateway (se necessário).
- `--timeout <ms>`: tempo limite da solicitação (ms).
- `--browser-profile <name>`: escolher um perfil de navegador (padrão a partir da configuração).
- `--json`: saída legível por máquina (onde suportado).

## Início rápido (local)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Perfis

Perfis são configurações nomeadas de roteamento do navegador. Na prática:

- `openclaw`: inicia/anexa a uma instância dedicada do Chrome gerenciada pelo OpenClaw (diretório de dados do usuário isolado).
- `chrome`: controla suas abas existentes do Chrome via o relay da extensão do Chrome.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Use um perfil específico:

```bash
openclaw browser --browser-profile work tabs
```

## Tabs

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / captura de tela / ações

Snapshot:

```bash
openclaw browser snapshot
```

Captura de tela:

```bash
openclaw browser screenshot
```

Navegar/clicar/digitar (automação de UI baseada em referência):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Relay da extensão do Chrome (anexar via botão da barra de ferramentas)

Este modo permite que o agente controle uma aba existente do Chrome que você anexa manualmente (ele não se anexa automaticamente).

Instale a extensão descompactada em um caminho estável:

```bash
openclaw browser extension install
openclaw browser extension path
```

Depois, Chrome → `chrome://extensions` → habilite “Modo do desenvolvedor” → “Carregar sem compactação” → selecione a pasta exibida.

Guia completo: [Chrome extension](/tools/chrome-extension)

## Controle remoto do navegador (proxy de host de nó)

Se o Gateway estiver em uma máquina diferente do navegador, execute um **host de nó** na máquina que tem Chrome/Brave/Edge/Chromium. O Gateway fará o proxy das ações do navegador para esse nó (nenhum servidor separado de controle do navegador é necessário).

Use `gateway.nodes.browser.mode` para controlar o roteamento automático e `gateway.nodes.browser.node` para fixar um nó específico se vários estiverem conectados.

Segurança + configuração remota: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
