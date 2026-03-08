sed -i.bak 's/CMD \["node", "openclaw.mjs", "gateway", "--allow-unconfigured"\]/CMD \["node", "openclaw.mjs", "gateway", "--allow-unconfigured", "--bind", "lan"\]/' Dockerfile
