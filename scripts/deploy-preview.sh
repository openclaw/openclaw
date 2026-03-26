#!/bin/bash
set -e

echo "Deploying preview..."
# VERCEL_TOKEN and GITHUB_TOKEN should be set in environment
if [ -z "$VERCEL_TOKEN" ]; then
    echo "Warning: VERCEL_TOKEN missing. Using mock deployment."
else
    echo "Using real deployment workflow placeholder."
fi

echo "Preview deployed successfully (mock)."
