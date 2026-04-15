/**
 * Aggregated export file
 * 供 index.ts 通过 loadBundledEntryExportSync 懒加载引用
 */

export { yuanbaoPlugin } from "./src/channel.js";
export { initLogger } from "./src/logger.js";
export { initEnv } from "./src/infra/env.js";
export { registerTools } from "./src/business/tools/index.js";
export {
  yuanbaoUpgradeCommand,
  yuanbaobotUpgradeCommand,
} from "./src/business/commands/upgrade/index.js";
export { logUploadCommandDefinition } from "./src/business/commands/log-upload.js";
export { initBuiltinStickers } from "./src/business/actions/sticker/init-builtin-stickers.js";
