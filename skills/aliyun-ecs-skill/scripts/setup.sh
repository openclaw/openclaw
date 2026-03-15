#!/bin/bash
# setup.sh — 阿里云ECS Skill 自动设置脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.aliyun"
CONFIG_FILE="$CONFIG_DIR/config.json"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查Node.js
node_check() {
    if ! command -v node &> /dev/null; then
        echo -e "${RED}✗ Node.js 未安装${NC}"
        return 1
    fi
    
    NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 16 ]; then
        echo -e "${RED}✗ Node.js 版本过低: $(node --version)，需要 >= 16${NC}"
        return 1
    fi
    
    echo -e "${GREEN}✓ Node.js $(node --version)${NC}"
    return 0
}

# 检查阿里云SDK
sdk_check() {
    # 优先检查本地 node_modules（skill 运行时从这里加载）
    if [ -d "$SCRIPT_DIR/../node_modules/@alicloud/openapi-client" ] && [ -d "$SCRIPT_DIR/../node_modules/@alicloud/ecs20140526" ]; then
        echo -e "${GREEN}✓ 阿里云SDK已安装${NC}"
        return 0
    fi
    
    echo -e "${YELLOW}⚠ 阿里云SDK未安装${NC}"
    return 1
}

# 安装阿里云SDK
sdk_install() {
    echo "正在安装阿里云SDK..."
    cd "$SCRIPT_DIR/.."
    
    # 创建package.json如果不存在
    if [ ! -f package.json ]; then
        cat > package.json << 'EOF'
{
  "name": "aliyun-ecs-skill",
  "version": "1.0.0",
  "description": "Aliyun ECS management skill for OpenClaw",
  "main": "src/index.js",
  "dependencies": {
    "@alicloud/openapi-client": "^0.4.10",
    "@alicloud/ecs20140526": "^7.0.0"
  }
}
EOF
    fi
    
    npm install
    echo -e "${GREEN}✓ 阿里云SDK安装完成${NC}"
}

# 检查配置文件
config_check() {
    if [ -f "$CONFIG_FILE" ]; then
        if grep -q "accessKeyId" "$CONFIG_FILE" 2>/dev/null; then
            echo -e "${GREEN}✓ 配置文件已存在${NC}"
            return 0
        fi
    fi
    
    echo -e "${YELLOW}⚠ 配置文件不存在或无效${NC}"
    return 1
}

# 创建配置文件
config_create() {
    local access_key_id="$1"
    local access_key_secret="$2"
    
    mkdir -p "$CONFIG_DIR"
    
    cat > "$CONFIG_FILE" << EOF
{
  "accessKeyId": "$access_key_id",
  "accessKeySecret": "$access_key_secret",
  "defaultRegion": "cn-hangzhou",
  "endpoint": "ecs.aliyuncs.com"
}
EOF
    
    chmod 600 "$CONFIG_FILE"
    echo -e "${GREEN}✓ 配置文件创建完成 ($CONFIG_FILE)${NC}"
}

# 验证连接
test_connection() {
    echo "正在验证阿里云连接..."
    
    cd "$SCRIPT_DIR/.."
    
    # 使用实际的阿里云API调用来验证连接
    node -e "
    const { default: OpenApi, \$OpenApi } = require('@alicloud/openapi-client');
    const Ecs20140526 = require('@alicloud/ecs20140526');
    const fs = require('fs');
    
    const configPath = '$CONFIG_FILE';
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    async function test() {
        try {
            const clientConfig = new \$OpenApi({
                accessKeyId: config.accessKeyId,
                accessKeySecret: config.accessKeySecret,
            });
            clientConfig.endpoint = 'ecs.aliyuncs.com';
            
            const client = new Ecs20140526(clientConfig);
            const response = await client.describeRegions(new Ecs20140526.DescribeRegionsRequest({}));
            
            if (response.body && response.body.regions && response.body.regions.region) {
                console.log('Connection test passed');
                console.log('Available regions:', response.body.regions.region.length);
                return true;
            }
            throw new Error('Invalid response');
        } catch (error) {
            console.error('Connection failed:', error.message);
            process.exit(1);
        }
    }
    
    test();
    " 2>&1
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ 连接验证成功${NC}"
        return 0
    else
        echo -e "${RED}✗ 连接验证失败，请检查密钥和网络${NC}"
        return 1
    fi
}

# 显示帮助
show_help() {
    cat << EOF
阿里云ECS Skill 设置脚本

用法:
  $0 [选项]

选项:
  --check-only          仅检查环境，不修改
  --access-key-id ID    阿里云AccessKey ID
  --access-key-secret S 阿里云AccessKey Secret
  --help                显示此帮助

示例:
  $0 --check-only
  $0 --access-key-id LTAIxxxxx --access-key-secret xxxxx
EOF
}

# 主函数
main() {
    local check_only=false
    local access_key_id=""
    local access_key_secret=""
    
    # 解析参数
    while [[ $# -gt 0 ]]; do
        case $1 in
            --check-only)
                check_only=true
                shift
                ;;
            --access-key-id)
                access_key_id="$2"
                shift 2
                ;;
            --access-key-secret)
                access_key_secret="$2"
                shift 2
                ;;
            --help)
                show_help
                exit 0
                ;;
            *)
                echo "未知选项: $1"
                show_help
                exit 1
                ;;
        esac
    done
    
    echo "=== 阿里云ECS Skill 环境检查 ==="
    echo ""
    
    # 检查Node.js
    local node_ok=false
    if node_check; then
        node_ok=true
    fi
    
    # 检查SDK
    local sdk_ok=false
    if sdk_check; then
        sdk_ok=true
    elif [ "$check_only" = false ] && [ -n "$access_key_id" ]; then
        sdk_install
        sdk_ok=true
    fi
    
    # 检查配置
    local config_ok=false
    if config_check; then
        config_ok=true
    elif [ "$check_only" = false ] && [ -n "$access_key_id" ] && [ -n "$access_key_secret" ]; then
        config_create "$access_key_id" "$access_key_secret"
        config_ok=true
    fi
    
    echo ""
    echo "=== 检查汇总 ==="
    
    if [ "$node_ok" = true ] && [ "$sdk_ok" = true ] && [ "$config_ok" = true ]; then
        echo -e "${GREEN}✓ 所有检查通过，环境已就绪${NC}"
        
        if [ "$check_only" = false ]; then
            test_connection
        fi
        
        exit 0
    else
        echo -e "${YELLOW}⚠ 环境未完全就绪${NC}"
        
        if [ "$check_only" = true ]; then
            exit 1
        fi
        
        if [ -z "$access_key_id" ] || [ -z "$access_key_secret" ]; then
            echo ""
            echo "请提供阿里云AccessKey以完成设置:"
            echo "  $0 --access-key-id YOUR_ID --access-key-secret YOUR_SECRET"
        fi
        
        exit 1
    fi
}

main "$@"
