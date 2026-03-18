/**
 * Offline calibration tool for smart-message-handler
 *
 * Usage:
 *   node --experimental-strip-types tools/calibrate.ts [data.jsonl]
 *
 * Input format (JSONL, one per line):
 *   {"message": "帮我找一下 bug", "expected_kind": "debug"}
 *   {"message": "你好", "expected_kind": "chat"}
 *
 * If no file provided, uses built-in test corpus.
 */

import { readFileSync } from "node:fs";
import { classifyExecutionIntent } from "../src/classifier.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import type { SmartHandlerConfig, ExecutionKind } from "../src/types.ts";

interface LabeledSample {
  message: string;
  expected_kind: ExecutionKind;
  expected_policy_gate?: boolean;
  expected_delegation?: boolean;
}

// Built-in test corpus -- representative examples for each kind
const BUILTIN_CORPUS: LabeledSample[] = [
  // search
  { message: "搜索 codebase 里的 TODO。", expected_kind: "search" },
  { message: "帮我找一下所有的 API endpoint。", expected_kind: "search" },
  { message: "grep 一下 error log。", expected_kind: "search" },

  // install
  { message: "安装 axios。", expected_kind: "install" },
  { message: "npm install typescript。", expected_kind: "install" },
  { message: "pip install requests。", expected_kind: "install" },

  // read
  { message: "看一下 package.json。", expected_kind: "read" },
  { message: "读取 README.md 的内容。", expected_kind: "read" },
  { message: "cat 一下 config.yaml。", expected_kind: "read" },

  // run
  { message: "运行测试。", expected_kind: "run" },
  { message: "跑一下 pnpm build。", expected_kind: "run" },
  { message: "启动开发服务器。", expected_kind: "run" },

  // write
  { message: "写一个 React 登录组件。", expected_kind: "write" },
  { message: "创建一个新的 API 接口。", expected_kind: "write" },
  { message: "修改 config.ts 的默认值。", expected_kind: "write" },

  // debug
  { message: "帮我找一下这个 bug？", expected_kind: "debug" },
  { message: "修复这个 TypeError。", expected_kind: "debug" },
  { message: "这个函数报错了，帮我调试一下。", expected_kind: "debug" },

  // analyze
  { message: "分析一下这段代码的性能？", expected_kind: "analyze" },
  { message: "解释一下这个算法？", expected_kind: "analyze" },
  { message: "为什么这个请求这么慢？", expected_kind: "analyze" },

  // chat
  { message: "你好", expected_kind: "chat" },
  { message: "谢谢", expected_kind: "chat" },
  { message: "好的", expected_kind: "chat" },

  // ambiguous -- tests precision under conflicting signals
  { message: "帮我找一下这个 bug 并修复？", expected_kind: "debug" },
  { message: "看一下服务器上的错误日志？", expected_kind: "read" },
  { message: "搜索代码库里的安全漏洞？", expected_kind: "search" },
  { message: "帮我翻译一下这段代码。", expected_kind: "write" },
];

function evaluate(
  corpus: LabeledSample[],
  config: SmartHandlerConfig,
): {
  accuracy: number;
  correct: number;
  total: number;
  errors: Array<{ message: string; expected: string; got: string }>;
} {
  let correct = 0;
  const errors: Array<{ message: string; expected: string; got: string }> = [];

  for (const sample of corpus) {
    const result = classifyExecutionIntent(sample.message, config);
    if (result.execution_kind === sample.expected_kind) {
      correct++;
    } else {
      errors.push({
        message: sample.message.slice(0, 60),
        expected: sample.expected_kind,
        got: result.execution_kind,
      });
    }
  }

  return {
    accuracy: corpus.length > 0 ? correct / corpus.length : 0,
    correct,
    total: corpus.length,
    errors,
  };
}

function gridSearch(corpus: LabeledSample[]): void {
  console.log("=== Smart Message Handler Calibration Tool ===\n");

  // Evaluate current config
  console.log("--- Current Configuration ---");
  const currentResult = evaluate(corpus, DEFAULT_CONFIG);
  console.log(
    `Accuracy: ${(currentResult.accuracy * 100).toFixed(1)}% (${currentResult.correct}/${currentResult.total})`,
  );
  if (currentResult.errors.length > 0) {
    console.log("Misclassifications:");
    for (const err of currentResult.errors) {
      console.log(`  "${err.message}" -> expected ${err.expected}, got ${err.got}`);
    }
  }
  console.log();

  // Grid search over scoreThreshold using the full classifier pipeline
  console.log("--- Grid Search: scoreThreshold ---");
  const thresholds = [3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
  let bestThreshold = DEFAULT_CONFIG.scoreThreshold;
  let bestAccuracy = 0;

  for (const threshold of thresholds) {
    const testConfig: SmartHandlerConfig = { ...DEFAULT_CONFIG, scoreThreshold: threshold };
    const result = evaluate(corpus, testConfig);
    console.log(`  threshold=${threshold}: accuracy=${(result.accuracy * 100).toFixed(1)}%`);
    if (result.accuracy > bestAccuracy) {
      bestAccuracy = result.accuracy;
      bestThreshold = threshold;
    }
  }

  console.log(`\nBest scoreThreshold: ${bestThreshold} (${(bestAccuracy * 100).toFixed(1)}%)`);
  console.log("\n--- Recommendation ---");
  console.log(`Set in openclaw.json -> plugins.entries["smart-message-handler"].config:`);
  console.log(`  "scoreThreshold": ${bestThreshold}`);
}

// Main
const dataFile = process.argv[2];
let corpus: LabeledSample[];

if (dataFile) {
  try {
    const content = readFileSync(dataFile, "utf-8");
    corpus = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    console.log(`Loaded ${corpus.length} samples from ${dataFile}\n`);
  } catch (e) {
    console.error(`Failed to load ${dataFile}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
} else {
  corpus = BUILTIN_CORPUS;
  console.log(`Using built-in corpus (${corpus.length} samples)\n`);
}

gridSearch(corpus);
