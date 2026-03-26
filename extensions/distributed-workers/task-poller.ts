/** Task poller — polls Archon API for pending tasks. */

import type { Task, TaskBackend, WorkerConfig } from "./types.js";

export class ArchonTaskBackend implements TaskBackend {
	constructor(
		private readonly archonUrl: string,
		private readonly projectId: string,
	) {}

	async fetchPendingTasks(nodeName: string): Promise<Task[]> {
		try {
			const resp = await fetch(`${this.archonUrl}/api/tasks?status=todo&project_id=${this.projectId}`);
			if (!resp.ok) return [];

			const data = (await resp.json()) as { tasks?: Task[] };
			const tasks = data.tasks || [];

			// Filter: tasks targeted at this node or "any"
			return tasks.filter((t) => {
				const target = t.metadata?.target_node;
				return !target || target === nodeName || target === "any";
			});
		} catch {
			return [];
		}
	}

	async updateTaskStatus(taskId: string, status: Task["status"], metadata?: Record<string, string>): Promise<void> {
		await fetch(`${this.archonUrl}/api/tasks/${taskId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status, metadata }),
		}).catch(() => {});
	}
}

export class TaskPoller {
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor(
		private readonly backend: TaskBackend,
		private readonly nodeName: string,
		private readonly pollIntervalMs: number,
		private readonly onTaskFound: (task: Task) => Promise<void>,
	) {}

	start(): void {
		if (this.running) return;
		this.running = true;

		// Immediate first poll
		this.poll();

		this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
		if (this.pollTimer && typeof this.pollTimer === "object" && "unref" in this.pollTimer) {
			(this.pollTimer as NodeJS.Timeout).unref();
		}
	}

	stop(): void {
		this.running = false;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	private async poll(): Promise<void> {
		if (!this.running) return;

		try {
			const tasks = await this.backend.fetchPendingTasks(this.nodeName);
			for (const task of tasks) {
				if (!this.running) break;
				await this.onTaskFound(task);
			}
		} catch {
			// Poll failure is non-fatal; retry on next interval
		}
	}
}
