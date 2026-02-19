Check the status of the Cloud.ru FM proxy.

Run these commands and summarize the results:

1. `docker ps --filter name=claude-code-proxy` — container status
2. `curl -s http://localhost:8082/health` — health check
3. `docker stats claude-code-proxy --no-stream` — resource usage
4. `docker logs claude-code-proxy --tail 20` — recent logs

Report whether the proxy is healthy and note any issues.
