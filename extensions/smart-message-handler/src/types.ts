// ---- Type aliases ----

export type ExecutionKind =
  | "search"
  | "install"
  | "read"
  | "run"
  | "write"
  | "debug"
  | "analyze"
  | "chat"
  | "unknown";

export type ConfidenceLevel = "high" | "medium" | "low";
export type ModelTier = "fast" | "standard" | "premium";

// ---- Interfaces ----

export interface SmartHandlerConfig {
  readonly enabled: boolean;
  readonly incompleteSignals: string[];
  readonly completeSignals: string[];
  readonly baseDebounceMultiplier: number;
  readonly maxDebounceMultiplier: number;
  readonly minMessageLength: number;
  readonly debug: boolean;
  /** Enable finalized intent signal injection */
  readonly executionSignalEnabled: boolean;
  /** Skip prompt rewriting for the local main CLI session used in direct testing. */
  readonly disableForLocalMainSession: boolean;
  /** Enable shadow mode: run baseline classifier in parallel and log divergences. */
  readonly shadowModeEnabled: boolean;
  /** User-defined intent phrases. Matched before keyword scoring. */
  readonly customPhrases: readonly { readonly phrase: string; readonly kind: ExecutionKind }[];
  /** Enable embedding cache for semantic classification. */
  readonly embeddingCacheEnabled: boolean;
  /** Path to the embedding cache JSON file. */
  readonly embeddingCachePath: string;
  /** Language for execution signal instructions. */
  readonly locale: "zh-CN" | "en";
  /** Minimum weighted score for a kind to win classification. */
  readonly scoreThreshold: number;
  /** Enable model routing based on classification tier. */
  readonly modelRoutingEnabled: boolean;
  /** Model identifier for fast-tier requests (chat, unknown). */
  readonly fastModel: string;
  /** Model identifier for premium-tier requests (install, run, write, debug). */
  readonly premiumModel: string;
}

export interface ExecutionIntent {
  readonly input_finalized: boolean;
  readonly execution_expected: boolean;
  readonly execution_kind: ExecutionKind;
}

export interface MessageClassification {
  readonly kind: ExecutionKind;
  readonly confidence: ConfidenceLevel;
  readonly input_finalized: boolean;
  readonly execution_expected: boolean;
  readonly suggested_tier: ModelTier;
  readonly classifier_version: string;
  readonly score: number;
}

export interface PreComputedVerdict {
  readonly input_finalized: boolean;
  readonly execution_expected: boolean;
  readonly execution_kind: ExecutionKind;
  readonly classifier_version: string;
}

export interface SessionState {
  readonly lastMessageTime: number;
  readonly messageCount: number;
  readonly avgInterval: number;
  readonly totalIntervals: number;
}

export interface WeightedKeyword {
  readonly term: string;
  readonly weight: number; // 1-10
}

export interface ContextBonus {
  readonly label: string;
  readonly test: (stripped: string, raw: string) => boolean;
  readonly bonus: number;
}

export interface KindScoringRule {
  readonly keywords: readonly WeightedKeyword[];
  readonly contextBonuses: readonly ContextBonus[];
}

export interface ScoredResult {
  readonly kind: ExecutionKind;
  readonly score: number;
  readonly breakdown: readonly { readonly term: string; readonly contribution: number }[];
}

// ---- Constants ----

export const DEFAULT_CONFIG: SmartHandlerConfig = {
  enabled: true,
  incompleteSignals: ["...", "\uFF0C", ",", "\u3001", "\u5F85\u7EED", "continue"],
  completeSignals: [
    "\u3002",
    "\uFF1F",
    "?",
    "\uFF01",
    "!",
    " done",
    " \u5B8C\u4E86",
    " \u5C31\u8FD9\u4E9B",
  ],
  baseDebounceMultiplier: 1.5,
  maxDebounceMultiplier: 3,
  minMessageLength: 3,
  debug: false,
  executionSignalEnabled: true,
  disableForLocalMainSession: true,
  shadowModeEnabled: false,
  customPhrases: [],
  embeddingCacheEnabled: false,
  embeddingCachePath: "",
  locale: "zh-CN",
  scoreThreshold: 5.0,
  modelRoutingEnabled: false,
  fastModel: "",
  premiumModel: "",
};

