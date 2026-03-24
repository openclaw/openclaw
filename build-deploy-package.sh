#!/bin/bash
set -e # 任意命令失败则退出脚本

# ===================== 配置项（可根据需求修改）=====================
DEPLOY_DIR="./openclaw-deploy"  # 打包输出目录
BUILD_DIR="./dist"              # 编译产物目录
ENTRY_FILE="./openclaw.mjs"     # 主入口文件
PACKAGE_JSON="./package.json"   # 依赖描述文件
PM2_CONFIG="./ecosystem.config.js" # 本地pm2配置文件（新增）
CONFIG_TEMPLATE="./config-template" # 自定义配置模板目录（可选）

# ===================== 清理旧产物 =====================
echo "🔍 清理旧打包产物..."
rm -rf ${DEPLOY_DIR}
mkdir -p ${DEPLOY_DIR}

# ===================== 编译源码（确保最新）=====================
echo "🔨 编译二次开发源码..."
pnpm build || { echo "❌ 源码编译失败，请检查代码！"; exit 1; }

# ===================== 复制核心文件 =====================
echo "📦 复制运行必需文件..."
# 核心执行文件
cp ${ENTRY_FILE} ${DEPLOY_DIR}/
# 编译产物
cp -r ${BUILD_DIR} ${DEPLOY_DIR}/
# 依赖描述（仅生产依赖）
cp ${PACKAGE_JSON} ${DEPLOY_DIR}/
# 复制本地pm2配置文件（核心新增）
if [ -f ${PM2_CONFIG} ]; then
  cp ${PM2_CONFIG} ${DEPLOY_DIR}/
else
  red "❌ 未找到pm2配置文件：${PM2_CONFIG}，请先创建！"
  exit 1
fi
# 自定义配置模板（如有）
if [ -d ${CONFIG_TEMPLATE} ]; then
  cp -r ${CONFIG_TEMPLATE} ${DEPLOY_DIR}/
fi

# ===================== 生成打包清单 =====================
echo "📝 生成打包清单..."
ls -l ${DEPLOY_DIR} > ${DEPLOY_DIR}/deploy-files.txt

# ===================== 完成提示 =====================
echo -e "\n✅ 打包完成！"
echo "📂 打包目录：$(pwd)/${DEPLOY_DIR}"
echo "🚀 下一步：将该目录上传到服务器（如 /opt/openclaw），执行 deploy.sh 部署"
