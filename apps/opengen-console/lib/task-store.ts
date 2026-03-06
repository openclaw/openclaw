import fs from "node:fs/promises";
import path from "node:path";

export interface StoredTask {
  task_id: string;
  status?: string;
  current_stage?: string;
  created_at?: number;
  completed_at?: number;
  request?: {
    description?: string;
    type?: string;
  };
  outputs?: Record<string, unknown>;
  error?: string;
}

export interface TaskStore {
  save(task: StoredTask): Promise<void>;
  list(): Promise<StoredTask[]>;
  getById(taskId: string): Promise<StoredTask | undefined>;
}

const DEFAULT_STORE_PATH = path.join(process.cwd(), ".run", "opengen-console", "tasks.json");

async function readTasks(filePath: string): Promise<StoredTask[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredTask[]) : [];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeTasks(filePath: string, tasks: StoredTask[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(tasks, null, 2), "utf8");
}

export function createTaskStore(filePath: string = DEFAULT_STORE_PATH): TaskStore {
  return {
    async save(task: StoredTask): Promise<void> {
      if (!task.task_id) {
        throw new Error("task_id is required");
      }

      const tasks = await readTasks(filePath);
      const index = tasks.findIndex((item) => item.task_id === task.task_id);

      if (index >= 0) {
        tasks[index] = task;
      } else {
        tasks.unshift(task);
      }

      await writeTasks(filePath, tasks);
    },

    async list(): Promise<StoredTask[]> {
      return readTasks(filePath);
    },

    async getById(taskId: string): Promise<StoredTask | undefined> {
      const tasks = await readTasks(filePath);
      return tasks.find((task) => task.task_id === taskId);
    },
  };
}

export const taskStore = createTaskStore();
