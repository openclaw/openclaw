---
summary: "fluxo do app macOS para controlar um Gateway OpenClaw remoto via SSH"
read_when:
  - Ao configurar ou depurar o controle remoto do mac
title: "Controle Remoto"
---

# OpenClaw remoto (macOS ⇄ host remoto)

Este fluxo permite que o app macOS atue como um controle remoto completo para um gateway OpenClaw em execução em outro host (desktop/servidor). É o recurso do app **Remote over SSH** (execução remota). Todos os recursos — verificações de saúde, encaminhamento do Voice Wake e Web Chat — reutilizam a mesma configuração remota de SSH em _Settings → General_.

## Modos

- **Local (este Mac)**: Tudo roda no laptop. Sem SSH.
- **Remote over SSH (padrão)**: Comandos do OpenClaw são executados no host remoto. O app mac abre uma conexão SSH com `-o BatchMode` mais sua identidade/chave escolhida e um encaminhamento de porta local.
- **Remote direct (ws/wss)**: Sem túnel SSH. O app mac se conecta diretamente à URL do gateway (por exemplo, via Tailscale Serve ou um proxy reverso HTTPS público).

## Transportes remotos

O modo remoto oferece suporte a dois transportes:

- **Túnel SSH** (padrão): Usa `ssh -N -L ...` para encaminhar a porta do gateway para o localhost. O gateway verá o IP do nó como `127.0.0.1` porque o túnel é loopback.
- **Direto (ws/wss)**: Conecta diretamente à URL do gateway. O gateway vê o IP real do cliente.

## Pré-requisitos no host remoto

1. Instale Node + pnpm e construa/instale a CLI do OpenClaw (`pnpm install && pnpm build && pnpm link --global`).
2. Garanta que `openclaw` esteja no PATH para shells não interativos (crie um symlink em `/usr/local/bin` ou `/opt/homebrew/bin` se necessário).
3. Abra o SSH com autenticação por chave. Recomendamos IPs do **Tailscale** para alcance estável fora da LAN.

## Configuração do app macOS

1. Abra _Settings → General_.
2. Em **OpenClaw runs**, escolha **Remote over SSH** e defina:
   - **Transport**: **SSH tunnel** ou **Direct (ws/wss)**.
   - **SSH target**: `user@host` (opcional `:port`).
     - Se o gateway estiver na mesma LAN e anunciar via Bonjour, selecione-o na lista descoberta para preencher este campo automaticamente.
   - **Gateway URL** (apenas Direct): `wss://gateway.example.ts.net` (ou `ws://...` para local/LAN).
   - **Identity file** (avançado): caminho para sua chave.
   - **Project root** (avançado): caminho do checkout remoto usado para comandos.
   - **CLI path** (avançado): caminho opcional para um entrypoint/binário executável do `openclaw` (preenchido automaticamente quando anunciado).
3. Clique em **Test remote**. O sucesso indica que o `openclaw status --json` remoto está rodando corretamente. Falhas geralmente significam problemas de PATH/CLI; exit 127 indica que a CLI não foi encontrada remotamente.
4. As verificações de saúde e o Web Chat agora passarão automaticamente por este túnel SSH.

## Web Chat

- **Túnel SSH**: o Web Chat se conecta ao gateway pela porta de controle WebSocket encaminhada (padrão 18789).
- **Direto (ws/wss)**: o Web Chat se conecta diretamente à URL do gateway configurada.
- Não existe mais um servidor HTTP separado para WebChat.

## Permissions

- O host remoto precisa das mesmas aprovações de TCC que o local (Automação, Acessibilidade, Gravação de Tela, Microfone, Reconhecimento de Fala, Notificações). Execute a integração inicial nessa máquina para concedê-las uma vez.
- Os nós anunciam seu estado de permissões via `node.list` / `node.describe` para que os agentes saibam o que está disponível.

## Notas de segurança

- Prefira binds em loopback no host remoto e conecte via SSH ou Tailscale.
- Se você fizer bind do Gateway a uma interface não loopback, exija autenticação por token/senha.
- Veja [Security](/gateway/security) e [Tailscale](/gateway/tailscale).

## Fluxo de login do WhatsApp (remoto)

- Execute `openclaw channels login --verbose` **no host remoto**. Escaneie o QR com o WhatsApp no seu telefone.
- Refaça o login nesse host se a autenticação expirar. A verificação de saúde indicará problemas de vínculo.

## Solução de problemas

- **exit 127 / not found**: `openclaw` não está no PATH para shells não interativos. Adicione-o ao `/etc/paths`, ao rc do seu shell ou crie um symlink em `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: verifique a conectividade SSH, o PATH e se o Baileys está logado (`openclaw status --json`).
- **Web Chat travado**: confirme que o gateway está rodando no host remoto e que a porta encaminhada corresponde à porta WS do gateway; a UI requer uma conexão WS saudável.
- **Node IP mostra 127.0.0.1**: esperado com o túnel SSH. Mude **Transport** para **Direct (ws/wss)** se quiser que o gateway veja o IP real do cliente.
- **Voice Wake**: frases de gatilho são encaminhadas automaticamente no modo remoto; não é necessário um encaminhador separado.

## Sons de notificação

Escolha sons por notificação a partir de scripts com `openclaw` e `node.invoke`, por exemplo:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Não há mais uma opção global de “som padrão” no app; os chamadores escolhem um som (ou nenhum) por solicitação.
