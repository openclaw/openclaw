#!/bin/bash
# openclaw 本地开发辅助脚本
# 使用方法: ./dev.sh [command] [args...]
# 示例:
#   ./dev.sh gateway --dev    # 启动 gateway 开发模式
#   ./dev.sh onboard          # 启动 onboard 向导
#   ./dev.sh status           # 查看状态
#   ./dev.sh build            # 构建项目
#   ./dev.sh test:wecom       # 运行 wecom 测试
#   ./dev.sh debug gateway    # 以 debug 模式启动 gateway (带 --inspect-brk)

set -e

# 确保使用 Node 22
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
nvm use 22 > /dev/null 2>&1

cd "$(dirname "$0")"

export OPENCLAW_NO_RESPAWN=1
export OPENCLAW_LOG_LEVEL="${OPENCLAW_LOG_LEVEL:-debug}"

CMD="${1:-help}"
shift 2>/dev/null || true

case "$CMD" in
  build)
    pnpm build
    ;;
  test:wecom)
    pnpm test:extension wecom
    ;;
  test)
    pnpm test "$@"
    ;;
  debug)
    # debug 模式 - 启动后等待 debugger 附加
    SUB_CMD="${1:-gateway}"
    shift 2>/dev/null || true
    echo "Starting openclaw $SUB_CMD in debug mode (waiting for debugger on port 9229)..."
    node --inspect-brk --import tsx src/entry.ts "$SUB_CMD" "$@"
    ;;
  gateway|onboard|status|--version|--help)
    node --import tsx src/entry.ts "$CMD" "$@"
    ;;
  *)
    echo "Usage: ./dev.sh [command] [args...]"
    echo ""
    echo "Commands:"
    echo "  build                 Build the project"
    echo "  gateway --dev         Start gateway in dev mode"
    echo "  onboard               Start onboard wizard"
    echo "  status                Show status"
    echo "  test:wecom            Run wecom extension tests"
    echo "  test [args]           Run tests with custom args"
    echo "  debug [subcmd]        Start with --inspect-brk for debugger attach"
    echo ""
    echo "Or pass any openclaw subcommand directly."
    ;;
esac
