#!/bin/bash
# riscv-claw Initialization Script for JH7110 (Ubuntu 24.04)
set -e

echo "🥟 Starting riscv-claw initialization for riscv64..."

# 1. Install system dependencies
sudo apt-get update
sudo apt-get install -y \
    build-essential \
    python3 \
    make \
    g++ \
    pkg-config \
    libvips-dev \
    libsqlite3-dev \
    libsqlite3-0 \
    libpixman-1-dev \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev

# 2. Install Node.js 18 (if not already present)
if ! node -v | grep -q "v18"; then
    echo "Installing Node.js 18.x..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 3. Install pnpm
sudo npm install -g pnpm@10

# 4. Configure pnpm for native builds
pnpm config set node-gyp $(which node-gyp || echo "npm install -g node-gyp && which node-gyp")

# 5. Build attempt
echo "Attempting to install dependencies..."
# For riscv64, we force build from source for known problematic packages
export npm_config_build_from_source=true
pnpm install

echo "🥟 riscv-claw is ready for action!"
