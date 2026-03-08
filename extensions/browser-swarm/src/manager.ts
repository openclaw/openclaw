import { NoopCaptchaAdapter, type CaptchaAdapter } from "./captcha-adapter.js";
import { BrowserDomainLimiter } from "./rate-limits.js";
import { BrowserTaskScheduler, type BrowserTask } from "./scheduler.js";
import { BrowserSessionManager } from "./session-manager.js";
import { BrowserWorkerRegistry, type BrowserWorkerLease } from "./worker-node-client.js";

export type BrowserSwarmManagerConfig = {
  leaseMs: number;
  maxConcurrentPerDomain: number;
  minDomainIntervalMs: number;
};

export class BrowserSwarmManager {
  readonly workers: BrowserWorkerRegistry;
  readonly sessions: BrowserSessionManager;
  readonly scheduler: BrowserTaskScheduler;
  readonly limiter: BrowserDomainLimiter;
  readonly captcha: CaptchaAdapter;
  private readonly leases = new Map<string, BrowserWorkerLease>();

  constructor(
    private readonly config: BrowserSwarmManagerConfig,
    deps?: {
      now?: () => number;
      captcha?: CaptchaAdapter;
    },
  ) {
    const now = deps?.now ?? (() => Date.now());
    this.workers = new BrowserWorkerRegistry(now);
    this.sessions = new BrowserSessionManager(now);
    this.scheduler = new BrowserTaskScheduler();
    this.limiter = new BrowserDomainLimiter(
      {
        maxConcurrentPerDomain: config.maxConcurrentPerDomain,
        minIntervalMs: config.minDomainIntervalMs,
      },
      now,
    );
    this.captcha = deps?.captcha ?? new NoopCaptchaAdapter();
  }

  enqueue(task: BrowserTask): void {
    this.scheduler.enqueue(task);
  }

  leaseNext(workerId: string): BrowserTask | null {
    const task = this.scheduler.dequeueNext();
    if (!task) {
      return null;
    }
    const limit = this.limiter.canStart(task.domain);
    if (!limit.ok) {
      this.scheduler.enqueue(task);
      return null;
    }
    this.limiter.start(task.domain);
    this.leases.set(task.id, {
      taskId: task.id,
      workerId,
      leasedAt: Date.now(),
      leaseExpiresAt: Date.now() + this.config.leaseMs,
    });
    return task;
  }

  complete(taskId: string, domain: string): void {
    this.leases.delete(taskId);
    this.limiter.finish(domain);
  }

  fail(taskId: string, domain: string, requeueTask?: BrowserTask): void {
    this.leases.delete(taskId);
    this.limiter.finish(domain);
    if (requeueTask) {
      this.scheduler.enqueue(requeueTask);
    }
  }

  activeLeases(): BrowserWorkerLease[] {
    return [...this.leases.values()].map((v) => ({ ...v }));
  }
}

