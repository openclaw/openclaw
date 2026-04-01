import type { DecompositionResult, Subtask } from './types.js';

/**
 * 将复杂任务分解为原子子任务
 * 使用主agent的LLM能力进行分解，输出结构化JSON
 */
export async function decomposeTask(
  task: string,
  customPrompt?: string,
): Promise<DecompositionResult> {
  // 构建系统提示词
  const systemPrompt = getDecomposeSystemPrompt();
  const userPrompt = customPrompt || getDecomposeUserPrompt(task);

  // 调用主agent进行分解（通过网关）
  // 注意：这里我们直接使用主agent的聊天能力，不需要special LLM
  const response = await callGatewayWithLLM({
    system: systemPrompt,
    user: userPrompt,
    responseFormat: { type: 'json_object' as const },
  });

  // 解析JSON输出
  const parsed = JSON.parse(response);
  
  // 验证并丰富subtasks
  const subtasks: Subtask[] = parsed.subtasks.map((st: any, idx: number) => ({
    id: st.id || `task_${idx}`,
    description: st.description,
    type: normalizeSubtaskType(st.type),
    dependencies: Array.isArray(st.dependencies) ? st.dependencies : [],
    context: Array.isArray(st.context) ? st.context : undefined,
    priority: st.priority ?? 1,
    requiredTools: Array.isArray(st.requiredTools) ? st.requiredTools : undefined,
  }));

  // 后处理：确保依赖关系有效，移除循环引用
  subtasks.forEach(st => {
    st.dependencies = st.dependencies.filter(depId => 
      subtasks.some(st2 => st2.id === depId)
    );
  });

  return {
    subtasks,
    metadata: {
      total: subtasks.length,
      estimatedComplexity: estimateComplexity(subtasks),
    },
  };
}

function normalizeSubtaskType(type: string): Subtask['type'] {
  const normalized = type.toLowerCase();
  const valid = ['code', 'test', 'docs', 'research', 'review', 'refactor', 'config'];
  return valid.includes(normalized) ? normalized : 'code';
}

function estimateComplexity(subtasks: Subtask[]): 'low' | 'medium' | 'high' {
  const total = subtasks.length;
  const hasComplex = subtasks.some(st => st.priority && st.priority > 3);
  
  if (total <= 2 && !hasComplex) return 'low';
  if (total <= 5 && !hasComplex) return 'medium';
  return 'high';
}

function getDecomposeSystemPrompt(): string {
  return `你是一个任务分解专家。将用户的高级任务拆分为原子子任务。

要求：
1. 每个子任务必须是原子的、自包含的（单一职责）
2. 识别任务间的依赖关系（使用dependencies字段）
3. 为每个子任务指定type（code/test/docs/research/review/refactor/config）
4. 可选的context字段列出相关文件路径
5. 可选的priority字段（1-5，1为最高）
6. 输出必须是合法JSON，符合以下schema：

{
  "subtasks": [
    {
      "id": "唯一标识，如 task_1",
      "description": "具体、可执行的任务描述",
      "type": "code|test|docs|research|review|refactor|config",
      "dependencies": ["依赖的其他任务ID数组，可为空"],
      "context": ["相关文件路径（可选）"],
      "priority": 1-5（可选，默认1）,
      "requiredTools": ["所需工具列表（可选）"]
    }
  ]
}

示例：
用户: "重构auth模块并更新所有相关测试"
输出:
{
  "subtasks": [
    {
      "id": "task_1",
      "description": "重构 src/auth/auth.service.ts 的登录逻辑，提取验证中间件",
      "type": "refactor",
      "dependencies": [],
      "context": ["src/auth/auth.service.ts"],
      "priority": 1
    },
    {
      "id": "task_2",
      "description": "更新 src/auth/__tests__/auth.test.ts 以匹配新的API",
      "type": "test",
      "dependencies": ["task_1"],
      "context": ["src/auth/__tests__/auth.test.ts"],
      "priority": 2
    },
    {
      "id": "task_3",
      "description": "更新API文档（docs/auth-api.md）",
      "type": "docs",
      "dependencies": ["task_1"],
      "context": ["docs/auth-api.md"],
      "priority": 3
    }
  ]
}

重要：确保dependencies字段正确反映任务间依赖关系。`;
}

function getDecomposeUserPrompt(task: string): string {
  return `用户任务：\n${task}\n\n请按上述要求分解为子任务并返回JSON。`;
}

// 临时包装网关调用（实际实现时应该调用主agent的普通聊天能力）
async function callGatewayWithLLM(params: {
  system: string;
  user: string;
  responseFormat?: { type: 'json_object' };
}): Promise<string> {
  // TODO: 实际实现时，应该通过主agent的聊天能力调用
  // 这里可以调用sessions_send或gateway API
  // 需要考虑当前上下文——直接调用主agent的模型
  
  // 临时方案：抛出未实现错误，提示需要集成主agent聊天能力
  throw new Error('callGatewayWithLLM not implemented - needs integration with main agent chat');
}