export const SCORING_RULES: Record<Exclude<ExecutionKind, "unknown">, KindScoringRule> = {
  search: {
    keywords: [
      { term: "搜索", weight: 8 },
      { term: "search", weight: 8 },
      { term: "grep", weight: 9 },
      { term: "查找", weight: 7 },
      { term: "查询", weight: 7 },
      { term: "搜一下", weight: 6 },
      { term: "find", weight: 6 },
      { term: "找一下", weight: 5 },
      { term: "找", weight: 3 },
      { term: "查", weight: 3 },
    ],
    contextBonuses: [
      {
        label: "scope-word",
        test: (s) => /(?:文件|目录|仓库|项目|代码|文件夹|repo|directory|folder|codebase)/i.test(s),
        bonus: 3,
      },
    ],
  },
  install: {
    keywords: [
      { term: "install", weight: 9 },
      { term: "安装", weight: 9 },
      { term: "npm", weight: 7 },
      { term: "pip", weight: 7 },
      { term: "brew", weight: 7 },
      { term: "apt", weight: 7 },
      { term: "yarn", weight: 6 },
      { term: "pnpm", weight: 5 },
    ],
    contextBonuses: [{ label: "package-name", test: (s) => /@[\w-]+\/[\w-]+/.test(s), bonus: 4 }],
  },
  read: {
    keywords: [
      { term: "读取", weight: 7 },
      { term: "read", weight: 7 },
      { term: "查看", weight: 6 },
      { term: "cat", weight: 7 },
      { term: "open", weight: 5 },
      { term: "显示", weight: 5 },
      { term: "看一下", weight: 5 },
      { term: "读一下", weight: 5 },
      { term: "看", weight: 2 },
    ],
    contextBonuses: [
      {
        label: "file-path",
        test: (s) => /\.(?:ts|js|py|go|rs|json|yaml|yml|toml|md|txt|sh|css|html)\b/.test(s),
        bonus: 5,
      },
    ],
  },
  run: {
    keywords: [
      { term: "运行", weight: 7 },
      { term: "执行", weight: 7 },
      { term: "run", weight: 7 },
      { term: "execute", weight: 7 },
      { term: "start", weight: 5 },
      { term: "启动", weight: 6 },
      { term: "跑一下", weight: 7 },
      { term: "跑", weight: 5 },
    ],
    contextBonuses: [
      {
        label: "command-pattern",
        test: (s) => /(?:npm\s+run|pnpm\s|node\s|python\s|go\s+run|cargo\s+run|make\s)/i.test(s),
        bonus: 5,
      },
    ],
  },
  write: {
    keywords: [
      { term: "写", weight: 4 },
      { term: "创建", weight: 6 },
      { term: "修改", weight: 5 },
      { term: "write", weight: 6 },
      { term: "create", weight: 6 },
      { term: "modify", weight: 5 },
      { term: "edit", weight: 5 },
      { term: "保存", weight: 5 },
      { term: "写一个", weight: 5 },
      { term: "翻译", weight: 5 },
      { term: "做个", weight: 4 },
    ],
    contextBonuses: [
      {
        label: "artifact-noun",
        test: (s) =>
          /(?:文件|脚本|组件|模块|函数|类|接口|file|script|component|module|function|class)/i.test(
            s,
          ),
        bonus: 4,
      },
    ],
  },
  debug: {
    keywords: [
      { term: "debug", weight: 9 },
      { term: "bug", weight: 8 },
      { term: "调试", weight: 8 },
      { term: "修复", weight: 7 },
      { term: "fix", weight: 7 },
      { term: "错误", weight: 6 },
      { term: "error", weight: 6 },
      { term: "修一下", weight: 5 },
      { term: "改一下", weight: 4 },
      { term: "报错", weight: 7 },
    ],
    contextBonuses: [
      {
        label: "error-trace",
        test: (s) =>
          /(?:stack\s*trace|Error:|TypeError:|报错|异常|exception|traceback|panic)/i.test(s),
        bonus: 5,
      },
    ],
  },
  analyze: {
    keywords: [
      { term: "分析", weight: 7 },
      { term: "解释", weight: 6 },
      { term: "理解", weight: 5 },
      { term: "analyze", weight: 7 },
      { term: "explain", weight: 6 },
      { term: "为什么", weight: 6 },
      { term: "why", weight: 3 },
      { term: "how", weight: 3 },
    ],
    contextBonuses: [
      {
        label: "question-structure",
        test: (s) => /(?:为什么|怎么回事|什么原因|how\s+come|what\s+caused)/i.test(s),
        bonus: 4,
      },
    ],
  },
  chat: {
    keywords: [
      { term: "聊聊", weight: 7 },
      { term: "聊天", weight: 7 },
      { term: "chat", weight: 7 },
      { term: "说说", weight: 5 },
      { term: "讲讲", weight: 5 },
      { term: "怎么样", weight: 3 },
      { term: "好吗", weight: 3 },
      { term: "你好", weight: 4 },
    ],
    contextBonuses: [
      { label: "short-message", test: (s) => s.length < 15, bonus: 5 },
      {
        label: "no-tech-terms",
        test: (s) =>
          !/(?:代码|程序|文件|项目|脚本|服务|接口|模块|API|npm|git|docker|server|database|config|deploy|code|bug|error)/i.test(
            s,
          ),
        bonus: 3,
      },
    ],
  },
};

