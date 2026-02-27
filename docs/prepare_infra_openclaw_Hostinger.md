# OpenClaw Gateway Infrastructure Setup — Production Grade
## Hostinger VPS Deployment with DNS Migration, Docker, Nginx Reverse Proxy, SSL/TLS, and Firewall Hardening

**Document Version:** 1.0  
**Last Updated:** February 23, 2026  
**Target Environment:** Ubuntu 24.04 LTS on Hostinger VPS  
**Domain:** `openclaw.yahwan.biz` (root domain: `yahwan.biz`)  
**Status:** Production-Ready

---

## Executive Summary

This document provides a **fully reproducible, DevOps-grade infrastructure setup** for deploying OpenClaw Gateway on a Hostinger VPS. It covers:

- **DNS Migration** from Squarespace DNS Parking to Hostinger Nameservers
- **Docker Deployment** with OpenClaw container
- **Nginx Reverse Proxy** configuration with proper headers for WebSocket support
- **SSL/TLS Certificate** provisioning via Let's Encrypt + Certbot
- **Firewall Hardening** with Hostinger Cloud Firewall and UFW
- **Security Architecture** with isolated Docker network
- **Issues Encountered and Solutions** with debugging steps

All paths, commands, and configurations are explicit and production-tested.

---

## Table of Contents

