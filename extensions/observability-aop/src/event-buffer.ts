/**
 * Batched event buffer — accumulates events and flushes to AOP Server.
 *
 * Replaces the fork's event shipper daemon with in-process batching.
 */

export interface AopEvent {
	timestamp: string;
	event_type: string;
	source_node: string;
	channel_id?: string;
	session_key?: string;
	session_id?: string;
	agent_id?: string;
	workspace_dir?: string;
	trigger?: string;
	parent_session_id?: string;
	duration_ms?: number;
	tokens_input?: number;
	tokens_output?: number;
	tokens_cache_read?: number;
	tokens_cache_write?: number;
	cost_usd?: number;
	model?: string;
	provider?: string;
	success?: boolean;
	error?: string;
	archon_task_id?: string;
	archon_project_id?: string;
	payload?: Record<string, unknown>;
	tags?: string[];
}

export class EventBuffer {
	private buffer: AopEvent[] = [];
	private flushTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly aopUrl: string,
		private readonly batchSize: number,
		private readonly flushIntervalMs: number,
		private readonly logger: { warn: (msg: string) => void },
	) {
		this.flushTimer = setInterval(() => this.flush(), flushIntervalMs);
		if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
			(this.flushTimer as NodeJS.Timeout).unref();
		}
	}

	push(event: AopEvent): void {
		this.buffer.push(event);
		if (this.buffer.length >= this.batchSize) {
			this.flush();
		}
	}

	async flush(): Promise<void> {
		if (this.buffer.length === 0) return;

		const batch = this.buffer.splice(0, this.buffer.length);
		try {
			const resp = await fetch(`${this.aopUrl}/events/batch`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ events: batch }),
				signal: AbortSignal.timeout(10000),
			});
			if (!resp.ok) {
				this.logger.warn(`AOP batch ingestion failed: ${resp.status}`);
				// Re-queue failed events (up to a limit to prevent unbounded growth)
				if (this.buffer.length < 1000) {
					this.buffer.unshift(...batch);
				}
			}
		} catch (err) {
			this.logger.warn(`AOP batch send error: ${err}`);
			if (this.buffer.length < 1000) {
				this.buffer.unshift(...batch);
			}
		}
	}

	async stop(): Promise<void> {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		await this.flush();
	}
}
