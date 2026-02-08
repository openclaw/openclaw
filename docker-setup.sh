#!/bin/bash
set -e

# Check for .env file
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo "Creating .env from .env.example..."
        cp .env.example .env
        echo "Please edit .env to set your configuration (Token, API Keys, etc.) before running."
        echo "Example: nano .env"
        # Generate a random token if openssl is available
        if command -v openssl >/dev/null 2>&1; then
            TOKEN=$(openssl rand -hex 32)
            # Portable sed inplace
            if [[ "$OSTYPE" == "darwin"* ]]; then
                 sed -i '' "s/your-secure-token-here/$TOKEN/" .env
            else
                 sed -i "s/your-secure-token-here/$TOKEN/" .env
            fi
            echo "Generated random gateway token in .env"
        fi
    else
        echo "No .env or .env.example found."
        exit 1
    fi
else
    echo "Found existing .env file."
fi

# Create required directories if they don't exist
mkdir -p config workspace

echo "Starting OpenClaw with Docker Compose..."
docker compose up -d

echo ""
echo "OpenClaw Gateway is starting."
echo "Check logs with: docker compose logs -f"
