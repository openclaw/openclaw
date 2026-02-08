#!/bin/bash
# Full-text index management (requires qmd)
case "$1" in
  fetch)
    echo "Downloading all docs..."
    ;;
  build)
    echo "Building search index..."
    ;;
  search)
    shift
    echo "Semantic search for: $*"
    ;;
  *)
    echo "Usage: build-index.sh {fetch|build|search <query>}"
    ;;
esac
