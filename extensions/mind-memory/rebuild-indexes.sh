#!/usr/bin/env bash
# Recreate HNSW vector indexes in FalkorDB after container restart.
# FalkorDB does not persist vector indexes across restarts — run this script
# after every `docker compose up` or container restart.
#
# Usage: ./rebuild-indexes.sh [graph_name] [embedding_dim]
#   graph_name:    FalkorDB graph name (default: global_user_memory)
#   embedding_dim: embedding dimensions (default: 1024)

set -euo pipefail

GRAPH="${1:-global_user_memory}"
DIM="${2:-1024}"
CONTAINER="graphiti"

echo "Rebuilding HNSW indexes on graph '$GRAPH' (dim=$DIM)..."

redis_query() {
  docker exec "$CONTAINER" redis-cli -p 6379 GRAPH.QUERY "$GRAPH" "$1"
}

redis_query "CREATE VECTOR INDEX FOR (n:Entity) ON (n.name_embedding) OPTIONS {dimension:${DIM}, similarityFunction:'cosine'}" | grep -E "time|error" || true
redis_query "CREATE VECTOR INDEX FOR ()-[r:RELATES_TO]-() ON (r.fact_embedding) OPTIONS {dimension:${DIM}, similarityFunction:'cosine'}" | grep -E "time|error" || true
redis_query "CREATE VECTOR INDEX FOR (n:Community) ON (n.name_embedding) OPTIONS {dimension:${DIM}, similarityFunction:'cosine'}" | grep -E "time|error" || true

echo "Done."