export const CHAT_PATTERNS: readonly RegExp[] = [
  /^你(?:好吗|怎么样|最近)[\s?？]*$/i,
  /^聊(?:聊|一下)[\s。.!！?？]*$/i,
  /^(?:hi|hello|hey|你好|早上好|晚上好)[\s!！.。]*$/i,
  /^(?:谢谢|感谢|thanks)[\s!！.。]*$/i,
  /^(?:好的|ok|okay|嗯|行|收到)[\s!！.。]*$/i,
  /^(?:晚安|再见|bye)[\s!！.。]*$/i,
  /^怎么样(?:呢)?[\s?？]*$/i,
  /^你在吗[\s?？]*$/i,
];

export const TASK_PATTERNS: readonly RegExp[] = [
  /^帮我\s*(?:写|做|创建|修改|运行|搜索|查找|安装|调试|修复|部署|配置|测试|分析)/i,
  /^请\s*(?:帮我\s*)?(?:写|做|创建|修改|运行|搜索|查找|安装|调试|修复|部署|配置|测试)/i,
  /^(?:能不能|可以)\s*(?:帮我\s*)?(?:写|做|创建|修改|运行|安装|调试|修复|部署)/i,
  /^麻烦你?\s*(?:写|做|创建|修改|运行|安装|调试|修复|部署|配置)/i,
  /^(?:去|你去|你先)\s*(?:查|看|检查|审查|测试|运行|部署|安装|修复)/i,
  /(?:写|创建|修改|运行|部署|安装|调试|修复|测试)\s*(?:一个|一下)?\s*(?:代码|程序|文件|项目|脚本|服务|接口|组件|模块)/i,
  /(?:运行|执行|跑|启动)\s+(?:一下\s+)?(?:[\w./-]+|这个|那个|它)/i,
];

export const SCORE_THRESHOLD = 5.0;
export const TIE_BREAK_PRIORITY: readonly ExecutionKind[] = [
  "debug",
  "install",
  "run",
  "write",
  "search",
  "read",
  "analyze",
  "chat",
];

export const KIND_DESCRIPTIONS: Record<ExecutionKind, string> = {
  search: "\u641C\u7D22/\u67E5\u627E\u4FE1\u606F",
  install: "\u5B89\u88C5\u4F9D\u8D56/\u5305",
  read: "\u8BFB\u53D6/\u67E5\u770B\u6587\u4EF6",
  run: "\u6267\u884C/\u8FD0\u884C\u4EE3\u7801",
  write: "\u7F16\u5199/\u4FEE\u6539\u4EE3\u7801",
  debug: "\u8C03\u8BD5/\u4FEE\u590D\u95EE\u9898",
  analyze: "\u5206\u6790/\u89E3\u91CA\u4EE3\u7801",
  chat: "\u804A\u5929/\u8BA8\u8BBA",
  unknown: "\u6267\u884C\u4EFB\u52A1",
};
