# ClaWorks white-label deployment

Single public **HTTPS :443** edge; **OpenClaw** and **ClaWorks Platform** on loopback or an internal Docker network. Feishu uses **WebSocket outbound** by default (no inbound webhook required).

| File                                                                                       | Purpose                                 |
| ------------------------------------------------------------------------------------------ | --------------------------------------- |
| [claworks-whitelabel.zh.md](./claworks-whitelabel.zh.md)                                   | Full runbook (Chinese)                  |
| [claworks-whitelabel.openclaw.fragment.json](./claworks-whitelabel.openclaw.fragment.json) | Merge into `openclaw.json`              |
| [nginx/nginx.conf.template](./nginx/nginx.conf.template)                                   | Reverse proxy template                  |
| [scripts/render-nginx.sh](./scripts/render-nginx.sh)                                       | Render nginx config from `.env`         |
| [scripts/verify-whitelabel.sh](./scripts/verify-whitelabel.sh)                             | Post-deploy checks                      |
| [docker-compose.yml](./docker-compose.yml)                                                 | Docker stack (nginx only publishes 443) |

Quick start (bare metal):

```bash
cd contrib/examples/claworks-whitelabel
cp .env.example .env   # edit PUBLIC_HOST, TLS, upstreams
chmod +x scripts/*.sh
./scripts/setup-whitelabel.sh
sudo cp nginx/nginx.conf /etc/nginx/conf.d/claworks.conf
sudo nginx -t && sudo systemctl reload nginx
./scripts/verify-whitelabel.sh
```

See [ClaWorks integration (canonical)](https://docs.openclaw.ai/plugins/claworks-integration).
