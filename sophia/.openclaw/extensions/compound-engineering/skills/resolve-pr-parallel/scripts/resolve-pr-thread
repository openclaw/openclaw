#!/usr/bin/env bash

set -e

if [ $# -eq 0 ]; then
    echo "Usage: resolve-pr-thread THREAD_ID"
    echo "Example: resolve-pr-thread PRRT_kwDOABC123"
    exit 1
fi

THREAD_ID=$1

gh api graphql -f threadId="$THREAD_ID" -f query='
mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread {
      id
      isResolved
      path
      line
    }
  }
}'
