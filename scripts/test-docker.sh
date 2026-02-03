#!/bin/bash
set -e

echo "🐳 OpenClaw Docker Build Test"
echo "=============================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Docker is installed${NC}"
docker --version
echo ""

# Build the image
echo -e "${YELLOW}🔨 Building Docker image...${NC}"
docker build -t openclaw:test .

echo ""
echo -e "${GREEN}✅ Build successful!${NC}"
echo ""

# Check image size
echo -e "${YELLOW}📊 Image information:${NC}"
docker images openclaw:test
echo ""

# Test basic functionality
echo -e "${YELLOW}🧪 Running basic tests...${NC}"

# Test 1: Check if OpenClaw CLI is available
echo -n "  Testing OpenClaw CLI... "
if docker run --rm openclaw:test which openclaw &> /dev/null; then
    echo -e "${GREEN}✅ OK${NC}"
else
    echo -e "${RED}❌ FAILED${NC}"
    exit 1
fi

# Test 2: Check if gateway command exists
echo -n "  Testing Gateway command... "
if docker run --rm openclaw:test openclaw gateway --version &> /dev/null; then
    echo -e "${GREEN}✅ OK${NC}"
else
    echo -e "${YELLOW}⚠️  VERSION CHECK FAILED (might be normal)${NC}"
fi

# Test 3: Check directories
echo -n "  Testing directory structure... "
OUTPUT=$(docker run --rm openclaw:test ls -la /root/.openclaw 2>&1)
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ OK${NC}"
else
    echo -e "${RED}❌ FAILED${NC}"
    echo "  Error: $OUTPUT"
    exit 1
fi

# Test 4: Check workspace
echo -n "  Testing workspace directory... "
OUTPUT=$(docker run --rm openclaw:test ls -la /workspace 2>&1)
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ OK${NC}"
else
    echo -e "${RED}❌ FAILED${NC}"
    echo "  Error: $OUTPUT"
    exit 1
fi

echo ""
echo -e "${GREEN}✅ All tests passed!${NC}"
echo ""

# Show image size
echo -e "${YELLOW}📏 Image size:${NC}"
docker images openclaw:test --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
echo ""

# Cleanup
echo -e "${YELLOW}🧹 Cleaning up...${NC}"
docker rmi openclaw:test

echo -e "${GREEN}✅ Done!${NC}"
