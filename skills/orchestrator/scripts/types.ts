type Subtask = {
  /** 子任务唯一ID */
  id: string;
  /** 任务描述（具体、可执行） */
  description: string;
  /** 任务类型，用于agent匹配 */
  type: 'code' | 'test' | 'docs' | 'research' | 'review' | 'refactor' | 'config';
  /** 依赖的其他子任务ID数组 */
  dependencies: string[];
  /** 相关文件/上下文路径（可选） */
  context?: string[];
  /** 预估复杂度（用于调度） */
  priority?: number;
  /** 所需的工具列表（可选，用于agent能力匹配） */
  requiredTools?: string[];
};

export type DecompositionResult = {
  subtasks: Subtask[];
  metadata: {
    total: number;
    estimatedComplexity: 'low' | 'medium' | 'high';
  };
};

export type Batch = string[]; // 子任务ID数组

export type OrchestrationConfig = {
  /** Agent类型映射 */
  agentMap?: Record<string, string>;
  /** 全局最大并发 */
  maxConcurrent?: number;
  /** 每个任务超时（秒） */
  timeoutPerTask?: number;
  /** 自定义分解prompt */
  decomposePrompt?: string;
};

export type SubtaskResult = {
  subtaskId: string;
  status: 'completed' | 'failed' | 'timeout' | 'skipped';
  output?: string;
  error?: string;
  durationMs: number;
  sessionKey?: string;
  /** 产出的文件/补丁 */
  artifacts?: Array<{
    type: 'patch' | 'file' | 'report';
    path: string;
    size?: number;
  }>;
  /** 修改的文件列表（用于冲突检测） */
  modifiedFiles?: string[];
};

export type OrchestrationResult = {
  status: 'completed' | 'partial-failure' | 'failed';
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  batches: number;
  result: string;
  /** 冲突文件列表 */
  conflicts?: Array<{
    file: string;
    tasks: string[];
    resolution: 'manual' | 'auto-merged';
    details?: string;
  }>;
  /** 生产物清单 */
  artifacts?: Array<{
    type: 'patch' | 'file' | 'report';
    path: string;
    producedBy: string;
  }>;
  /** 详细结果（可选） */
  results?: SubtaskResult[];
};

export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode: 'run' | 'session';
  cleanup?: 'delete' | 'keep';
  sandbox?: 'inherit' | 'require';
  attachments?: Array<{
    name: string;
    content: string;
    encoding?: 'utf8' | 'base64';
    mimeType?: string;
  }>;
};
