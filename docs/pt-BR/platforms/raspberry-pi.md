---
summary: "OpenClaw no Raspberry Pi (configuração auto-hospedada econômica)"
read_when:
  - Configurando o OpenClaw em um Raspberry Pi
  - Executando o OpenClaw em dispositivos ARM
  - Construindo uma IA pessoal barata e sempre ativa
title: "Raspberry Pi"
---

# OpenClaw no Raspberry Pi

## Objetivo

Executar um Gateway OpenClaw persistente e sempre ativo em um Raspberry Pi por **~US$ 35–80** de custo único (sem taxas mensais).

Perfeito para:

- Assistente de IA pessoal 24/7
- Hub de automação residencial
- Bot de Telegram/WhatsApp de baixo consumo e sempre disponível

## Requisitos de Hardware

| Modelo do Pi    | RAM     | Funciona?   | Observações                      |
| --------------- | ------- | ----------- | -------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ Melhor    | Mais rápido, recomendado         |
| **Pi 4**        | 4GB     | ✅ Bom       | Ponto ideal para a maioria       |
| **Pi 4**        | 2GB     | ✅ OK        | Funciona, adicione swap          |
| **Pi 4**        | 1GB     | ⚠️ Apertado | Possível com swap, config mínima |
| **Pi 3B+**      | 1GB     | ⚠️ Devagar  | Funciona, mas é arrastado        |
| **Pi Zero 2 W** | 512MB   | ❌           | Não recomendado                  |

**Especificações mínimas:** 1GB de RAM, 1 núcleo, 500MB de disco  
**Recomendado:** 2GB+ de RAM, SO 64-bit, cartão SD de 16GB+ (ou SSD USB)

## O que Você Vai Precisar

- Raspberry Pi 4 ou 5 (2GB+ recomendado)
- Cartão MicroSD (16GB+) ou SSD USB (melhor desempenho)
- Fonte de alimentação (PSU oficial do Pi recomendada)
- Conexão de rede (Ethernet ou WiFi)
- ~30 minutos

## 1. Gravar o SO

Use **Raspberry Pi OS Lite (64-bit)** — não é necessário desktop para um servidor headless.

1. Baixe o [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Escolha o SO: **Raspberry Pi OS Lite (64-bit)**
3. Clique no ícone de engrenagem (⚙️) para pré-configurar:
   - Defina o hostname: `gateway-host`
   - Habilite SSH
   - Defina usuário/senha
   - Configure o WiFi (se não usar Ethernet)
4. Grave no seu cartão SD / drive USB
5. Insira e inicialize o Pi

## 2) Conectar via SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. Configuração do Sistema

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Instalar Node.js 22 (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Adicionar Swap (Importante para 2GB ou menos)

O swap evita travamentos por falta de memória:

```bash
# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize for low RAM (reduce swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6. Instalar o OpenClaw

### Opção A: Instalação Padrão (Recomendada)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Opção B: Instalação Hackeável (Para experimentar)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

A instalação hackeável dá acesso direto a logs e código — útil para depurar problemas específicos de ARM.

## 7. Executar a Integração Inicial

```bash
openclaw onboard --install-daemon
```

Siga o assistente:

1. **Modo do Gateway:** Local
2. **Autenticação:** chaves de API recomendadas (OAuth pode ser instável em Pi headless)
3. **Canais:** Telegram é o mais fácil para começar
4. **Daemon:** Sim (systemd)

## 8) Verificar a Instalação

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. Acessar o Dashboard

Como o Pi é headless, use um túnel SSH:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

Ou use o Tailscale para acesso sempre ativo:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Otimizações de Desempenho

### Use um SSD USB (Grande Melhoria)

Cartões SD são lentos e se desgastam. Um SSD USB melhora drasticamente o desempenho:

```bash
# Check if booting from USB
lsblk
```

Veja o [guia de boot USB do Pi](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) para a configuração.

### Reduzir Uso de Memória

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### Monitorar Recursos

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## Notas Específicas de ARM

### Compatibilidade de Binários

A maioria dos recursos do OpenClaw funciona em ARM64, mas alguns binários externos podem precisar de builds ARM:

| Ferramenta                              | Status ARM64 | Observações                         |
| --------------------------------------- | ------------ | ----------------------------------- |
| Node.js                 | ✅            | Funciona muito bem                  |
| WhatsApp (Baileys)   | ✅            | JS puro, sem problemas              |
| Telegram                                | ✅            | JS puro, sem problemas              |
| gog (Gmail CLI)      | ⚠️           | Verifique se há release ARM         |
| Chromium (navegador) | ✅            | `sudo apt install chromium-browser` |

Se uma skill falhar, verifique se o binário tem build ARM. Muitas ferramentas em Go/Rust têm; algumas não.

### 32-bit vs 64-bit

**Sempre use SO 64-bit.** Node.js e muitas ferramentas modernas exigem isso. Verifique com:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Configuração de Modelo Recomendada

Como o Pi é apenas o Gateway (os modelos rodam na nuvem), use modelos baseados em API:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-20250514",
        "fallbacks": ["openai/gpt-4o-mini"]
      }
    }
  }
}
```

**Não tente rodar LLMs locais em um Pi** — até modelos pequenos são lentos demais. Deixe Claude/GPT fazer o trabalho pesado.

---

## Inicialização Automática no Boot

O assistente de integração inicial configura isso, mas para verificar:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Solução de Problemas

### Falta de Memória (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Desempenho Lento

- Use SSD USB em vez de cartão SD
- Desative serviços não utilizados: `sudo systemctl disable cups bluetooth avahi-daemon`
- Verifique throttling da CPU: `vcgencmd get_throttled` (deve retornar `0x0`)

### Serviço Não Inicia

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### Problemas com Binários ARM

Se uma skill falhar com "exec format error":

1. Verifique se o binário tem build ARM64
2. Tente compilar a partir do código-fonte
3. Ou use um contêiner Docker com suporte a ARM

### Quedas de WiFi

Para Pis headless em WiFi:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Comparação de Custos

| Configuração                      | Custo Único          | Custo Mensal | Observações                                            |
| --------------------------------- | -------------------- | ------------ | ------------------------------------------------------ |
| **Pi 4 (2GB)** | ~$45 | $0           | + energia (~$5/ano) |
| **Pi 4 (4GB)** | ~$55 | $0           | Recomendado                                            |
| **Pi 5 (4GB)** | ~$60 | $0           | Melhor desempenho                                      |
| **Pi 5 (8GB)** | ~$80 | $0           | Exagero, mas à prova do futuro                         |
| DigitalOcean                      | $0                   | $6/mês       | $72/ano                                                |
| Hetzner                           | $0                   | €3,79/mês    | ~$50/ano                               |

**Ponto de equilíbrio:** um Pi se paga em ~6–12 meses em comparação a um VPS na nuvem.

---

## Veja também

- [Guia Linux](/platforms/linux) — configuração geral no Linux
- [Guia DigitalOcean](/platforms/digitalocean) — alternativa em nuvem
- [Guia Hetzner](/install/hetzner) — configuração com Docker
- [Tailscale](/gateway/tailscale) — acesso remoto
- [Nodes](/nodes) — conecte seu laptop/celular ao gateway do Pi
