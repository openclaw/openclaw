openclaw() {
     docker compose exec openclaw-gateway node dist/index.js "$@"
}
