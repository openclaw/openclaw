import type { Subtask, Batch } from './types.js';

/**
 * 构建依赖图并生成批处理计划
 * 批处理允许多个无依赖任务并行执行
 */
export function buildBatches(subtasks: Subtask[]): Batch[] {
  // 1. 构建邻接表
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  
  subtasks.forEach(st => {
    adjacency.set(st.id, []);
    inDegree.set(st.id, 0);
  });
  
  // 计算入度
  subtasks.forEach(st => {
    st.dependencies.forEach(dep => {
      if (adjacency.has(dep)) {
        adjacency.get(dep)!.push(st.id);
        inDegree.set(st.id, (inDegree.get(st.id) ?? 0) + 1);
      }
    });
  });
  
  // 2. 拓扑排序 + 批处理
  const batches: Batch[] = [];
  const ready: string[] = [];
  
  // 初始：所有入度为0的任务
  subtasks.forEach(st => {
    if (inDegree.get(st.id) === 0) {
      ready.push(st.id);
    }
  });
  
  // 检测循环依赖
  const visited = new Set<string>();
  while (ready.length > 0) {
    // 当前批：所有ready任务（可并行）
    const currentBatch: string[] = [...ready];
    batches.push(currentBatch);
    
    // 标记已处理
    currentBatch.forEach(id => {
      visited.add(id);
      inDegree.set(id, -1); // 标记为已处理
    });
    
    // 清空ready，准备下一批
    ready.length = 0;
    
    // 更新邻居入度
    currentBatch.forEach(id => {
      const neighbors = adjacency.get(id) ?? [];
      neighbors.forEach(neighbor => {
        if (!visited.has(neighbor)) {
          const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
          inDegree.set(neighbor, newDegree);
          if (newDegree === 0) {
            ready.push(neighbor);
          }
        }
      });
    });
  }
  
  // 检查是否有循环依赖
  if (visited.size !== subtasks.length) {
    const missing = subtasks.filter(st => !visited.has(st.id));
    throw new Error(`循环依赖检测失败，以下任务未解决依赖：${missing.map(st => st.id).join(', ')}`);
  }
  
  return batches;
}

/**
 * 验证依赖图（拓扑排序检查）
 */
export function validateDependencies(subtasks: Subtask[]): { valid: boolean; cycles?: string[] } {
  try {
    buildBatches(subtasks);
    return { valid: true };
  } catch (error: any) {
    return { valid: false, cycles: [error.message] };
  }
}

/**
 * 统计批处理信息
 */
export function getBatchStats(batches: Batch[]): {
  totalBatches: number;
  totalTasks: number;
  maxBatchSize: number;
  parallelDepth: number;
} {
  return {
    totalBatches: batches.length,
    totalTasks: batches.reduce((sum, batch) => sum + batch.length, 0),
    maxBatchSize: Math.max(...batches.map(b => b.length)),
    parallelDepth: batches.length,
  };
}
