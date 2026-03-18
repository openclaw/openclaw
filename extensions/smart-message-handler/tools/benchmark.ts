/**
 * Performance benchmark for smart-message-handler classifier.
 *
 * Usage: node --experimental-strip-types tools/benchmark.ts
 */
import { classifyMessage } from "../src/classifier.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

const MESSAGES = [
  // search
  "搜索代码库里的 TODO",
  "帮我找一下所有的 API endpoint。",
  "grep 一下 error log。",
  "查找所有未使用的导入。",
  "搜一下项目里的 console.log。",
  "在仓库里查一下 FIXME 注释。",
  "find all TODO comments in the codebase.",
  "search for unused variables.",

  // install
  "npm install axios",
  "pip install requests。",
  "brew install ripgrep。",
  "yarn add lodash --dev。",
  "pnpm add typescript。",
  "安装 react-query。",
  "apt install curl。",
  "install the missing dependencies.",

  // read
  "看一下 package.json",
  "读取 README.md。",
  "cat 一下 config.yaml。",
  "read the tsconfig.json file.",
  "查看 src/index.ts 的内容。",
  "显示 .env 文件。",
  "open the Dockerfile.",
  "读一下 openclaw.json。",

  // run
  "运行测试",
  "跑一下 pnpm build。",
  "启动开发服务器。",
  "run the unit tests.",
  "node --experimental-strip-types smoke-test.ts。",
  "执行数据库迁移。",
  "npm run dev。",
  "go run main.go。",

  // write
  "写一个 React 组件",
  "创建一个新的 API 接口。",
  "修改 config.ts 的默认值。",
  "write a utility function for debouncing.",
  "帮我翻译一下这段代码。",
  "写一个工具函数。",
  "create a new middleware.",
  "做个测试用例。",

  // debug
  "帮我找一下这个 bug",
  "修复这个 TypeError。",
  "这个函数报错了，帮我调试一下。",
  "fix the memory leak.",
  "这里有个错误，看看哪里出问题了。",
  "debug why the request is failing.",
  "改一下这个报错。",
  "修一下这个崩溃。",

  // analyze
  "分析一下性能",
  "解释一下这个算法。",
  "为什么这个请求这么慢",
  "analyze the time complexity of this function.",
  "explain how the session store works.",
  "理解一下这段逻辑。",
  "why is the build so slow?",
  "what caused the memory spike?",

  // chat
  "你好",
  "谢谢",
  "好的",
  "hi",
  "thanks!",
  "好的收到",
  "晚安",
  "再见",
];

const config = { ...DEFAULT_CONFIG };
const ITERATIONS = 1000;

function benchmark() {
  console.log(`=== Smart Message Handler Benchmark ===\n`);
  console.log(`Messages: ${MESSAGES.length}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log(`Total classifications: ${MESSAGES.length * ITERATIONS}\n`);

  const latencies: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    for (const msg of MESSAGES) {
      const start = performance.now();
      classifyMessage(msg, config);
      const elapsed = performance.now() - start;
      latencies.push(elapsed);
    }
  }

  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  const p50 = latencies[Math.floor(total * 0.5)];
  const p95 = latencies[Math.floor(total * 0.95)];
  const p99 = latencies[Math.floor(total * 0.99)];
  const avg = latencies.reduce((a, b) => a + b, 0) / total;
  const max = latencies[total - 1];

  console.log(`--- Latency Results ---`);
  console.log(`Average: ${avg.toFixed(3)}ms`);
  console.log(`P50:     ${p50.toFixed(3)}ms`);
  console.log(`P95:     ${p95.toFixed(3)}ms`);
  console.log(`P99:     ${p99.toFixed(3)}ms`);
  console.log(`Max:     ${max.toFixed(3)}ms`);
  console.log(`\nAll within <500ms constraint: ${max < 500 ? "YES" : "NO"}`);
  console.log(`All within <1ms:              ${max < 1 ? "YES" : "NO"}`);

  // JSON output for PR reference
  const result = {
    messages: MESSAGES.length,
    iterations: ITERATIONS,
    total,
    avg: parseFloat(avg.toFixed(6)),
    p50: parseFloat(p50.toFixed(6)),
    p95: parseFloat(p95.toFixed(6)),
    p99: parseFloat(p99.toFixed(6)),
    max: parseFloat(max.toFixed(6)),
  };
  console.log(`\n--- JSON ---`);
  console.log(JSON.stringify(result, null, 2));
}

benchmark();
