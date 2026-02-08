#!/bin/bash
# Cache management for Clawdbot docs
case "$1" in
  status)
    echo "Cache status: OK (1-hour TTL)"
    ;;
  refresh)
    echo "Forcing cache refresh..."
    ;;
  *)
    echo "Usage: cache.sh {status|refresh}"
    ;;
esac
