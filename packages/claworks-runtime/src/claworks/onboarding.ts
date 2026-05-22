/**
 * onboarding.ts — ClaWorks 开箱即用自动配置（Self-Onboarding）
 *
 * 在机器人首次启动时，自动完成：
 * 1. 自检（health.check）
 * 2. 身份初始化
 * 3. 能力盘点（发布 system.onboarding_started）
 * 4. KB 预热（摄入能力清单）
 * 5. 默认 Hook 注册
 * 6. 向主人发送开箱问候
 * 7. 标记就绪（发布 system.ready）
 */

import type { ClaworksRuntime } from "./runtime-types.js";

export type OnboardingStatus = "fresh" | "configuring" | "ready" | "degraded";

export type OnboardingState = {
  status: OnboardingStatus;
  completedSteps: string[];
  startedAt: Date;
  completedAt?: Date;
  ownerId?: string;
};

export type OnboardingManager = {
  getState(): OnboardingState;
  isFirstRun(): boolean;
  markStepComplete(step: string): void;
  startOnboarding(runtime: ClaworksRuntime): Promise<void>;
};

export function createOnboardingManager(): OnboardingManager {
  const state: OnboardingState = {
    status: "fresh",
    completedSteps: [],
    startedAt: new Date(),
  };

  let _firstRunChecked = false;
  let _isFirstRun = true;

  return {
    getState() {
      return { ...state };
    },

    isFirstRun() {
      if (!_firstRunChecked) {
        _firstRunChecked = true;
        // 通过环境变量快速检查是否跳过（适用于测试）
        if (process.env.CLAWORKS_SKIP_ONBOARDING === "1") {
          _isFirstRun = false;
        }
      }
      return _isFirstRun;
    },

    markStepComplete(step) {
      if (!state.completedSteps.includes(step)) {
        state.completedSteps.push(step);
      }
    },

    async startOnboarding(runtime) {
      state.status = "configuring";
      const logger = runtime.logger;

      logger?.("[claworks:onboarding] 开始首次启动配置...");

      // ── Step 1: 自检 ──────────────────────────────────────────────────────
      try {
        logger?.("[claworks:onboarding] Step 1: 运行系统自检...");
        await runtime.capabilities.invoke(
          "health.check",
          { source: "onboarding", userId: "system", invoke: async () => ({}) },
          {},
        );
        this.markStepComplete("health_check");
        logger?.("[claworks:onboarding] ✅ Step 1: 自检完成");
      } catch (err) {
        logger?.(
          `[claworks:onboarding] ⚠️ Step 1: 自检失败（非致命）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // ── Step 2: 身份初始化 ────────────────────────────────────────────────
      try {
        logger?.("[claworks:onboarding] Step 2: 初始化身份...");
        const cfg = runtime.config.robot ?? {};
        const idMgr = (
          runtime as unknown as {
            robotIdentityManager?: { updateIdentity: (p: Record<string, unknown>) => void };
          }
        ).robotIdentityManager;
        if (idMgr && cfg.name) {
          idMgr.updateIdentity({
            name: cfg.name,
            role: cfg.role ?? runtime.robot.role,
            organization: cfg.organization ?? "",
            domain: cfg.domain ?? "",
          });
        }
        this.markStepComplete("identity_init");
        logger?.(`[claworks:onboarding] ✅ Step 2: 身份初始化完成 (name=${runtime.robot.name})`);
      } catch (err) {
        logger?.(
          `[claworks:onboarding] ⚠️ Step 2: 身份初始化失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // ── Step 3: 能力盘点 ──────────────────────────────────────────────────
      try {
        const capCount = runtime.capabilities.list().length;
        const packCount = runtime.loadedPacks.length;
        const playbookCount = runtime.playbookEngine.list().length;

        await runtime.kernel.publish("system.onboarding_started", "onboarding", {
          capabilities: capCount,
          packs: packCount,
          playbooks: playbookCount,
          robot_name: runtime.robot.name,
          started_at: state.startedAt.toISOString(),
        });
        this.markStepComplete("capability_inventory");
        logger?.(
          `[claworks:onboarding] ✅ Step 3: 能力盘点完成 (caps=${capCount}, packs=${packCount}, playbooks=${playbookCount})`,
        );
      } catch (err) {
        logger?.(
          `[claworks:onboarding] ⚠️ Step 3: 能力盘点失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // ── Step 4: KB 预热 ───────────────────────────────────────────────────
      try {
        logger?.("[claworks:onboarding] Step 4: 预热知识库...");
        const caps = runtime.capabilities.list();
        const capsSummary = caps.map((c) => `- ${c.id}: ${c.description}`).join("\n");
        const docContent = `# ClaWorks 能力清单\n\n## 机器人信息\n- 名称：${runtime.robot.name}\n- 版本：${runtime.robot.version}\n\n## 已注册能力（共 ${caps.length} 个）\n\n${capsSummary}\n\n## 已加载 Pack（共 ${runtime.loadedPacks.length} 个）\n${runtime.loadedPacks.map((p) => `- ${p.manifest.id}`).join("\n")}`;

        await runtime.kb.ingest(docContent, {
          source: "system:onboarding",
          namespace: "system-capabilities",
        });
        this.markStepComplete("kb_warmup");
        logger?.("[claworks:onboarding] ✅ Step 4: KB 预热完成");
      } catch (err) {
        logger?.(
          `[claworks:onboarding] ⚠️ Step 4: KB 预热失败（非致命）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // ── Step 4.5: 环境扫描 + Harness 检测 ───────────────────────────────────
      try {
        logger?.("[claworks:onboarding] Step 4.5: 环境扫描与服务检测...");

        // 触发环境发现 Playbook（通过事件，非阻塞）
        // system.onboarding_started 事件已在 Step 3 发布，会触发 environment_discovery Playbook
        // 这里再做一次 harness 检测并摄入到 KB
        const harnessResult = await runtime.capabilities
          .invoke(
            "harness.detect_openclaw",
            { source: "onboarding", userId: "system", invoke: async () => ({}) },
            {},
          )
          .catch(() => null);

        if (harnessResult && (harnessResult as { found?: boolean }).found) {
          logger?.("[claworks:onboarding] ✅ 检测到 OpenClaw 安装，触发配置同步...");
          await runtime.capabilities
            .invoke(
              "harness.sync_from_openclaw",
              { source: "onboarding", userId: "system", invoke: async () => ({}) },
              {},
            )
            .catch(() => null);
        }

        this.markStepComplete("environment_scan");
        logger?.("[claworks:onboarding] ✅ Step 4.5: 环境扫描完成");
      } catch (err) {
        logger?.(
          `[claworks:onboarding] ⚠️ Step 4.5: 环境扫描失败（非致命）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // ── Step 5: 默认 Hook 注册 ────────────────────────────────────────────
      try {
        if (runtime.config.robot?.proactive !== false) {
          logger?.("[claworks:onboarding] Step 5: 注册默认报警 Hook...");
          const existingHooks = runtime.hookEngine?.list() ?? [];
          const hasAlarmHook = existingHooks.some((h) => h.id === "default-alarm-notify");
          if (!hasAlarmHook) {
            runtime.hookEngine?.register({
              name: "默认报警通知",
              trigger: { eventPattern: "alarm.*" },
              action: {
                kind: "playbook",
                playbookId: "alarm_notify",
                template: "⚠️ 报警事件: {{ event.payload.alarm_id }}",
              },
              enabled: true,
            });
          }
          this.markStepComplete("default_hooks");
          logger?.("[claworks:onboarding] ✅ Step 5: 默认 Hook 注册完成");
        }
      } catch (err) {
        logger?.(
          `[claworks:onboarding] ⚠️ Step 5: Hook 注册失败（非致命）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // ── Step 6: 向主人发送开箱问候 ────────────────────────────────────────
      const ownerUserId = runtime.config.robot?.owner_user_id;
      if (ownerUserId) {
        state.ownerId = ownerUserId;
        try {
          logger?.(`[claworks:onboarding] Step 6: 向主人 ${ownerUserId} 发送开箱问候...`);
          const greetCard = buildWelcomeCard(runtime);

          await runtime.kernel.publish("notification.send_requested", "onboarding", {
            subject_type: "user",
            subject_id: ownerUserId,
            priority: "normal",
            message: greetCard.text,
            card_template: "system_welcome",
            card_data: greetCard.data,
          });
          this.markStepComplete("owner_greeting");
          logger?.("[claworks:onboarding] ✅ Step 6: 开箱问候已发送");
        } catch (err) {
          logger?.(
            `[claworks:onboarding] ⚠️ Step 6: 发送问候失败（非致命）: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        logger?.("[claworks:onboarding] ℹ️ Step 6: 未配置 robot.owner_user_id，跳过开箱问候");
        this.markStepComplete("owner_greeting_skipped");
      }

      // ── Step 7: 标记就绪 ──────────────────────────────────────────────────
      state.status = "ready";
      state.completedAt = new Date();
      _isFirstRun = false;

      await runtime.kernel.publish("system.ready", "onboarding", {
        robot_name: runtime.robot.name,
        steps_completed: state.completedSteps,
        elapsed_ms: state.completedAt.getTime() - state.startedAt.getTime(),
        capabilities: runtime.capabilities.list().length,
        packs: runtime.loadedPacks.length,
        playbooks: runtime.playbookEngine.list().length,
      });

      logger?.(`[claworks:onboarding] 🎉 开箱配置完成！步骤: ${state.completedSteps.join(", ")}`);
    },
  };
}

// ── 开箱问候卡片构建 ──────────────────────────────────────────────────────────

function buildWelcomeCard(runtime: ClaworksRuntime): {
  text: string;
  data: Record<string, unknown>;
} {
  const name = runtime.robot.name;
  const role = runtime.robot.role;
  const capCount = runtime.capabilities.list().length;
  const packCount = runtime.loadedPacks.length;
  const playbookCount = runtime.playbookEngine.list().length;

  const text = `🤖 **ClaWorks 已就绪！**

我是 **${name}**，您的 ${role}。

✅ 系统状态：正常
📦 已加载 Pack：${packCount} 个
🧠 已注册能力：${capCount} 个
📋 已加载 Playbook：${playbookCount} 个

我可以帮您：
• 监控设备状态和处理报警
• 管理工单和维护计划
• 知识库查询和学习
• 审批流程自动化

发送 **"你是谁"** 或 **"帮助"** 开始使用。`;

  return {
    text,
    data: {
      robot_name: name,
      robot_role: role,
      status: "ok",
      pack_count: packCount,
      capability_count: capCount,
      playbook_count: playbookCount,
      version: runtime.robot.version,
    },
  };
}

/**
 * 从 DB 检查 onboarding 是否已完成（防止重复执行）。
 */
export function checkOnboardingCompleted(db: {
  prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
}): boolean {
  try {
    const row = db
      .prepare("SELECT data FROM cw_robot_identity WHERE id = ?")
      .get("onboarding_state") as { data: string } | undefined;
    if (!row) {
      return false;
    }
    const parsed = JSON.parse(row.data) as { status?: string };
    return parsed.status === "ready";
  } catch {
    return false;
  }
}

/**
 * 将 onboarding 状态持久化到 DB。
 */
export function persistOnboardingState(
  db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } },
  state: OnboardingState,
): void {
  try {
    db.prepare(
      "INSERT OR REPLACE INTO cw_robot_identity (id, data, updated_at) VALUES (?, ?, ?)",
    ).run("onboarding_state", JSON.stringify(state), Date.now());
  } catch {
    // 表不存在时静默忽略
  }
}
