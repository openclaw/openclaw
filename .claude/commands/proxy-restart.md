Restart the Cloud.ru FM proxy.

1. Stop: `docker compose -f docker-compose.cloudru-proxy.yml down`
2. Start: `docker compose -f docker-compose.cloudru-proxy.yml up -d`
3. Wait 5 seconds, then verify health: `curl -s http://localhost:8082/health`
4. Report status.
