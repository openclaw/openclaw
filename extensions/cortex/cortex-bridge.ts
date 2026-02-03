/**
 * Cortex Bridge - TypeScript wrapper for Python Cortex memory system
 *
 * Communicates with the Python scripts in ~/.openclaw/workspace/memory/
 * to provide STM, collections, and embeddings functionality.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, access, constants } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CortexMemory {
  id: string;
  content: string;
  source: string;
  category: string | null;
  timestamp: string;
  importance: number;
  access_count: number;
  score?: number;
  recency_score?: number;
  semantic_score?: number;
}

export interface CortexSearchOptions {
  limit?: number;
  temporalWeight?: number;
  dateRange?: string | [string, string];
  category?: string;
}

export interface STMItem {
  content: string;
  timestamp: string;
  category: string;
  importance: number;
  access_count: number;
}

export class CortexBridge {
  private memoryDir: string;
  private pythonPath: string;

  constructor(options?: { memoryDir?: string; pythonPath?: string }) {
    this.memoryDir = options?.memoryDir ?? join(homedir(), ".openclaw", "workspace", "memory");
    this.pythonPath = options?.pythonPath ?? "python3";
  }

  /**
   * Check if Cortex is available (Python scripts exist)
   */
  async isAvailable(): Promise<boolean> {
    try {
      await access(join(this.memoryDir, "stm_manager.py"), constants.R_OK);
      await access(join(this.memoryDir, "embeddings_manager.py"), constants.R_OK);
      await access(join(this.memoryDir, "collections_manager.py"), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a Python script and return JSON result
   */
  private async runPython(code: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonPath, ["-c", code], {
        cwd: this.memoryDir,
        env: { ...process.env, PYTHONPATH: this.memoryDir },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Python error: ${stderr || "Unknown error"}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(stdout.trim());
        }
      });

      proc.on("error", reject);
    });
  }

  /**
   * Add to short-term memory
   */
  async addToSTM(content: string, category?: string, importance: number = 1.0): Promise<STMItem> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.memoryDir}')
from stm_manager import add_to_stm
result = add_to_stm(${JSON.stringify(content)}, category=${category ? JSON.stringify(category) : "None"}, importance=${importance})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as STMItem;
  }

  /**
   * Get recent items from STM
   */
  async getRecentSTM(limit: number = 10, category?: string): Promise<STMItem[]> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.memoryDir}')
from stm_manager import get_recent
result = get_recent(limit=${limit}, category=${category ? JSON.stringify(category) : "None"})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as STMItem[];
  }

  /**
   * Search memories with temporal weighting
   */
  async searchMemories(query: string, options: CortexSearchOptions = {}): Promise<CortexMemory[]> {
    const { limit = 10, temporalWeight = 0.7, dateRange, category } = options;

    let dateRangeArg = "None";
    if (typeof dateRange === "string") {
      dateRangeArg = JSON.stringify(dateRange);
    } else if (Array.isArray(dateRange)) {
      dateRangeArg = JSON.stringify(dateRange);
    }

    const code = `
import json
import sys
sys.path.insert(0, '${this.memoryDir}')
from embeddings_manager import search_memories, init_db
init_db()
result = search_memories(
    ${JSON.stringify(query)},
    limit=${limit},
    temporal_weight=${temporalWeight},
    date_range=${dateRangeArg},
    category=${category ? JSON.stringify(category) : "None"}
)
print(json.dumps(result))
`;
    return (await this.runPython(code)) as CortexMemory[];
  }

  /**
   * Add memory to embeddings database
   */
  async addMemory(
    content: string,
    options: {
      source?: string;
      category?: string;
      importance?: number;
    } = {},
  ): Promise<string> {
    const { source = "agent", category, importance = 1.0 } = options;

    const code = `
import json
import sys
sys.path.insert(0, '${this.memoryDir}')
from embeddings_manager import add_memory, init_db
init_db()
result = add_memory(
    ${JSON.stringify(content)},
    source=${JSON.stringify(source)},
    category=${category ? JSON.stringify(category) : "None"},
    importance=${importance}
)
print(json.dumps(result))
`;
    return (await this.runPython(code)) as string;
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<{ total: number; by_category: Record<string, number>; by_source: Record<string, number> }> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.memoryDir}')
from embeddings_manager import stats, init_db
init_db()
result = stats()
print(json.dumps(result))
`;
    return (await this.runPython(code)) as { total: number; by_category: Record<string, number>; by_source: Record<string, number> };
  }

  /**
   * Sync STM and collections to embeddings database
   */
  async syncAll(): Promise<{ stm: number; collections: number }> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.memoryDir}')
from embeddings_manager import sync_from_stm, sync_from_collections, init_db
init_db()
stm_count = sync_from_stm()
col_count = sync_from_collections()
print(json.dumps({"stm": stm_count, "collections": col_count}))
`;
    return (await this.runPython(code)) as { stm: number; collections: number };
  }

  /**
   * Run maintenance (cleanup expired STM, sync to embeddings)
   */
  async runMaintenance(mode: "nightly" | "weekly" = "nightly"): Promise<string> {
    const code = `
import sys
sys.path.insert(0, '${this.memoryDir}')
from maintenance import main
result = main(["${mode}"])
print(result or "OK")
`;
    return (await this.runPython(code)) as string;
  }

  /**
   * Load STM directly from JSON file
   */
  async loadSTMDirect(): Promise<{ short_term_memory: STMItem[]; capacity: number; auto_expire_days: number }> {
    const stmPath = join(this.memoryDir, "stm.json");
    try {
      const data = await readFile(stmPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return { short_term_memory: [], capacity: 20, auto_expire_days: 7 };
    }
  }
}

export const defaultBridge = new CortexBridge();
