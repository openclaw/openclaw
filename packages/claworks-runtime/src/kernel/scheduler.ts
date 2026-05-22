import { Cron } from "croner";
import type { PlaybookDefinition } from "../planes/orch/playbook-types.js";

export type PlaybookScheduler = {
  /** 从加载好的 Playbook 列表中重新构建所有定时任务 */
  reload(playbooks: PlaybookDefinition[]): void;
  /** 动态添加一条定时规则（不影响已有任务） */
  add(playbook: PlaybookDefinition): void;
  /** 停止所有定时任务 */
  stop(): void;
};

export function createPlaybookScheduler(opts: {
  onFire: (playbookId: string) => void | Promise<void>;
  logger?: (msg: string) => void;
  timezone?: string;
}): PlaybookScheduler {
  const jobs: Cron[] = [];

  const stop = () => {
    for (const job of jobs) {
      job.stop();
    }
    jobs.length = 0;
  };

  const reload = (playbooks: PlaybookDefinition[]) => {
    stop();
    const defaultTz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const playbook of playbooks) {
      if (playbook.trigger.kind !== "schedule") {
        continue;
      }
      const { cron, timezone } = playbook.trigger;
      try {
        const job = new Cron(
          cron,
          {
            timezone: timezone ?? defaultTz,
            catch: false,
            protect: true,
            name: `claworks:${playbook.id}`,
          },
          () => {
            opts.logger?.(`[claworks:scheduler] firing playbook=${playbook.id}`);
            void Promise.resolve(opts.onFire(playbook.id)).catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              opts.logger?.(`[claworks:scheduler] playbook=${playbook.id} failed: ${message}`);
            });
          },
        );
        jobs.push(job);
        opts.logger?.(`[claworks:scheduler] registered playbook=${playbook.id} cron=${cron}`);
      } catch (err) {
        opts.logger?.(
          `[claworks:scheduler] invalid cron for ${playbook.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  const add = (playbook: PlaybookDefinition) => {
    if (playbook.trigger.kind !== "schedule") {
      return;
    }
    const { cron, timezone } = playbook.trigger;
    const defaultTz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const job = new Cron(
        cron,
        {
          timezone: timezone ?? defaultTz,
          catch: false,
          protect: true,
          name: `claworks:${playbook.id}`,
        },
        () => {
          opts.logger?.(`[claworks:scheduler] firing playbook=${playbook.id}`);
          void Promise.resolve(opts.onFire(playbook.id)).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            opts.logger?.(`[claworks:scheduler] playbook=${playbook.id} failed: ${message}`);
          });
        },
      );
      jobs.push(job);
      opts.logger?.(`[claworks:scheduler] added playbook=${playbook.id} cron=${cron}`);
    } catch (err) {
      opts.logger?.(
        `[claworks:scheduler] invalid cron for ${playbook.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return { reload, add, stop };
}
