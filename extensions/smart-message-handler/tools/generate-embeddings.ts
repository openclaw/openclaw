/**
 * Generate embedding cache for smart-message-handler.
 *
 * Usage:
 *   node --experimental-strip-types tools/generate-embeddings.ts [output.json]
 *
 * Requires a local embedding API at http://localhost:48760/v1/embeddings
 * (or set EMBEDDING_API_URL environment variable)
 */

import { writeFileSync } from "node:fs";

const API_URL = process.env.EMBEDDING_API_URL || "http://localhost:48760/v1/embeddings";
const MODEL = process.env.EMBEDDING_MODEL || "text-embedding-ada-002";

// Representative samples for each kind
const SAMPLES: readonly { readonly text: string; readonly kind: string }[] = [
  // search (10)
  { text: "搜索代码库里的 TODO", kind: "search" },
  { text: "帮我找一下所有的 API endpoint", kind: "search" },
  { text: "grep error log", kind: "search" },
  { text: "在项目里搜一下这个函数", kind: "search" },
  { text: "查找所有未使用的导入", kind: "search" },
  { text: "search for unused variables", kind: "search" },
  { text: "find all TODO comments", kind: "search" },
  { text: "帮我查一下哪些文件用了这个接口", kind: "search" },
  { text: "搜索一下报错关键词", kind: "search" },
  { text: "找一下配置文件在哪", kind: "search" },

  // install (8)
  { text: "安装 axios", kind: "install" },
  { text: "npm install typescript", kind: "install" },
  { text: "pip install requests", kind: "install" },
  { text: "brew install node", kind: "install" },
  { text: "pnpm add lodash", kind: "install" },
  { text: "yarn add react", kind: "install" },
  { text: "帮我装一下依赖", kind: "install" },
  { text: "install the missing packages", kind: "install" },

  // read (8)
  { text: "看一下 package.json", kind: "read" },
  { text: "读取 README.md 的内容", kind: "read" },
  { text: "cat config.yaml", kind: "read" },
  { text: "打开 .env 文件看看", kind: "read" },
  { text: "显示一下 tsconfig.json", kind: "read" },
  { text: "read the error log", kind: "read" },
  { text: "查看一下数据库配置", kind: "read" },
  { text: "帮我看看这个文件的内容", kind: "read" },

  // run (8)
  { text: "运行测试", kind: "run" },
  { text: "跑一下 pnpm build", kind: "run" },
  { text: "启动开发服务器", kind: "run" },
  { text: "执行这个脚本", kind: "run" },
  { text: "run the unit tests", kind: "run" },
  { text: "start the server", kind: "run" },
  { text: "帮我跑一下这个命令", kind: "run" },
  { text: "npm run dev", kind: "run" },

  // write (8)
  { text: "写一个 React 登录组件", kind: "write" },
  { text: "创建一个新的 API 接口", kind: "write" },
  { text: "修改默认配置值", kind: "write" },
  { text: "帮我写一个工具函数", kind: "write" },
  { text: "create a new test file", kind: "write" },
  { text: "做一个数据库迁移脚本", kind: "write" },
  { text: "编写一个 webhook handler", kind: "write" },
  { text: "帮我翻译一下这段代码", kind: "write" },

  // debug (8)
  { text: "帮我找一下这个 bug", kind: "debug" },
  { text: "修复这个 TypeError", kind: "debug" },
  { text: "这个函数报错了", kind: "debug" },
  { text: "debug this crash", kind: "debug" },
  { text: "这个地方又挂了", kind: "debug" },
  { text: "帮我调试一下这个接口", kind: "debug" },
  { text: "fix the failing test", kind: "debug" },
  { text: "排查一下为什么请求超时", kind: "debug" },

  // analyze (8)
  { text: "分析一下这段代码的性能", kind: "analyze" },
  { text: "解释一下这个算法", kind: "analyze" },
  { text: "为什么这个请求这么慢", kind: "analyze" },
  { text: "帮我理解这个设计模式", kind: "analyze" },
  { text: "explain this function", kind: "analyze" },
  { text: "这段代码是什么意思", kind: "analyze" },
  { text: "分析一下内存泄漏的原因", kind: "analyze" },
  { text: "review this PR", kind: "analyze" },

  // chat (8)
  { text: "你好", kind: "chat" },
  { text: "谢谢", kind: "chat" },
  { text: "好的", kind: "chat" },
  { text: "hello", kind: "chat" },
  { text: "晚安", kind: "chat" },
  { text: "收到", kind: "chat" },
  { text: "ok", kind: "chat" },
  { text: "嗯嗯", kind: "chat" },
];

async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: text }),
  });
  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.data[0].embedding;
}

async function main() {
  const outputPath = process.argv[2] || "embedding-cache.json";
  console.log(`Generating embeddings for ${SAMPLES.length} samples...`);
  console.log(`API: ${API_URL}, Model: ${MODEL}\n`);

  const entries: { text: string; kind: string; vector: number[] }[] = [];
  let dimension = 0;

  for (let i = 0; i < SAMPLES.length; i++) {
    const sample = SAMPLES[i];
    try {
      const vector = await getEmbedding(sample.text);
      if (dimension === 0) {
        dimension = vector.length;
      }
      entries.push({ text: sample.text, kind: sample.kind, vector });
      process.stdout.write(
        `  [${i + 1}/${SAMPLES.length}] ${sample.kind}: ${sample.text.slice(0, 40)}\n`,
      );
    } catch (e) {
      console.error(`  FAILED: ${sample.text} - ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const cache = { entries, dimension };
  writeFileSync(outputPath, JSON.stringify(cache, null, 2));
  console.log(`\nWrote ${entries.length} embeddings (dim=${dimension}) to ${outputPath}`);
}

main().catch(console.error);
