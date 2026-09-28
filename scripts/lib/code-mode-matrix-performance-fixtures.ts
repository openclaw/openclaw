import { DATA_TASKS, createDataFixture, isDataTask } from "./code-mode-matrix-data-tasks.ts";
import {
  FANOUT_MATRIX_TASKS,
  createFanoutMatrixFixture,
  isFanoutMatrixTask,
} from "./code-mode-matrix-fanout-tasks.ts";
import type { MatrixPerformanceFixture } from "./code-mode-matrix-performance-types.ts";
import {
  RECOVERY_MATRIX_TASKS,
  createRecoveryMatrixFixture,
  isRecoveryMatrixTask,
} from "./code-mode-matrix-recovery-tasks.ts";
import {
  REPOSITORY_MATRIX_TASKS,
  createRepositoryMatrixFixture,
  isRepositoryMatrixTask,
} from "./code-mode-matrix-repository-tasks.ts";

export const MATRIX_PERFORMANCE_TASKS = [
  ...DATA_TASKS,
  ...REPOSITORY_MATRIX_TASKS,
  ...FANOUT_MATRIX_TASKS,
  ...RECOVERY_MATRIX_TASKS,
] as const;

export type MatrixPerformanceTask = (typeof MATRIX_PERFORMANCE_TASKS)[number];

export function isMatrixPerformanceTask(task: string): task is MatrixPerformanceTask {
  return MATRIX_PERFORMANCE_TASKS.some((candidate) => candidate === task);
}

export function createMatrixPerformanceFixture(
  task: MatrixPerformanceTask,
  repetition: number,
): MatrixPerformanceFixture {
  if (isDataTask(task)) {
    return createDataFixture(task, repetition);
  }
  if (isRepositoryMatrixTask(task)) {
    return createRepositoryMatrixFixture(task, repetition);
  }
  if (isFanoutMatrixTask(task)) {
    return createFanoutMatrixFixture(task, repetition);
  }
  if (isRecoveryMatrixTask(task)) {
    return createRecoveryMatrixFixture(task, repetition);
  }
  throw new Error(`Unknown performance task: ${String(task)}`);
}
