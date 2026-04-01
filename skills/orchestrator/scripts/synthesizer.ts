import type { SubtaskResult, OrchestrationResult, Conflict } from './types.js';

/**
 * 收集并合成子任务结果
 */
export function synthesizeResults(
  results: SubtaskResult[],
  conflicts?: Conflict[],
): OrchestrationResult {
  const completed = results.filter(r => r.status === 'completed');
  const failed = results.filter(r => r.status === 'failed' || r.status === 'timeout');
  
  const status: OrchestrationResult['status'] = 
    failed.length === 0 ? 'completed' :
    completed.length > 0 ? 'partial-failure' : 'failed';
  
  // 收集生产物
  const artifacts: OrchestrationResult['artifacts'] = [];
  completed.forEach(r => {
    if (r.artifacts) {
      r.artifacts.forEach(a => {
        artifacts.push({
          ...a,
          producedBy: r.subtaskId,
        });
      });
    }
  });
  
  // 构建最终结果文本
  const resultText = buildResultText(completed, failed, conflicts);
  
  return {
    status,
    totalTasks: results.length,
    completedTasks: completed.length,
    failedTasks: failed.length,
    batches: 1, // 将由orchestrator填充实际批次
    result: resultText,
    conflicts,
    artifacts,
    results,
  };
}

/**
 * 构建人类可读的结果文本
 */
function buildResultText(
  completed: SubtaskResult[],
  failed: SubtaskResult[],
  conflicts?: Conflict[],
): string {
  const lines: string[] = [];
  
  lines.push('=== Orchestration Result ===\n');
  lines.push(`✅ 完成: ${completed.length} 个子任务`);
  lines.push(`❌ 失败: ${failed.length} 个子任务`);
  
  if (conflicts && conflicts.length > 0) {
    lines.push(`⚠️  冲突: ${conflicts.length} 个文件`);
  }
  
  lines.push('\n--- 已完成任务详情 ---');
  completed.forEach(r => {
    const duration = (r.durationMs / 1000).toFixed(1);
    lines.push(`✓ ${r.subtaskId} (${duration}s)`);
    if (r.output && r.output.length > 200) {
      lines.push(`  输出: ${r.output.substring(0, 200)}...`);
    } else if (r.output) {
      lines.push(`  输出: ${r.output}`);
    }
    if (r.artifacts) {
      r.artifacts.forEach(a => {
        lines.push(`  📄 ${a.type}: ${a.path}`);
      });
    }
  });
  
  if (failed.length > 0) {
    lines.push('\n--- 失败任务 ---');
    failed.forEach(r => {
      lines.push(`✗ ${r.subtaskId}: ${r.error || 'unknown error'}`);
    });
  }
  
  if (conflicts && conflicts.length > 0) {
    lines.push('\n--- 冲突文件（需要手动处理）---');
    conflicts.forEach(c => {
      lines.push(`⚠️  ${c.file}`);
      lines.push(`   涉及任务: ${c.tasks.join(', ')}`);
      lines.push(`   建议: ${c.resolution === 'auto-merged' ? '已自动合并' : '请手动合并'}`);
      if (c.details) {
        lines.push(`   详情: ${c.details}`);
      }
    });
  }
  
  lines.push('\n=== End of Report ===');
  return lines.join('\n');
}

/**
 * 检测文件冲突
 * 比较多个子任务修改的文件列表，找出重叠修改
 */
export function detectConflicts(results: SubtaskResult[]): Conflict[] {
  const fileMap = new Map<string, string[]>();
  
  results.forEach(r => {
    if (r.modifiedFiles) {
      r.modifiedFiles.forEach(file => {
        const tasks = fileMap.get(file) ?? [];
        tasks.push(r.subtaskId);
        fileMap.set(file, tasks);
      });
    }
  });
  
  const conflicts: Conflict[] = [];
  fileMap.forEach((tasks, file) => {
    if (tasks.length > 1) {
      conflicts.push({
        file,
        tasks,
        resolution: 'manual', // 默认需手动处理
      });
    }
  });
  
  return conflicts;
}

/**
 * 尝试自动合并文件修改（简单合并策略）
 * 仅当任务修改不重叠时才自动合并，否则标记为manual
 */
export function attemptAutoMerge(
  conflicts: Conflict[],
  getFileContent: (file: string, taskId: string) => string | null,
): Conflict[] {
  return conflicts.map(c => {
    const contents = c.tasks.map(taskId => getFileContent(c.file, taskId)).filter(Boolean) as string[];
    
    // 简单启发式：如果内容完全相同，说明是重复任务，可以合并
    if (contents.length > 1 && contents.every(c => c === contents[0])) {
      return { ...c, resolution: 'auto-merged' as const, details: '所有修改相同，自动合并' };
    }
    
    // TODO: 实现更智能的merge（如git merge-style）
    return c;
  });
}
