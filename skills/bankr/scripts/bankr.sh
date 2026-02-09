#!/bin/bash
# Bankr Agent API wrapper - handles submit-poll-complete workflow
# Usage: bankr.sh <prompt>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Submit the prompt
SUBMIT_RESULT=$("$SCRIPT_DIR/bankr-submit.sh" "$@")

# Check if submission succeeded
if ! echo "$SUBMIT_RESULT" | jq -e '.success == true' >/dev/null 2>&1; then
    echo "$SUBMIT_RESULT" | jq -r '.error // "Submission failed"' >&2
    exit 1
fi

# Extract job ID
JOB_ID=$(echo "$SUBMIT_RESULT" | jq -r '.jobId')

if [ -z "$JOB_ID" ] || [ "$JOB_ID" = "null" ]; then
    echo "Failed to get job ID" >&2
    exit 1
fi

echo "Job submitted: $JOB_ID" >&2
echo "Polling for results..." >&2

# Poll for completion (max 5 minutes)
MAX_ATTEMPTS=150  # 150 * 2s = 5 minutes
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    sleep 2
    
    STATUS_RESULT=$("$SCRIPT_DIR/bankr-status.sh" "$JOB_ID")
    
    # Get status
    STATUS=$(echo "$STATUS_RESULT" | jq -r '.status')
    
    case "$STATUS" in
        "completed")
            echo "✓ Job completed" >&2
            echo "$STATUS_RESULT"
            exit 0
            ;;
        "failed")
            ERROR=$(echo "$STATUS_RESULT" | jq -r '.error // "Unknown error"')
            echo "✗ Job failed: $ERROR" >&2
            echo "$STATUS_RESULT"
            exit 1
            ;;
        "cancelled")
            echo "✗ Job was cancelled" >&2
            echo "$STATUS_RESULT"
            exit 1
            ;;
        "pending"|"processing")
            # Show status updates if any
            UPDATES=$(echo "$STATUS_RESULT" | jq -r '.statusUpdates[]?.message // empty' 2>/dev/null | tail -1)
            if [ -n "$UPDATES" ]; then
                echo "  → $UPDATES" >&2
            fi
            ;;
        *)
            echo "Unknown status: $STATUS" >&2
            ;;
    esac
    
    ATTEMPT=$((ATTEMPT + 1))
done

echo "✗ Job timed out after 5 minutes" >&2
echo "Job ID: $JOB_ID (you can check status manually)" >&2
exit 1
