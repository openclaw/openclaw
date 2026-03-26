/** Git worktree lifecycle — create, remove, push, cleanup. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export class WorktreeManager {
	constructor(
		private readonly baseDir: string,
		private readonly repoDir: string,
	) {}

	private worktreePath(taskId: string): string {
		return join(this.baseDir, `task-${taskId}`);
	}

	private branchName(taskId: string): string {
		return `task/${taskId}`;
	}

	async create(taskId: string): Promise<string> {
		const path = this.worktreePath(taskId);
		const branch = this.branchName(taskId);
		await execFileAsync("git", ["worktree", "add", path, "-b", branch], { cwd: this.repoDir });
		return path;
	}

	async remove(taskId: string): Promise<void> {
		const path = this.worktreePath(taskId);
		const branch = this.branchName(taskId);
		await execFileAsync("git", ["worktree", "remove", path, "--force"], { cwd: this.repoDir }).catch(() => {});
		await execFileAsync("git", ["branch", "-D", branch], { cwd: this.repoDir }).catch(() => {});
	}

	async pushBranch(taskId: string): Promise<void> {
		const path = this.worktreePath(taskId);
		const branch = this.branchName(taskId);
		await execFileAsync("git", ["push", "origin", branch], { cwd: path });
	}

	async listWorktrees(): Promise<string[]> {
		try {
			const entries = await readdir(this.baseDir);
			return entries.filter((e) => e.startsWith("task-")).map((e) => e.replace("task-", ""));
		} catch {
			return [];
		}
	}

	async cleanupStale(maxAgeHours = 2): Promise<string[]> {
		const cleaned: string[] = [];
		const now = Date.now();
		const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

		const taskIds = await this.listWorktrees();
		for (const taskId of taskIds) {
			const path = this.worktreePath(taskId);
			try {
				const stats = await stat(path);
				if (now - stats.mtimeMs > maxAgeMs) {
					await this.remove(taskId);
					cleaned.push(taskId);
				}
			} catch {
				// Already gone
			}
		}
		return cleaned;
	}
}