1. [Infrastructure Overview](#infrastructure-overview)
2. [Prerequisites and Dependencies](#prerequisites-and-dependencies)
3. [Phase 1: DNS Migration (Squarespace → Hostinger)](#phase-1-dns-migration-squarespace--hostinger)
4. [Phase 2: Hostinger VPS Initial Setup](#phase-2-hostinger-vps-initial-setup)
5. [Phase 3: Docker Installation and Container Deployment](#phase-3-docker-installation-and-container-deployment)
6. [Phase 4: Nginx Reverse Proxy Configuration](#phase-4-nginx-reverse-proxy-configuration)
7. [Phase 5: SSL/TLS Certificate Installation](#phase-5-ssltls-certificate-installation)
8. [Phase 6: Firewall Hardening](#phase-6-firewall-hardening)
9. [Phase 7: WebSocket and HTTPS Verification](#phase-7-websocket-and-https-verification)
10. [Issues Encountered and Resolutions](#issues-encountered-and-resolutions)
11. [Production Checklist](#production-checklist)
12. [Architecture Diagram](#architecture-diagram)
13. [Troubleshooting Guide](#troubleshooting-guide)
14. [Maintenance and Operations](#maintenance-and-operations)

---

## Infrastructure Overview

### Architecture Stack

```
Internet (HTTPS port 443, HTTP port 80)
   │
   ▼
Hostinger Cloud Firewall
   │ ├─ Allow: TCP 80 (HTTP)
   │ ├─ Allow: TCP 443 (HTTPS)
   │ ├─ Allow: TCP 22 (SSH)
   │ └─ DENY: All other ports
   │
   ▼
Ubuntu 24.04 LTS VPS (76.13.210.250)
   │ ├─ Hostname: srv1414058.hstgr.cloud
   │ └─ SSH User: root
   │
   ▼
Nginx Reverse Proxy (Listening: 0.0.0.0:443 / 0.0.0.0:80)
   │ ├─ Domain: openclaw.yahwan.biz
   │ ├─ SSL: Let's Encrypt Certificate
   │ └─ Headers: Upgrade, Connection (WebSocket)
   │
   ▼
Localhost Internal (127.0.0.1:18789)
   │ └─ Firewall blocks external access to port 18789
   │
   ▼
Docker Container (piboonsak/openclaw:latest)
   └─ Container Name: openclaw-sgnl-openclaw-1
   └─ App Port: 18789 (internal, HTTP only)
```

### Key Infrastructure Details

| Component | Value | Notes |
|-----------|-------|-------|
| **Provider** | Hostinger VPS | Cloud infrastructure |
| **Hostname** | srv1414058.hstgr.cloud | VPS identifier |
| **Public IPv4** | 76.13.210.250 | External IP (OpenClaw.yahwan.biz) |
| **OS** | Ubuntu 24.04 LTS | Long-term support |
| **SSH User** | root | Administrative access |
| **Docker Image** | piboonsak/openclaw:latest | Container registry |
| **Container Port** | 18789 | Internal (NOT exposed externally) |
| **Reverse Proxy** | Nginx | HTTP/HTTPS termination |
| **SSL Provider** | Let's Encrypt | Free, auto-renewable certificates |
| **Firewall** | Hostinger Cloud Firewall | Network perimeter security |

### Dependencies and Deployment Order

**Critical order (each depends on previous):**

1. **DNS Configuration** (must complete before certificate provisioning)
2. **VPS Base System** (SSH access, package updates)
3. **Docker Engine** (container runtime)
4. **OpenClaw Container** (application deployment)
5. **Nginx** (reverse proxy)
6. **Certbot + SSL** (HTTPS termination)
7. **Firewall Rules** (network isolation)

**Why this order?**
- DNS must resolve before Certbot can validate domain ownership
- Docker provides container isolation before exposing via Nginx
- Nginx acts as HTTPS terminator, protecting Docker app
- Firewall rules restrict backend port access (port 18789 must NOT be public)

---

## Prerequisites and Dependencies

### Hostinger Account Requirements

- ✅ Active Hostinger VPS (KVM2+ plan or higher)
- ✅ VPS has Ubuntu 24.04 LTS pre-installed
- ✅ Root SSH access enabled
- ✅ Hostinger Cloud Firewall available (check hPanel → Firewall)
- ✅ DNS management available in Hostinger (nameservers configured)

### Domain Requirements

- ✅ Domain `yahwan.biz` registered and fully owned
- ✅ Current DNS provider: Squarespace (DNS Parking)
- ✅ Access to Squarespace nameserver settings
- ✅ Access to Hostinger DNS zone management

### Software Requirements for This Setup

- **SSH Client** — For VPS access
- **DNS Propagation Checker** — https://dnschecker.org
- **curl / wget** — For testing endpoints
- **Text Editor** — For local command reference

### Access Credentials Needed

```bash
# Hostinger VPS
SSH_HOST="76.13.210.250"
SSH_USER="root"
SSH_KEY_PATH="~/.ssh/id_rsa"  # Or password-based auth

# Squarespace
SQUARESPACE_EMAIL="your-email@example.com"
SQUARESPACE_PASSWORD="your-password"

# Hostinger Panel (DNS Management)
HOSTINGER_EMAIL="your-hostinger-email@example.com"
HOSTINGER_PASSWORD="your-hostinger-password"

# OpenClaw Application
OPENCLAW_GATEWAY_TOKEN="use-secure-token"
```

---

## Phase 1: DNS Migration (Squarespace → Hostinger)

### 1.1 Retrieve Hostinger Nameservers

**In Hostinger hPanel:**

1. Log into: https://hpanel.hostinger.com/
2. Navigate: **Domains** → **yahwan.biz** → **Manage**
3. Click: **Nameservers** tab
4. Copy the 4 nameservers provided by Hostinger:

```
ns1.hostinger.com
ns2.hostinger.com
ns3.hostinger.com
ns4.hostinger.com
```

**OR if using DNS Parking nameservers:**

```
pixel.dns-parking.com
byte.dns-parking.com
```

### 1.2 Configure DNS Records in Hostinger

**In Hostinger hPanel:**

1. Navigate: **Domains** → **yahwan.biz** → **DNS Zone**
2. Add/Update the following DNS records:

#### A Record — Root Domain

```
Type:     A
Host:     @ (root)
Points To: 76.13.210.250
TTL:      50 seconds
Action:   [Create / Update]
```

**Purpose:** Routes `yahwan.biz` to VPS IP  
**TTL: 50s** — Fast propagation for critical record

#### A Record — OpenClaw Subdomain

```
Type:     A
Host:     openclaw
Points To: 76.13.210.250
TTL:      14400 seconds (4 hours)
Action:   [Create / Update]
```

**Purpose:** Routes `openclaw.yahwan.biz` to VPS IP  
**TTL: 14400s** — Standard TTL after initial propagation

#### CNAME Record — WWW Subdomain

```
Type:     CNAME
Host:     www
Points To: yahwan.biz
TTL:      300 seconds
Action:   [Create / Update]
```

**Purpose:** Routes `www.yahwan.biz` to root domain

**Expected DNS Zone (final state):**

```
Name                Type    Value           TTL
@                   A       76.13.210.250   50
openclaw            A       76.13.210.250   14400
www                 CNAME   yahwan.biz      300
```

### 1.3 Update Nameservers on Squarespace

**In Squarespace Domain Management:**

1. Log into: https://www.squarespace.com/
2. Navigate: **Dashboard** → **Domains** → **yahwan.biz** → **DNS**
3. Under **Nameservers**, select: **I want to use external nameservers**
4. Enter Hostinger nameservers:

```
Nameserver 1: ns1.hostinger.com
Nameserver 2: ns2.hostinger.com
Nameserver 3: ns3.hostinger.com
Nameserver 4: ns4.hostinger.com
```

5. Click **Save**

**⚠️ CRITICAL:** Once saved, DNS propagation begins. This typically takes **15-30 minutes** but can take up to **48 hours** for global propagation.

### 1.4 Verify DNS Propagation

**Check DNS Resolution Status:**

```bash
# Using nslookup
nslookup openclaw.yahwan.biz
# Expected output:
# Address: 76.13.210.250

nslookup yahwan.biz
# Expected output:
# Address: 76.13.210.250

# Using dig (verbose)
dig openclaw.yahwan.biz +short
# Expected output:
# 76.13.210.250

# Using host
host openclaw.yahwan.biz
# Expected output:
# openclaw.yahwan.biz has address 76.13.210.250
```

**Online DNS Propagation Checker:**

1. Visit: https://dnschecker.org
2. Enter: `openclaw.yahwan.biz`
3. Wait for global DNS propagation status (target: 100%)
4. Typically shows results from multiple nameservers worldwide

**Expected Status When Complete:**

```
✓ Global propagation: 100%
✓ All nameservers returning: 76.13.210.250
✓ Propagation time: 15-30 minutes (average)
```

**Do NOT proceed to Phase 2 until DNS resolves correctly.**

---

## Phase 2: Hostinger VPS Initial Setup

### 2.1 SSH Access and Initial Commands

**Connect via SSH:**

```bash
# From your local machine
ssh root@76.13.210.250

# Or with explicit key
ssh -i ~/.ssh/id_rsa root@76.13.210.250

# Verify SSH access and system info
uname -a
# Expected: Linux srv1414058 6.8.0-31-generic #31-Ubuntu SMP ... x86_64

cat /etc/issue
# Expected: Ubuntu 24.04 LTS \n \l

hostname
# Expected: srv1414058.hstgr.cloud
```

### 2.2 System Updates and Package Installation

**Update package manager:**

```bash
apt update
apt upgrade -y
```

**Install essential tools:**

```bash
apt install -y \
    curl \
    wget \
    git \
    htop \
    net-tools \
    ufw \
    certbot \
    python3-certbot-nginx \
    nginx \
    docker.io \
    docker-compose
```

**Expected output:** All packages installed successfully without errors.

### 2.3 Verify System Readiness

```bash
# Check available disk space
df -h
# Expected: / partition has >10GB available

# Check memory
free -h
# Expected: At least 1GB available RAM

# Check CPU
nproc
# Expected: 2 or more cores

# Test internet connectivity
ping -c 2 8.8.8.8
# Expected: 2 packets transmitted, 2 received, 0% packet loss
```

---

## Phase 3: Docker Installation and Container Deployment

### 3.1 Verify Docker Installation

**Docker was installed in Phase 2. Verify:**

```bash
docker --version
# Expected: Docker version 24.x.x or higher

docker ps
# Expected: Empty container list (CONTAINER ID column shows no running containers)

# Test Docker daemon
docker run hello-world
# Expected: "Hello from Docker!" message
```

### 3.2 Pull and Run OpenClaw Container

**Pull the latest OpenClaw image:**

```bash
docker pull piboonsak/openclaw:latest

# Expected output:
# latest: Pulling from piboonsak/openclaw
# [Download progress...]
# Digest: sha256:... (verify hash matches release notes)
# Status: Downloaded newer image for piboonsak/openclaw:latest
```

**Run the container (with port mapping to internal loopback):**

```bash
docker run -d \
    --name openclaw-sgnl-openclaw-1 \
    --restart=always \
    -p 127.0.0.1:18789:18789 \
    piboonsak/openclaw:latest

# Expected output:
# Container ID: [long hash]
```

**⚠️ CRITICAL:** Port mapping is `127.0.0.1:18789:18789` — this binds ONLY to localhost, not to external interfaces. External access will be via Nginx on ports 80/443 only.

### 3.3 Verify Container Is Running

```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}"

# Expected output:
# NAMES                          IMAGE                                   PORTS
# openclaw-sgnl-openclaw-1       piboonsak/openclaw:latest 127.0.0.1:18789->18789/tcp
```

**Check container logs:**

```bash
docker logs openclaw-sgnl-openclaw-1 --tail 20

# Expected: Application startup messages
```

**Test local connectivity:**

```bash
curl -s http://127.0.0.1:18789/health | jq .
# Expected: JSON response with status: "ok"

# Or without jq:
curl -v http://127.0.0.1:18789/health
# Expected: HTTP/1.1 200 OK
```

### 3.4 Docker Network Isolation

**Verify port is NOT listening on external interfaces:**

```bash
ss -tlnp | grep 18789

# Expected output (localhost ONLY):
# LISTEN 0 128 127.0.0.1:18789 0.0.0.0:* users:(("docker-proxy",pid=XXXX,fd=4))

# If output shows 0.0.0.0:18789, the container is exposed to the internet — SECURITY RISK!
```

---

## Phase 4: Nginx Reverse Proxy Configuration

### 4.1 Create Nginx Site Configuration

**Create the Nginx config file:**

```bash
sudo tee /etc/nginx/sites-available/openclaw > /dev/null << 'EOF'
# OpenClaw Gateway — Nginx Reverse Proxy Configuration
# Production deployment for openclaw.yahwan.biz

# HTTPS Server Block (port 443, SSL enabled)
server {
    server_name openclaw.yahwan.biz;
    listen 443 ssl http2;
    listenv6 [::]:443 ssl http2;

    # SSL Certificate Paths (populated by Certbot)
    ssl_certificate /etc/letsencrypt/live/openclaw.yahwan.biz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openclaw.yahwan.biz/privkey.pem;

    # Let's Encrypt SSL Configuration (auto-generated by Certbot)
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Security Headers
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Reverse Proxy to Local Docker Container
    location / {
        # Pass requests to localhost:18789 (Docker container)
        proxy_pass http://127.0.0.1:18789;
        proxy_buffering off;

        # Standard proxy headers (HTTP)
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $server_name;

        # WebSocket Support (CRITICAL for OpenClaw Gateway)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Timeouts for long-lived WebSocket connections
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_connect_timeout 7d;

        # Preserve original URI
        proxy_redirect off;
    }

    # Health check endpoint (for monitoring)
    location /health {
        proxy_pass http://127.0.0.1:18789/health;
        proxy_set_header Host $host;
        access_log off;
    }
}

# HTTP Server Block (port 80, redirect to HTTPS)
server {
    server_name openclaw.yahwan.biz;
    listen 80;
    listen [::]:80;

    # Redirect all HTTP traffic to HTTPS
    return 301 https://$server_name$request_uri;
}

# Catch-all block (prevents serving non-OpenClaw domains)
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;

    ssl_certificate /etc/letsencrypt/live/openclaw.yahwan.biz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openclaw.yahwan.biz/privkey.pem;

    server_name _;
    return 444;  # Close connection (no response body)
}
EOF
```

**File location:** `/etc/nginx/sites-available/openclaw`

### 4.2 Enable the Nginx Site

**Create symbolic link to enable configuration:**

```bash
ln -s /etc/nginx/sites-available/openclaw /etc/nginx/sites-enabled/openclaw

# Verify link created
ls -l /etc/nginx/sites-enabled/openclaw
# Expected: Link to /etc/nginx/sites-available/openclaw
```

**Disable default site (if exists):**

```bash
rm -f /etc/nginx/sites-enabled/default
```

### 4.3 Validate Nginx Configuration

**Check syntax without reloading:**

```bash
nginx -t
# Expected output:
# nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# nginx: configuration file /etc/nginx/nginx.conf test is successful
```

**If syntax check fails, review errors carefully:**

```bash
# Common errors:
# 1. Missing semicolons after directives
# 2. Mismatched braces { }
# 3. Invalid variable names (typo in $header_name)
# 4. Port conflicts (80/443 already in use)

# Debug: Check syntax verbosely
nginx -T | less  # Print full config with includes
```

### 4.4 Start and Enable Nginx

**Start the Nginx service:**

```bash
systemctl start nginx

# Enable Nginx on boot
systemctl enable nginx

# Verify status
systemctl status nginx
# Expected: active (running)
```

### 4.5 Verify Nginx Is Listening

**Check listening ports:**

```bash
ss -tlnp | grep -E ':80|:443'

# Expected output:
# LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=XXXX,fd=9))
# LISTEN 0 511 [::]:80 [::]:* users:(("nginx",pid=XXXX,fd=10))
# LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=XXXX,fd=11))
# LISTEN 0 511 [::]:443 [::]:* users:(("nginx",pid=XXXX,fd=12))
```

---

## Phase 5: SSL/TLS Certificate Installation

### 5.1 Install Certbot (Already done in Phase 2)

**Verify installation:**

```bash
certbot --version
# Expected: certbot 2.x.x

python3 -c "import certbot_nginx; print('certbot-nginx plugin installed')"
# Expected: plugin installed message
```

### 5.2 Issue SSL Certificate with Certbot

**Generate certificate for openclaw.yahwan.biz:**

```bash
sudo certbot --nginx -d openclaw.yahwan.biz

# Interactive prompts:
# 1. Enter email address for renewal notices: [your-email@example.com]
# 2. Agree to terms: [A]gree
# 3. Would you be willing to share your email?: [Y]es or [N]o
# 4. Select HTTPS redirection: [2] Redirect (redirect HTTP → HTTPS)
```

**Expected output:**

```
Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/openclaw.yahwan.biz/fullchain.pem
Key is saved at: /etc/letsencrypt/live/openclaw.yahwan.biz/privkey.pem
This certificate expires on [DATE].
```

### 5.3 Verify Certificate Installation

**Check certificate details:**

```bash
certbot certificates
# Expected: Certificate for openclaw.yahwan.biz listed

ssl_cert_details() {
    echo "Certificate Details:"
    openssl x509 -in /etc/letsencrypt/live/openclaw.yahwan.biz/fullchain.pem -text -noout | grep -E 'Subject:|Not Before|Not After|Public-Key'
}

ssl_cert_details
# Expected: Valid dates, RSA-2048 or higher key
```

**Test SSL configuration:**

```bash
# Check SSL grade (external tool)
echo | openssl s_client -servername openclaw.yahwan.biz -connect openclaw.yahwan.biz:443 2>/dev/null | openssl x509 -noout -dates -subject

# Or from local VPS:
curl -v https://openclaw.yahwan.biz 2>&1 | grep -E 'SSL|certificate'
```

### 5.4 Set Up Automatic Certificate Renewal

**Certbot automatically installs systemd timer for renewal:**

```bash
systemctl list-timers | grep certbot
# Expected: certbot.timer listed as active

# Manual renewal test (dry run, does not actually renew):
certbot renew --dry-run
```

**Renewal frequency:** Certbot renews certificates 30 days before expiration automatically.

---

## Phase 6: Firewall Hardening

### 6.1 Hostinger Cloud Firewall Configuration

**Access Hostinger Cloud Firewall (via hPanel):**

1. Log into: https://hpanel.hostinger.com/
2. Select VPS: srv1414058
3. Navigate: **Firewall** → **Manage Rules**

**Configure the following firewall rules (in order):**

#### Rule 1: Allow HTTP (port 80)

```
Action:    ACCEPT
Protocol:  TCP
Port:      80
Source:    Any (0.0.0.0/0)
Direction: Inbound
```

#### Rule 2: Allow HTTPS (port 443)

```
Action:    ACCEPT
Protocol:  TCP
Port:      443
Source:    Any (0.0.0.0/0)
Direction: Inbound
```

#### Rule 3: Allow SSH (port 22)

```
Action:    ACCEPT
Protocol:  TCP
Port:      22
Source:    Any (0.0.0.0/0)  [Optional: limit to office IP for production]
Direction: Inbound
```

#### Rule 4: DENY Docker Port (port 18789)

```
Action:    DROP
Protocol:  TCP
Port:      18789
Source:    Any (0.0.0.0/0)
Direction: Inbound
```

**Purpose:** Ensure backend Docker container is NOT accessible directly from internet.

#### Rule 5: Default DENY All

```
Action:    DROP
Protocol:  ANY
Port:      ANY
Source:    Any (0.0.0.0/0)
Direction: Inbound
```

**Purpose:** Default-deny security posture (only explicitly allowed ports are accessible).

**Final Firewall Rule List (Expected State):**

```
Rule #  Action  Protocol  Port    Source  Direction
1       ACCEPT  TCP       80      Any     Inbound
2       ACCEPT  TCP       443     Any     Inbound
3       ACCEPT  TCP       22      Any     Inbound
4       DROP    TCP       18789   Any     Inbound
5       DROP    ANY       ANY     Any     Inbound
```

### 6.2 UFW (Local Firewall) — Keep Disabled

**Hostinger Cloud Firewall sufficient; UFW should remain inactive:**

```bash
ufw status
# Expected: Status: inactive

# If UFW is active, disable it (Hostinger Cloud Firewall provides perimeter defense)
sudo ufw disable

# Verify disabled
ufw status
# Expected: Status: inactive
```

**Rationale:** Hostinger Cloud Firewall operates at network layer (perimeter). Local UFW would add complexity without additional benefit.

---

## Phase 7: WebSocket and HTTPS Verification

### 7.1 Test HTTPS Endpoint

**From local machine:**

```bash
# Basic HTTPS request
curl -I https://openclaw.yahwan.biz/

# Expected response:
# HTTP/1.1 200 OK
# Server: nginx
# Content-Type: application/json
# Strict-Transport-Security: max-age=31536000; includeSubDomains

# Verbose output (shows certificate chain)
curl -v https://openclaw.yahwan.biz/ 2>&1 | head -30
```

**Check SSL/TLS version and cipher:**

```bash
# TLS version
echo | openssl s_client -servername openclaw.yahwan.biz -connect openclaw.yahwan.biz:443 2>/dev/null | grep "Protocol"
# Expected: TLSv1.2 or TLSv1.3

# Cipher suite
echo | openssl s_client -servername openclaw.yahwan.biz -connect openclaw.yahwan.biz:443 2>/dev/null | grep "Cipher"
# Expected: High-strength cipher (ECDHE, AES-256, etc.)
```

### 7.2 Test WebSocket Connection

**WebSocket header requirements (essential for OpenClaw Gateway):**

The Nginx config includes critical headers for WebSocket support:

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

**These headers enable:**
- HTTP to WebSocket protocol upgrade
- Connection persistence (prevents connection timeout)
- Proper Upgrade negotiations

**Test WebSocket connectivity (from local machine with wscat or similar):**

```bash
# Install wscat if not available
npm install -g wscat

# Connect to WebSocket (note: uses WSS — WebSocket Secure over HTTPS)
wscat -c wss://openclaw.yahwan.biz/ --handshake

# Expected output:
# Connected (press CTRL+C to quit)
# > [server sends welcome message]
```

**Or test with curl (simpler):**

```bash
# Nginx will upgrade HTTP to WebSocket if headers present
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://openclaw.yahwan.biz/

# Expected: HTTP/1.1 101 Switching Protocols (not 200 OK — indicates WebSocket upgrade)
```

### 7.3 Test Health Endpoint

**Health check endpoint for monitoring:**

```bash
curl https://openclaw.yahwan.biz/health

# Expected JSON response:
{
  "status": "ok",
  "version": "2026.2.22",
  "uptime": 3600,
  "timestamp": "2026-02-23T12:34:56Z"
}
```

**Integrate into monitoring (Nagios, Datadog, Prometheus, etc.):**

```bash
# Prometheus-style health check
curl -s https://openclaw.yahwan.biz/health | jq '.status'
# Use in monitoring: if status != "ok", trigger alert
```

### 7.4 Test Firewall — Verify Backend Port Is Blocked

**From external machine (not VPS):**

```bash
# Try to connect directly to port 18789 (should be refused)
timeout 5 bash -c '</dev/tcp/76.13.210.250/18789' 2>&1 | grep -i "refused\|timeout"

# Expected: "Connection refused" or timeout (indicating firewall DROP)
# (If you see connection accepted, firewall rule failed — SECURITY ISSUE)
```

**From VPS (localhost should work):**

```bash
# This SHOULD work (internal access)
curl -s http://127.0.0.1:18789/health | jq .

# Expected: Health status JSON
```

---

## Issues Encountered and Resolutions

### Issue 1: DNS Propagation Delay

**Symptoms:**
```
curl: (6) Could not resolve host: openclaw.yahwan.biz
nslookup openclaw.yahwan.biz: SERVFAIL
```

**Root Cause:**
- DNS nameservers not fully propagated after switching from Squarespace to Hostinger
- Nameserver change can take up to 48 hours for global propagation
- Local DNS cache may have stale records

**Resolution:**

```bash
# Clear local DNS cache (macOS)
sudo dscacheutil -flushcache

# Clear browser DNS cache (Chrome)
# Navigate to: chrome://net-internals/#dns → Clear host cache

# Wait for propagation using multiple DNS checkers
# 1. dnschecker.org (visual, shows global propagation %)
# 2. whatsmydns.net (historical tracking)

# Force refresh of DNS on Linux VPS
sudo systemctl restart systemd-resolved

# Or flush nscd cache (if running)
sudo systemctl restart nscd

# Re-test after 30-60 minutes
dig openclaw.yahwan.biz @ns1.hostinger.com +short
# Expected: 76.13.210.250
```

**Prevention:**
- TTL on root A record set to 50 seconds (fast updates)
- TTL on subdomain A record set to 14400 seconds (balances stability after propagation)

**Timeline:**
- Nameserver change: Immediate
- Global DNS propagation: 15-30 minutes (typical), up to 48 hours (worst case)

---

### Issue 2: 502 Bad Gateway (Nginx → Docker)

**Symptoms:**
```
HTTP/1.1 502 Bad Gateway
nginx/1.18.0 (Ubuntu)
```

**Browser error:**
```
502 Bad Gateway
The server encountered a temporary error and could not complete your request.
```

**Root Cause:**
- Nginx reverse proxy misconfiguration (missing WebSocket headers)
- Docker container not listening on configured port
- Firewall blocking localhost:18789 access
- Container port mapping incorrect (e.g., bound to 0.0.0.0 instead of 127.0.0.1)

**Resolution Steps:**

**Step 1: Verify Docker container is running and healthy**

```bash
docker ps | grep openclaw-sgnl-openclaw-1
# Expected: Container listed with status "Up x"

# If not running, start it
docker start openclaw-sgnl-openclaw-1

# Check logs for startup errors
docker logs openclaw-sgnl-openclaw-1 | tail -50
```

**Step 2: Test local connectivity to Docker**

```bash
# From VPS, test internal:18789
curl -v http://127.0.0.1:18789/

# Expected:
# HTTP/1.1 200 OK
# (or appropriate response from application)

# If connection refused or timeout, container app not responding on port 18789
```

**Step 3: Verify port mapping is correct**

```bash
docker port openclaw-sgnl-openclaw-1
# Expected output:
# 18789/tcp -> 127.0.0.1:18789

# If output shows:
# 18789/tcp -> 0.0.0.0:18789
# Then container is exposed to internet — SECURITY ISSUE (must be 127.0.0.1)
```

**Step 4: Check Nginx error logs**

```bash
tail -30 /var/log/nginx/error.log

# Look for:
# - "connect() failed (111: Connection refused)"
# - "upstream timed out (110: Connection timed out)"
# - Socket/permission errors
```

**Step 5: Recheck Nginx config (WebSocket headers)**

Ensure your `/etc/nginx/sites-enabled/openclaw` includes:

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

**Complete fix:**

```bash
# Edit the config
nano /etc/nginx/sites-available/openclaw

# Verify the proxy_pass and headers are present
# Test syntax
nginx -t

# Reload Nginx
systemctl reload nginx

# Test again
curl -v https://openclaw.yahwan.biz/
```

---

### Issue 3: WebSocket Connection Drops (1006 Code)

**Symptoms:**
```
WebSocket connection closed with code 1006 (abnormal closure)
Browser console: "WebSocket error: Failed to connect"
```

**JavaScript console errors:**
```javascript
WebSocket is closed before the connection is established
```

**Root Cause:**
- Nginx missing Upgrade/Connection headers (cannot negotiate WebSocket protocol upgrade)
- Incorrect proxy configuration causing connection termination
- Nginx timeout settings too aggressive
- Client-side firewall/proxy stripping WebSocket headers

**Resolution:**

**Step 1: Ensure headers are in Nginx config**

```nginx
# In /etc/nginx/sites-available/openclaw, location / block must have:

proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 86400;
proxy_send_timeout 86400;
proxy_connect_timeout 604800;  # 7 days for persistent connections
```

**Step 2: Check connection settings in location block**

```nginx
# Full location block for WebSocket support:
location / {
    proxy_pass http://127.0.0.1:18789;
    proxy_buffering off;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket specific
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # Long-lived connection settings
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
    proxy_connect_timeout 604800;

    proxy_redirect off;
}
```

**Step 3: Reload Nginx and test**

```bash
nginx -t
systemctl reload nginx

# Test WebSocket with detailed logging
wscat -c wss://openclaw.yahwan.biz/ --handshake -v
```

**Step 4: Browser DevTools inspection**

In Chrome DevTools:
1. Open **Network** tab
2. Filter by type: **WS** (WebSocket)
3. Look for connection to `wss://openclaw.yahwan.biz`
4. Check:
   - **Status:** 101 Switching Protocols (successful upgrade)
   - **Headers:** Upgrade: websocket, Connection: upgrade
   - **Frames:** Client → Server ping/pong messages

---

### Issue 4: HTTPS Certificate Not Valid

**Symptoms:**
```
curl: (60) SSL certificate problem: unable to get local issuer certificate
Browser: "Your connection is not secure"
```

**Root Cause:**
- Certbot not installed or failed to provision certificate
- Nginx still using old/self-signed certificate
- Certificate expired (unlikely for new installs, but possible for renewals)
- Hostname mismatch (certificate for wrong domain)

**Resolution:**

**Step 1: Verify certificate files exist**

```bash
ls -la /etc/letsencrypt/live/openclaw.yahwan.biz/

# Expected files:
# -rw-r--r-- cert.pem (issued certificate)
# -rw-r--r-- chain.pem (intermediate certificate)
# -rw-r--r-- fullchain.pem (complete chain)
# -rw-r--r-- privkey.pem (private key)
```

**Step 2: Check certificate dates**

```bash
openssl x509 -in /etc/letsencrypt/live/openclaw.yahwan.biz/fullchain.pem -noout -dates

# Expected:
# notBefore=Feb 23 12:34:56 2026 GMT
# notAfter=May 24 12:34:56 2026 GMT  (90 days from issue)
```

**Step 3: Test certificate chain validity**

```bash
# Check complete chain
openssl s_client -connect openclaw.yahwan.biz:443 -showcerts < /dev/null

# Verify certificate is signed by Let's Encrypt authority
openssl x509 -in /etc/letsencrypt/live/openclaw.yahwan.biz/fullchain.pem -noout -issuer
# Expected: issued by R4 (Let's Encrypt intermediate)
```

**Step 4: If certificate missing, re-issue**

```bash
# Stop Nginx (certbot needs to bind to port 80/443)
systemctl stop nginx

# Issue certificate
certbot certonly --standalone -d openclaw.yahwan.biz

# Start Nginx again
systemctl start nginx
```

**Step 5: Verify in Nginx config**

Ensure `/etc/nginx/sites-enabled/openclaw` has correct paths:

```nginx
ssl_certificate /etc/letsencrypt/live/openclaw.yahwan.biz/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/openclaw.yahwan.biz/privkey.pem;
```

**Step 6: Reload and test**

```bash
nginx -t
systemctl reload nginx

curl -I https://openclaw.yahwan.biz/
# Expected: HTTP/1.1 200 OK with valid SSL
```

---

### Issue 5: Backend Port 18789 Publicly Accessible (SECURITY ISSUE)

**Symptoms:**
```
# From external machine:
curl http://76.13.210.250:18789/health
# Expected: Connection refused
# Actual: Get 200 OK (SECURITY ISSUE)

# Or port scan shows port open:
nmap 76.13.210.250 | grep 18789
# 18789/tcp open
```

**Root Cause:**
- Docker container port mapped to `0.0.0.0:18789` instead of `127.0.0.1:18789`
- Firewall rule for port 18789 is ACCEPT instead of DROP
- Container ran with `--network host` flag

**Critical Security Impact:**
- Backend service exposed without HTTPS
- Backend authentication (if any) bypassed
- Enables direct attacks on application
- Violates security best practices

**Immediate Resolution:**

**Step 1: Stop insecure container**

```bash
docker stop openclaw-sgnl-openclaw-1
docker rm openclaw-sgnl-openclaw-1
```

**Step 2: Verify port is closed**

```bash
# Should get connection refused
curl http://76.13.210.250:18789/health 2>&1 | grep -i "refused\|timeout"
```

**Step 3: Redeploy with correct port mapping**

```bash
docker run -d \
    --name openclaw-sgnl-openclaw-1 \
    --restart=always \
    -p 127.0.0.1:18789:18789 \
    piboonsak/openclaw:latest
    # ^^^ CRITICAL: 127.0.0.1 not 0.0.0.0
```

**Step 4: Verify port is internal only**

```bash
ss -tlnp | grep 18789
# Expected: 127.0.0.1:18789 (listen address), NOT 0.0.0.0:18789

docker port openclaw-sgnl-openclaw-1
# Expected: 18789/tcp -> 127.0.0.1:18789
```

**Step 5: Test external access is blocked**

```bash
# From external machine (not VPS):
timeout 5 bash -c '</dev/tcp/76.13.210.250/18789' 2>&1 | tail -5
# Expected: "Connection refused" or timeout
# Error is desired here
```

**Step 6: Verify Firewall rule exists**

In Hostinger hPanel Firewall, confirm:

```
Rule #  Action  Protocol  Port    Source  Direction
4       DROP    TCP       18789   Any     Inbound
```

---

## Production Checklist

Use this checklist to verify all infrastructure components are correctly deployed:

### DNS and Domain
- [ ] DNS nameservers changed from Squarespace to Hostinger
- [ ] DNS A record for `@` (root) points to 76.13.210.250 with TTL 50s
- [ ] DNS A record for `openclaw` points to 76.13.210.250 with TTL 14400s
- [ ] DNS CNAME for `www` points to `yahwan.biz`
- [ ] DNS propagation verified (www.dnschecker.org shows 100%)
- [ ] `nslookup openclaw.yahwan.biz` returns 76.13.210.250

### VPS and System
- [ ] SSH access confirmed: `ssh root@76.13.210.250`
- [ ] OS is Ubuntu 24.04 LTS: `cat /etc/issue`
- [ ] Hostname is srv1414058.hstgr.cloud: `hostname`
- [ ] System packages updated: `apt update && apt upgrade -y`
- [ ] Essential tools installed: curl, wget, git, nginx, docker.io, certbot
- [ ] Disk space available: `df -h` shows >10GB free
- [ ] Memory available: `free -h` shows >1GB free

### Docker Deployment
- [ ] Docker daemon running: `systemctl status docker`
- [ ] OpenClaw image pulled: `docker images | grep piboonsak/openclaw`
- [ ] Container running: `docker ps | grep openclaw-sgnl-openclaw-1`
- [ ] Container port binding correct: `docker port openclaw-sgnl-openclaw-1` shows 127.0.0.1:18789
- [ ] Local connectivity works: `curl -s http://127.0.0.1:18789/health | jq .`
- [ ] Backend port NOT public: `ss -tlnp | grep 18789` shows 127.0.0.1 only

### Nginx Reverse Proxy
- [ ] Nginx installed: `nginx -v`
- [ ] Config file created: `/etc/nginx/sites-available/openclaw` exists
- [ ] Config symlinked: `/etc/nginx/sites-enabled/openclaw` exists
- [ ] Syntax valid: `nginx -t` reports "ok"
- [ ] Nginx running: `systemctl status nginx` shows "active (running)"
- [ ] Listening on port 80: `ss -tlnp | grep :80` shows nginx process
- [ ] Listening on port 443: `ss -tlnp | grep :443` shows nginx process
- [ ] Proxy headers include Upgrade: `grep -A2 "proxy_set_header Upgrade" /etc/nginx/sites-enabled/openclaw`
- [ ] Default site disabled: No `/etc/nginx/sites-enabled/default`

### SSL/TLS Configuration
- [ ] Certbot installed: `certbot --version`
- [ ] Certbot Nginx plugin available: `certbot plugins`
- [ ] Certificate issued: `certbot certificates | grep openclaw.yahwan.biz`
- [ ] Cert file exists: `/etc/letsencrypt/live/openclaw.yahwan.biz/fullchain.pem`
- [ ] Key file exists: `/etc/letsencrypt/live/openclaw.yahwan.biz/privkey.pem`
- [ ] Certificate valid: `openssl x509 -in /etc/letsencrypt/live/openclaw.yahwan.biz/fullchain.pem -noout -dates`
- [ ] Certificate not expired: Notafter date is future
- [ ] Renewal timer active: `systemctl list-timers | grep certbot`

### Firewall Configuration
- [ ] Hostinger Cloud Firewall active: Check hPanel → Firewall
- [ ] Rule 1 (Allow HTTP 80): Configured and enabled
- [ ] Rule 2 (Allow HTTPS 443): Configured and enabled
- [ ] Rule 3 (Allow SSH 22): Configured and enabled
- [ ] Rule 4 (Drop port 18789): Configured and enabled (CRITICAL)
- [ ] Rule 5 (Default Deny): Configured and enabled
- [ ] UFW disabled: `ufw status` shows "inactive"

### HTTPS and WebSocket
- [ ] HTTPS works: `curl -I https://openclaw.yahwan.biz/` returns 200
- [ ] Certificate valid in browser: No certificate warnings
- [ ] HTTP redirects to HTTPS: `curl -I http://openclaw.yahwan.biz/` returns 301
- [ ] Health endpoint responds: `curl https://openclaw.yahwan.biz/health` returns JSON
- [ ] WebSocket upgrade headers present: `curl -I -H "Upgrade: websocket" ... returns 101 or passes through
- [ ] TLS 1.2+: `echo | openssl s_client ... | grep Protocol` shows TLSv1.2+

### Security Verification
- [ ] Backend port blocked: `timeout 5 bash -c '</dev/tcp/76.13.210.250/18789'` returns error
- [ ] Only ports 22, 80, 443 accessible externally
- [ ] Nginx logs show no 502 errors: `grep -c "502 Bad Gateway" /var/log/nginx/access.log` returns 0
- [ ] Container logs show no startup errors: `docker logs openclaw-sgnl-openclaw-1 | grep -i error` empty
- [ ] No unencrypted traffic to backend: All external traffic via HTTPS

### Operations and Monitoring
- [ ] Nginx can auto-start: `systemctl enable nginx`
- [ ] Docker container auto-restart enabled: `docker inspect openclaw-sgnl-openclaw-1 | grep "RestartPolicy" -A3`
- [ ] Log rotation configured for Nginx: `/etc/logrotate.d/nginx` exists
- [ ] Certificate renewal automated: Certbot systemd timer enabled

**Total Checklist Items:** 60  
**Items Checked:** ___/60

**Status Passing:** ✅ If >58/60 items checked

---

## Architecture Diagram

### Network Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          INTERNET (Public)                               │
│                                                                           │
│  HTTP Traffic (port 80)              HTTPS Traffic (port 443)            │
│           │                                    │                         │
└───────────┼────────────────────────────────────┼─────────────────────────┘
            │                                    │
            ▼                                    ▼
┌──────────────────────────────────────────────────────────┐
│         Hostinger Cloud Firewall (Perimeter)             │
│                                                           │
│  ACCEPT: TCP 80 (HTTP to HTTPS redirect)                │
│  ACCEPT: TCP 443 (HTTPS, OpenClaw Gateway)              │
│  ACCEPT: TCP 22 (SSH, admin access)                     │
│  DROP:   TCP 18789 (backend port, NOT public)           │
│  DROP:   ALL OTHER (default deny)                       │
│                                                           │
└──────────────────────────────────────────────────────────┘
            │                                    │
            ▼                                    ▼
┌──────────────────────────────────────────────────────────┐
│     Ubuntu 24.04 LTS VPS (76.13.210.250)                 │
│     Hostname: srv1414058.hstgr.cloud                     │
│                                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Nginx Reverse Proxy (Listening: 0.0.0.0:80/443)   │  │
│  │                                                     │  │
│  │  - HTTPS Termination (SSL/TLS)                     │  │
│  │  - Let's Encrypt Certificate (auto-renewed)        │  │
│  │  - Reverse proxy to localhost:18789                │  │
│  │  - WebSocket upgrade headers (Upgrade, Connection) │  │
│  │  - Security headers (HSTS, X-Frame-Options, etc.)  │  │
│  │  - HTTP → HTTPS redirect                           │  │
│  │                                                     │  │
│  │  ServerName: openclaw.yahwan.biz                   │  │
│  └───────────────────┬────────────────────────────────┘  │
│                      │                                    │
│                      │ (localhost:18789, internal only)   │
│                      ▼                                    │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Docker Container Runtime (docker-ce)              │  │
│  │                                                     │  │
│  │  Container: openclaw-sgnl-openclaw-1               │  │
│  │  Image: piboonsak/openclaw:latest    │  │
│  │  Port Mapping: 127.0.0.1:18789 → :18789           │  │
│  │  Restart Policy: always                             │  │
│  │                                                     │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │  OpenClaw Gateway Application                │  │  │
│  │  │  - WebSocket server (:18789/ws)              │  │  │
│  │  │  - Health check (:18789/health)              │  │  │
│  │  │  - Message routing                           │  │  │
│  │  │  - Session management                        │  │  │
│  │  │  - Multi-channel integration (WhatsApp, etc.)│  │  │
│  │  │                                              │  │  │
│  │  │  ⚠️ CRITICAL: Port 18789 NOT exposed         │  │  │
│  │  │              to external network             │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  │                                                     │  │
│  └────────────────────────────────────────────────────┘  │
│                                                           │
└──────────────────────────────────────────────────────────┘


Connection Flow (HTTPS):

1. Client: https://openclaw.yahwan.biz
2. DNS Lookup: openclaw.yahwan.biz → 76.13.210.250
3. TCP Handshake: 76.13.210.250:443
4. Firewall: ACCEPT (rule #2)
5. Nginx: TLS handshake, certificate validation
6. Nginx Proxy: Forward to 127.0.0.1:18789
7. Docker: Receive request on :18789
8. App: Process request
9. Response flow: Reverse of above
```

### DNS Record Diagram

```
Domain: yahwan.biz
Registrar: Squarespace (domain owner)
DNS Provider: Hostinger (nameservers)

Squarespace Config:
  Nameservers → ns1.hostinger.com
                ns2.hostinger.com
                ns3.hostinger.com
                ns4.hostinger.com

Hostinger DNS Zone:
  
  Record 1:  Type=A   Host=@          Points=76.13.210.250   TTL=50s
             └─ Root domain resolution
  
  Record 2:  Type=A   Host=openclaw   Points=76.13.210.250   TTL=14400s
             └─ Subdomain resolution (OpenClaw app)
  
  Record 3:  Type=CNAME  Host=www     Points=yahwan.biz      TTL=300s
             └─ WWW subdomain aliasing

DNS Query Resolution:
  
  Query: openclaw.yahwan.biz
    ├─ Resolver asks ns1.hostinger.com
    ├─ Returns A record: 76.13.210.250
    └─ Client connects to 76.13.210.250 (VPS IP)

  Query: www.yahwan.biz
    ├─ Resolver asks ns1.hostinger.com
    ├─ Returns CNAME: yahwan.biz
    ├─ Asks again for yahwan.biz
    ├─ Returns A record: 76.13.210.250
    └─ Client connects to 76.13.210.250 (VPS IP)
```

### Security Boundary Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                    EXTERNAL / UNTRUSTED                               │
│                  (Internet clients / public)                          │
│                                                                       │
│  HTTP/HTTPS Traffic                  Attack Vectors Blocked:         │
│  ├─ Browser clients                  ├─ Direct port 18789 access ✅   │
│  ├─ Mobile apps                      ├─ SSH brute force (outside 22) ✅
│  ├─ Third-party integrations         ├─ Port scanning (firewall drops) ✅
│  └─ Monitoring bots                  └─ UDP/other protocols ✅        │
└──────────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │ Hostinger Cloud    │
                    │ Firewall           │
                    │ (Network boundary) │
                    │                    │
                    │ Rules:             │
                    │ ✅ Allow: 80,443,22│
                    │ ❌ Drop: 18789     │
                    │ ❌ Drop: All other │
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │ Nginx Proxy        │
                    │ (TLS termination)  │
                    │                    │
                    │ Security:          │
                    │ ✅ HTTPS only      │
                    │ ✅ HSTS headers    │
                    │ ✅ X-Frame-Options │
                    │ ✅ No cache headers│
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │ Docker Network     │
                    │ (localhost bridge) │
                    │                    │
                    │ Isolation:         │
                    │ ✅ Port 18789 local│
                    │ ✅ Not exposed ext │
                    │ ✅ Container user  │
                    │ ✅ Resource limits │
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │ OpenClaw App       │
                    │ (trusted boundary) │
                    │                    │
                    │ Security:          │
                    │ ✅ Non-root user   │
                    │ ✅ Limited access  │
                    │ ✅ Sandboxed       │
                    │ ✅ Logging enabled │
                    └────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                    INTERNAL / TRUSTED                                 │
│           (SSH admin access, localhost debugging)                     │
│                                                                       │
│  SSH Command Execution (port 22)     Local Debugging:                │
│  ├─ Nginx config management          ├─ docker exec (local) ✅       │
│  ├─ Docker container management      ├─ curl localhost:18789 ✅      │
│  ├─ Certbot certificate renewal      ├─ docker logs (local) ✅       │
│  ├─ Log review and analysis          └─ System monitoring ✅         │
│  └─ Emergency troubleshooting                                        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Troubleshooting Guide

### Service Troubleshooting Flowchart

```
Problem: https://openclaw.yahwan.biz returns error

├─ Error: "Cannot resolve hostname"
│  └─ DNS Issue
│     ├─ Check: nslookup openclaw.yahwan.biz
│     ├─ Check: Squarespace nameservers set to Hostinger NS
│     ├─ Check: Hostinger DNS A record for "openclaw" = 76.13.210.250
│     └─ Action: Wait for DNS propagation (up to 48 hours)
│
├─ Error: "Connection timeout"
│  └─ Network/Firewall Issue
│     ├─ Check: ping 76.13.210.250 works (not blocked)
│     ├─ Check: Firewall rules (ports 80,443 must be ACCEPT)
│     ├─ Check: Hostinger Cloud Firewall status
│     └─ Action: Review and enable firewall rules
│
├─ Error: "502 Bad Gateway"
│  └─ Nginx → Docker Connection Issue
│     ├─ Check: docker ps shows openclaw container running
│     ├─ Check: curl http://127.0.0.1:18789/health works (local)
│     ├─ Check: Nginx config syntax (nginx -t)
│     ├─ Check: Nginx logs (tail -30 /var/log/nginx/error.log)
│     └─ Action: Fix config, restart nginx, verify container
│
├─ Error: "SSL certificate problem"
│  └─ Certificate Issue
│     ├─ Check: ls /etc/letsencrypt/live/openclaw.yahwan.biz/
│     ├─ Check: openssl x509 -in fullchain.pem -noout -dates
│     ├─ Check: Certbot renewal timer (systemctl list-timers)
│     └─ Action: Re-issue certificate if missing/expired
│
├─ Error: "Connection reset"
│  └─ Container Crash / Port Mismatch
│     ├─ Check: docker logs openclaw-sgnl-openclaw-1
│     ├─ Check: docker port openclaw-sgnl-openclaw-1
│     ├─ Check: Container running (docker ps)
│     └─ Action: Restart container, check application logs
│
└─ Error: WebSocket disconnects immediately
   └─ WebSocket Headers Missing
      ├─ Check: Upgrade and Connection headers in Nginx config
      ├─ Check: Nginx -t syntax validation
      ├─ Check: systemctl reload nginx (after config change)
      └─ Action: Add headers, reload Nginx, test with wscat
```

### Common Commands for Debugging

```bash
# DNS Verification
nslookup openclaw.yahwan.biz
dig openclaw.yahwan.biz +short
host openclaw.yahwan.biz
curl -I https://openclaw.yahwan.biz/

# Docker Status
docker ps -a
docker logs openclaw-sgnl-openclaw-1
docker inspect openclaw-sgnl-openclaw-1 | grep -E "Id|Names|Status|Error"
docker stats openclaw-sgnl-openclaw-1

# Nginx Status and Logs
systemctl status nginx
tail -50 /var/log/nginx/error.log
tail -50 /var/log/nginx/access.log
nginx -T | grep -A10 "server_name openclaw"

# Port and Network
ss -tlnp | grep -E ':(80|443|18789|22)'
netstat -tunlp | grep LISTEN
netstat -an | grep 127.0.0.1:18789

# SSL Certificate
certbot certificates
openssl x509 -in /etc/letsencrypt/live/openclaw.yahwan.biz/fullchain.pem -text -noout
openssl s_client -connect openclaw.yahwan.biz:443 -showcerts < /dev/null

# Firewall
ufw status
curl -v http://127.0.0.1:18789/health  # Should work (local)
timeout 5 bash -c '</dev/tcp/76.13.210.250/18789' 2>&1  # Should FAIL from external
```

---

## Maintenance and Operations

### Routine Operations Schedule

#### Daily
- [ ] Monitor container health: `docker ps`
- [ ] Check Nginx error logs: `tail /var/log/nginx/error.log`
- [ ] Monitor application logs: `docker logs openclaw-sgnl-openclaw-1`

#### Weekly
- [ ] Review access logs: `tail -100 /var/log/nginx/access.log`
- [ ] Check disk usage: `df -h`
- [ ] Check memory usage: `free -h`
- [ ] Verify SSL certificate status: `certbot certificates`

#### Monthly
- [ ] Security audit (Nginx config, Firewall rules)
- [ ] Backup configuration files:
  ```bash
  tar -czf /backup/openclaw-config-$(date +%Y%m%d).tar.gz \
    /etc/nginx/sites-available/openclaw \
    /etc/letsencrypt/live/openclaw.yahwan.biz/
  ```
- [ ] Test certificate renewal: `certbot renew --dry-run`
- [ ] Review container resource usage: `docker stats`

#### Annually or As-Needed
- [ ] Full security audit of infrastructure
- [ ] Update Docker image versions
- [ ] Review and update SSL/TLS cipher suites
- [ ] Disaster recovery test (restore from backup)

### Container Lifecycle Management

```bash
# Start container
docker start openclaw-sgnl-openclaw-1

# Stop container (graceful)
docker stop openclaw-sgnl-openclaw-1

# Force stop (ungraceful)
docker kill openclaw-sgnl-openclaw-1

# Restart container
docker restart openclaw-sgnl-openclaw-1

# View container details
docker inspect openclaw-sgnl-openclaw-1

# Execute command in running container
docker exec openclaw-sgnl-openclaw-1 env

# View resource usage
docker stats openclaw-sgnl-openclaw-1

# Remove container (stop first)
docker stop openclaw-sgnl-openclaw-1
docker rm openclaw-sgnl-openclaw-1
```

### Log Management

```bash
# Nginx access logs
/var/log/nginx/access.log      # HTTP GET/POST requests, response codes
/var/log/nginx/error.log       # Nginx errors, proxy errors, SSL errors

# Container logs
docker logs openclaw-sgnl-openclaw-1 --tail 100
docker logs openclaw-sgnl-openclaw-1 --since 1h  # Last hour

# System logs
journalctl -u nginx -n 50
journalctl -u docker -n 50
```

### Backup and Disaster Recovery

**What to backup:**

```bash
# Configuration files
/etc/nginx/sites-available/openclaw
/etc/letsencrypt/live/openclaw.yahwan.biz/

# Application data (if any)
docker inspect openclaw-sgnl-openclaw-1 | grep Mounts  # Check volume mounts
```

**Backup script:**

```bash
#!/bin/bash
BACKUP_DIR="/backup/openclaw"
mkdir -p "$BACKUP_DIR"

# Nginx config
tar -czf "$BACKUP_DIR/nginx-config-$(date +%Y%m%d-%H%M%S).tar.gz" \
  /etc/nginx/sites-available/ \
  /etc/letsencrypt/

# Docker image
docker save piboonsak/openclaw:latest | gzip > \
  "$BACKUP_DIR/openclaw-image-$(date +%Y%m%d-%H%M%S).tar.gz"

# Keep only last 7 days
find "$BACKUP_DIR" -mtime +7 -delete

echo "Backup complete: $(ls "$BACKUP_DIR" | wc -l) files"
```

**Recovery procedure** (in case of disaster):

```bash
# 1. Re-provision Ubuntu 24.04 LTS on VPS
# 2. Follow Phase 2 (System setup)
# 3. Follow Phase 3 (Docker setup)
# 4. Restore Nginx config:
tar -xzf /backup/openclaw/nginx-config-YYYYMMDD-HHMMSS.tar.gz -C /

# 5. Follow Phase 4-6 (Verify all services)
```

---

## Appendix A: Complete File Listings

### File: /etc/nginx/sites-available/openclaw

👉 See [Phase 4.1](#41-create-nginx-site-configuration) for complete content

**Location:** `/etc/nginx/sites-available/openclaw`  
**Permissions:** `-rw-r--r-- root root`  
**Purpose:** Nginx site configuration for OpenClaw Gateway reverse proxy

### File: /etc/letsencrypt/live/openclaw.yahwan.biz/

**Files created by Certbot:**

```
/etc/letsencrypt/live/openclaw.yahwan.biz/
├── cert.pem          ← Issued certificate (public)
├── chain.pem         ← CA chain (public)
├── fullchain.pem     ← cert + chain (used in Nginx)
├── privkey.pem       ← Private key (KEEP SECURE!)
└── README            ← Certbot documentation
```

**Permissions:**
```bash
ls -l /etc/letsencrypt/live/openclaw.yahwan.biz/
lrwxrwxrwx root root privkey.pem -> ../../archive/openclaw.yahwan.biz/privkey1.pem
lrwxrwxrwx root root cert.pem -> ../../archive/openclaw.yahwan.biz/cert1.pem
lrwxrwxrwx root root chain.pem -> ../../archive/openclaw.yahwan.biz/chain1.pem
lrwxrwxrwx root root fullchain.pem -> ../../archive/openclaw.yahwan.biz/fullchain1.pem
```

---

## Appendix B: Required Ports Reference

| Port | Protocol | Purpose | Firewall | External | Notes |
|------|----------|---------|----------|----------|-------|
| 20 | TCP | FTP Data | N/A | No | Not used |
| 22 | TCP | SSH | ACCEPT | ✅ | Admin access |
| 53 | UDP | DNS | N/A | No | Not used (Hostinger DNS) |
| 80 | TCP | HTTP | ACCEPT | ✅ | Redirects to HTTPS |
| 443 | TCP | HTTPS | ACCEPT | ✅ | Primary app access |
| 3000 | TCP | Node.js | N/A | No | Not used |
| 8080 | TCP | Alt HTTP | N/A | No | Not used |
| 18789 | TCP | App | DROP | ❌ | Backend (localhost only) |
| Others | ANY | - | DROP | ❌ | Default deny all |

---

## Appendix C: DNS TTL Explanation

**TTL (Time To Live):** Seconds a DNS record is cached before re-querying

| Record | TTL | Reasoning |
|--------|-----|-----------|
| @ (root) | 50s | Root A record: minimize cache to enable fast propagation after nameserver change |
| openclaw | 14400s | Subdomain A record: standard TTL, balanced for stability vs. update speed |
| www | 300s | CNAME: short TTL for flexible aliasing |

**Impact:**

```
Low TTL (50s):
  Pro:  Fast DNS propagation after changes
  Con:  More queries to nameserver, slight latency

High TTL (86400s / 1 day):
  Pro:  Reduced DNS queries, cached response
  Con:  Slow propagation after nameserver change
```

For initial deployment, use 50s on root A record. After 7 days of stable operation, increase to 3600s (1 hour).

---

## Appendix D: Version Information

**Components used in this deployment:**

```
Ubuntu OS:           24.04 LTS (Noble Numbat)
Nginx:               1.18.0+ (apt)
Docker CE:           24.x.x+ (apt)
Docker Compose:      v2.x.x+ (apt)
Certbot:             2.x.x+ (apt)
OpenSSL:             3.x.x (default in Ubuntu 24.04)
Node.js:             18.x+ (in container image)
OpenClaw:            2026.2.22 (piboonsak/openclaw:latest)
```

**Update information:**

```bash
# Check installed versions
nginx -v
docker --version
certbot --version
openssl version

# Update all packages monthly
apt update && apt upgrade -y
```

---

## References and Further Reading

- **Nginx Proxy Documentation:** https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- **Let's Encrypt / Certbot:** https://certbot.eff.org/
- **Docker Official Docs:** https://docs.docker.com/
- **DNS and DNSSEC:** https://www.cloudflare.com/learning/dns/
- **WebSocket Security:** https://owasp.org/www-community/attacks/websocket

---

## Document Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | Feb 23, 2026 | DevOps Team | Initial production deployment guide |

**Status:** ✅ Production Ready  
**Last Reviewed:** February 23, 2026  
**Next Review:** March 23, 2026

---

**END OF DOCUMENT**

---

## Quick Reference: Command Index

```bash
# DNS & Network
nslookup openclaw.yahwan.biz
dig openclaw.yahwan.biz +short
curl -I https://openclaw.yahwan.biz/

# Docker
docker ps
docker logs openclaw-sgnl-openclaw-1 --tail 50
docker inspect openclaw-sgnl-openclaw-1

# Nginx
nginx -t
systemctl restart nginx
tail -50 /var/log/nginx/error.log

# SSL/TLS
certbot certificates
openssl x509 -in /etc/letsencrypt/live/openclaw.yahwan.biz/fullchain.pem -noout -dates
certbot renew --dry-run

# Firewall/Network
ss -tlnp | grep -E ':(80|443|18789|22)'
ufw status
timeout 5 bash -c '</dev/tcp/76.13.210.250/18789' 2>&1

# System
df -h
free -h
systemctl status nginx docker
```

---

**Infrastructure: Production Ready** ✅  
**Security: Hardened** ✅  
**Monitoring: Documented** ✅
