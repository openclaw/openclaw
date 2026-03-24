# 品牌定制指南

本指南将帮助你修改JSClaw项目的品牌名称和logo，实现个性化定制。

## 修改品牌名称

品牌名称存储在以下文件中：

**文件路径：** `ui/src/brand-config.ts`

**修改步骤：**

1. 打开 `ui/src/brand-config.ts` 文件
2. 修改 `brandConfig` 对象中的 `name` 和 `controlTitle` 属性
3. 保存文件
4. 重新构建项目：`node build-deploy-package.mjs`

**示例：**

```typescript
export const brandConfig: BrandConfig = {
  name: "你的品牌名称", // 修改为你的品牌名称
  controlTitle: "你的品牌名称 Control", // 修改为你的品牌控制标题
  logos: {
    favicon: "/favicon.ico",
    appleTouchIcon: "/apple-touch-icon.png",
    logo: "/favicon.svg",
  },
};
```

## 修改品牌Logo

品牌logo存储在以下文件中：

1. **主Logo（SVG格式）：** `ui/public/favicon.svg`
2. **网站图标（ICO格式）：** `ui/public/favicon.ico`
3. **网站图标（PNG格式）：** `ui/public/favicon-32.png`
4. **Apple触摸图标：** `ui/public/apple-touch-icon.png`

**修改步骤：**

1. 准备你的品牌logo文件，确保格式正确：
   - SVG文件：用于主logo
   - ICO文件：用于网站图标
   - PNG文件（32x32）：用于网站图标
   - PNG文件（180x180）：用于Apple触摸图标

2. 替换对应文件：
   - 将你的SVG logo替换 `ui/public/favicon.svg`
   - 将你的ICO logo替换 `ui/public/favicon.ico`
   - 将你的32x32 PNG logo替换 `ui/public/favicon-32.png`
   - 将你的180x180 PNG logo替换 `ui/public/apple-touch-icon.png`

3. 重新构建项目：`node build-deploy-package.mjs`

## 部署项目

打包完成后，你可以使用以下命令部署项目：

```bash
node deploy.mjs
```
