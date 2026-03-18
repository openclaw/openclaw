import type { ExecutionKind } from "./types.ts";

export type LocaleKey = "zh-CN" | "en";

interface ExecutionLocale {
  readonly kindDescriptions: Record<ExecutionKind, string>;
}

const ZH_CN: ExecutionLocale = {
  kindDescriptions: {
    search: "搜索/查找信息",
    install: "安装依赖/包",
    read: "读取/查看文件",
    run: "执行/运行代码",
    write: "编写/修改代码",
    debug: "调试/修复问题",
    analyze: "分析/解释代码",
    chat: "聊天/讨论",
    unknown: "执行任务",
  },
};

const EN: ExecutionLocale = {
  kindDescriptions: {
    search: "Search/find information",
    install: "Install dependencies/packages",
    read: "Read/view files",
    run: "Execute/run code",
    write: "Write/modify code",
    debug: "Debug/fix issues",
    analyze: "Analyze/explain code",
    chat: "Chat/discuss",
    unknown: "Execute task",
  },
};

const LOCALES: Record<LocaleKey, ExecutionLocale> = {
  "zh-CN": ZH_CN,
  en: EN,
};

export function getLocale(key: LocaleKey): ExecutionLocale {
  return LOCALES[key] || LOCALES["zh-CN"];
}

export type { ExecutionLocale };
