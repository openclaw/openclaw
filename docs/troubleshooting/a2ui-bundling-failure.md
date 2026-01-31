# A2UI Bundling 失败问题分析

## 问题现象

运行 `pnpm build` 时，A2UI bundling 步骤失败：

```
A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle
If this persists, verify pnpm deps and try again.
```

## 根本原因

A2UI bundling 脚本 (`scripts/bundle-a2ui.sh`) 需要：

1. **编译 vendor/a2ui/renderers/lit**：使用 `tsc` 编译 TypeScript 源码
2. **打包 apps/shared/OpenClawKit/Tools/CanvasA2UI**：使用 `rolldown` 打包应用

失败发生在第一步：`pnpm -s exec tsc -p vendor/a2ui/renderers/lit/tsconfig.json`

**问题**：`vendor/a2ui/renderers/lit` 目录缺少 `node_modules`，导致 TypeScript 编译器无法找到依赖。

## 详细分析

### 1. 目录结构检查

```bash
# vendor 目录存在
vendor/a2ui/renderers/lit/  # ✅ 存在

# 但缺少必要的构建产物
vendor/a2ui/renderers/lit/node_modules/  # ❌ 不存在
vendor/a2ui/renderers/lit/dist/          # ❌ 不存在
```

### 2. 脚本执行流程

```bash
# 1. 检查目录是否存在
if [[ ! -d "$A2UI_RENDERER_DIR" || ! -d "$A2UI_APP_DIR" ]]; then
  exit 0  # 如果不存在，跳过（Docker 环境）
fi

# 2. 计算 hash（检查是否需要重新构建）
current_hash="$(compute_hash)"

# 3. 如果 hash 匹配且 bundle 存在，跳过
if [[ "$previous_hash" == "$current_hash" && -f "$OUTPUT_FILE" ]]; then
  exit 0
fi

# 4. 编译 vendor/a2ui/renderers/lit
pnpm -s exec tsc -p "$A2UI_RENDERER_DIR/tsconfig.json"  # ❌ 这里失败

# 5. 打包应用
rolldown -c "$A2UI_APP_DIR/rolldown.config.mjs"
```

### 3. 失败原因

- `vendor/a2ui/renderers/lit` 是一个独立的 npm 包，有自己的 `package.json`
- 它需要安装依赖（TypeScript、lit、@lit/context 等）才能编译
- 但脚本直接运行 `tsc`，没有先安装依赖

## 解决方案

### 方案 1：安装 vendor 依赖（推荐）

在 vendor 目录下安装依赖：

```bash
cd vendor/a2ui/renderers/lit
pnpm install
cd ../../../../..
```

然后重新运行构建：

```bash
pnpm canvas:a2ui:bundle
```

### 方案 2：使用环境变量跳过（临时）

如果不需要 A2UI 功能，可以设置环境变量跳过：

```bash
OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
```

### 方案 3：检查 vendor 目录来源

`vendor/` 目录在 `.gitignore` 中，通常需要：

1. **从 git submodule 初始化**（如果使用 submodule）
2. **手动克隆 A2UI 仓库**到 vendor 目录
3. **或使用预构建的 bundle**（如果存在）

检查是否有初始化 vendor 的脚本：

```bash
# 查找相关脚本
grep -r "vendor\|a2ui" scripts/ | grep -i "init\|setup\|clone"
```

### 方案 4：修复脚本（如果可能）

如果 vendor 目录应该自动安装依赖，可以修改脚本：

```bash
# 在 scripts/bundle-a2ui.sh 中，在运行 tsc 之前添加：
if [[ ! -d "$A2UI_RENDERER_DIR/node_modules" ]]; then
  echo "Installing vendor dependencies..."
  (cd "$A2UI_RENDERER_DIR" && pnpm install)
fi
```

## 验证步骤

### 1. 检查 vendor 目录状态

```bash
ls -la vendor/a2ui/renderers/lit/
ls -la vendor/a2ui/renderers/lit/node_modules/ 2>&1
ls -la vendor/a2ui/renderers/lit/dist/ 2>&1
```

### 2. 检查依赖安装

```bash
cd vendor/a2ui/renderers/lit
cat package.json | grep -A 10 "dependencies"
pnpm list 2>&1 | head -20
```

### 3. 手动测试编译

```bash
cd vendor/a2ui/renderers/lit
pnpm install
pnpm exec tsc -p tsconfig.json
```

### 4. 检查 rolldown

```bash
which rolldown
pnpm list rolldown
# 如果不存在，安装：
pnpm add -D rolldown
```

## 常见问题

### Q1: vendor 目录从哪里来？

A: `vendor/` 目录通常包含第三方源码，可能来自：
- Git submodule
- 手动克隆的仓库
- 预构建的源码包

检查是否有 `.gitmodules` 文件：

```bash
cat .gitmodules 2>&1
```

### Q2: 为什么 vendor 在 .gitignore 中？

A: vendor 目录通常很大，不适合直接提交到 git。应该：
- 使用 git submodule
- 或在构建时动态获取
- 或提供预构建的 bundle

### Q3: 可以跳过 A2UI bundling 吗？

A: 可以，如果：
- 你不需要 Canvas UI 功能
- 或者已经有预构建的 bundle

设置环境变量：

```bash
OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
```

### Q4: Docker 构建如何处理？

A: Dockerfile 中设置了：

```dockerfile
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
```

这意味着 Docker 构建会跳过 A2UI bundling（如果 vendor 目录不存在）。

## 推荐解决步骤

1. **检查 vendor 目录来源**
   ```bash
   git submodule status
   cat .gitmodules 2>&1
   ```

2. **如果需要 vendor 源码，初始化 submodule**
   ```bash
   git submodule update --init --recursive
   ```

3. **安装 vendor 依赖**
   ```bash
   cd vendor/a2ui/renderers/lit
   pnpm install
   cd ../../../../..
   ```

4. **验证构建**
   ```bash
   pnpm canvas:a2ui:bundle
   ```

5. **如果仍然失败，检查 rolldown**
   ```bash
   pnpm add -D rolldown
   pnpm canvas:a2ui:bundle
   ```

## 相关文件

- `scripts/bundle-a2ui.sh` - A2UI bundling 脚本
- `vendor/a2ui/renderers/lit/` - A2UI renderer 源码
- `apps/shared/OpenClawKit/Tools/CanvasA2UI/` - Canvas A2UI 应用
- `src/canvas-host/a2ui/` - 构建输出目录
- `.gitignore` - vendor 目录被忽略
