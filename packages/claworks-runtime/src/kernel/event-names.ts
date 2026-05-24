/**
 * ClaWorks 标准事件名常量
 *
 * 所有 kernel.publish / subscribe / Playbook trigger.pattern 应使用这些常量，
 * 避免事件名拼写错误导致的静默 bug。
 *
 * 命名约定：
 *   CW_EVENTS.*  → 由 ClaWorks kernel/planes 发布的内部事件
 *   外部 IM 消息、报警等由各 bridge/plugin 注入，在适配层使用对应常量。
 */
export const CW_EVENTS = {
  // ── 系统生命周期 ──────────────────────────────────────────────────────
  SYSTEM_STARTUP: "system.startup",
  SYSTEM_STARTUP_WARNINGS: "system.startup_warnings",
  SYSTEM_READY: "system.ready",
  SYSTEM_RUNTIME_STARTED: "system.runtime.started",
  SYSTEM_RUNTIME_STOPPED: "system.runtime.stopped",
  SYSTEM_PACKS_RELOADED: "system.packs_reloaded",
  SYSTEM_ONBOARDING_STARTED: "system.onboarding_started",
  SYSTEM_ANOMALY: "system.anomaly",
  SYSTEM_SCHEDULE_FIRED: "system.schedule.fired",

  // ── IM / 消息 ─────────────────────────────────────────────────────────
  /** im-bridge 收到用户 IM 消息后发布 */
  IM_MESSAGE_RECEIVED: "im.message.received",

  // ── Intent / 意图 ─────────────────────────────────────────────────────
  INTENT_CLASSIFIED: "intent.classified",
  INTENT_LOW_CONFIDENCE: "intent.low_confidence",

  // ── Playbook ──────────────────────────────────────────────────────────
  PLAYBOOK_STARTED: "playbook.started",
  PLAYBOOK_COMPLETED: "playbook.completed",
  PLAYBOOK_FAILED: "playbook.failed",
  PLAYBOOK_STEP_SLOW: "playbook.step_slow",
  /** 内部：playbook 运行完成（evolve-engine 订阅） */
  PLAYBOOK_RUN_COMPLETED: "playbook.run.completed",
  /** 内部：playbook 运行失败（evolve-engine 订阅） */
  PLAYBOOK_RUN_FAILED: "playbook.run.failed",
  PLAYBOOK_TRIGGER: "playbook.trigger",

  // ── Alarm / 报警 ──────────────────────────────────────────────────────
  /** 外部系统（domain-operations、业务 pack 等）发布新报警记录时使用。 */
  ALARM_CREATED: "alarm.created",
  /** 保留：语义同 ALARM_CREATED，供已有代码向后兼容。 */
  ALARM_TRIGGERED: "alarm.triggered",
  ALARM_ACKNOWLEDGED: "alarm.acknowledged",
  ALARM_RESOLVED: "alarm.resolved",

  // ── Work Order / 工单 ────────────────────────────────────────────────
  WORK_ORDER_CREATED: "work_order.created",
  WORK_ORDER_STATUS_CHANGED: "work_order.status_changed",
  WORK_ORDER_CLOSED: "work_order.closed",

  // ── Task ─────────────────────────────────────────────────────────────
  TASK_CREATED: "task.created",
  TASK_COMPLETED: "task.completed",
  TASK_STATUS_CHANGED: "task.status_changed",
  TASK_ASSIGNED: "task.assigned",
  TASK_CANCELLED: "task.cancelled",

  // ── Approval / HITL ──────────────────────────────────────────────────
  APPROVAL_CREATED: "approval.created",
  APPROVAL_APPROVED: "approval.approved",
  APPROVAL_REJECTED: "approval.rejected",
  APPROVAL_HITL_REQUESTED: "approval.hitl_requested",
  HITL_APPROVAL_REQUESTED: "hitl.approval_requested",

  // ── Agent / 代理任务 ─────────────────────────────────────────────────
  AGENT_TASK_COMPLETED: "agent.task_completed",
  AGENT_TASK_FAILED: "agent.task_failed",
  A2A_DELEGATE_STARTED: "a2a.delegate_started",

  // ── Evolution / 进化同步 ──────────────────────────────────────────────
  EVOLUTION_PACK_IMPORTED: "evolution.pack_imported",
  /** 请求运行模拟蒸馏流水线（弱模型回归 + 导出） */
  EVOLUTION_SIMULATION_REQUESTED: "evolution.simulation_requested",
  /** 请求弱模型意图回归测试（import 后自动触发） */
  EVOLUTION_REGRESSION_REQUESTED: "evolution.regression_requested",
  /** 沙盒导入完成（未晋升生产） */
  EVOLUTION_SANDBOX_IMPORTED: "evolution.sandbox_imported",
  /** 沙盒回归通过，等待 HITL 晋升生产 */
  EVOLUTION_SANDBOX_READY_FOR_PROMOTION: "evolution.sandbox_ready_for_promotion",
  EVOLVE_PLAYBOOK_DEPLOYED: "evolve.playbook_deployed",
  EVOLVE_PLAYBOOK_DRAFTED: "evolve.playbook_drafted",
  EVOLVE_SUGGESTIONS_READY: "evolve.suggestions_ready",

  // ── Capability / 能力反馈 ─────────────────────────────────────────────
  CAPABILITY_FEEDBACK_RECEIVED: "capability.feedback_received",

  // ── Learn / 学习 ─────────────────────────────────────────────────────
  LEARN_FEEDBACK_RECORDED: "learn.feedback_recorded",
  LEARN_OBSERVATION_RECORDED: "learn.observation_recorded",
  LEARN_INTERFACE_REQUESTED: "learn.interface.requested",

  // ── Pack ─────────────────────────────────────────────────────────────
  PACK_INSTALLED: "pack.installed",
  PACK_LOADED: "pack.loaded",
  PACK_LOAD_PROFILE_REQUESTED: "pack.load_profile_requested",
  PACK_PROFILE_LOADED: "pack.profile_loaded",
  PACK_PROFILE_LOAD_FAILED: "pack.profile_load_failed",

  // ── Comms / 通讯 ─────────────────────────────────────────────────────
  COMMS_BROADCAST_SENT: "comms.broadcast_sent",
  COMMS_STREAM_STARTED: "comms.stream_started",
  COMMS_STREAM_COMPLETED: "comms.stream_completed",
  COMMS_STREAM_FAILED: "comms.stream_failed",
  NOTIFICATION_SEND_REQUESTED: "notification.send_requested",

  // ── Monitor / Research ───────────────────────────────────────────────
  MONITOR_WATCH_REGISTERED: "monitor.watch_registered",
  RESEARCH_MONITOR_UPDATE: "research.monitor_update",

  // ── Connector / Connect ───────────────────────────────────────────────
  CONNECT_APPLIED: "connect.applied",
  CONNECT_APPLY_REQUESTED: "connect.apply_requested",
  CONNECTOR_INVOKE_STARTED: "connector.invoke_started",

  // ── Environment ──────────────────────────────────────────────────────
  ENVIRONMENT_SCAN_COMPLETED: "environment.scan_completed",

  // ── Scheduler ────────────────────────────────────────────────────────
  SCHEDULE_JOB_REGISTERED: "schedule.job_registered",

  // ── RBAC ──────────────────────────────────────────────────────────────
  RBAC_DENIED: "rbac.denied",

  // ── Swarm ─────────────────────────────────────────────────────────────
  SWARM_ANNOUNCED: "swarm.announced",
  SWARM_PEER_DISCOVERED: "swarm.peer_discovered",
  SWARM_PEER_LOST: "swarm.peer_lost",
  SWARM_SYNC_COMPLETED: "swarm.sync_completed",

  // ── Report ────────────────────────────────────────────────────────────
  REPORT_GENERATED: "report.generated",

  // ── Harness ───────────────────────────────────────────────────────────
  HARNESS_SYNC_COMPLETED: "harness.sync_completed",

  // ── User ──────────────────────────────────────────────────────────────
  USER_FIRST_INTERACTION: "user.first_interaction",

  // ── Robot 自主巡逻 ────────────────────────────────────────────────────
  /**
   * 机器人自主巡逻心跳（周期性自动触发，默认每 5 分钟一次）。
   *
   * Pack 可以注册 trigger.event = "robot.patrol" 的 Playbook 来实现：
   *   - 检查未处理的告警/工单
   *   - 发送定期报告
   *   - 监控系统状态
   *   - 主动推送关键通知
   *
   * 这是机器人"自主性"的核心机制：不依赖外部触发，主动感知业务状态。
   */
  ROBOT_PATROL: "robot.patrol",
} as const;

export type CwEventType = (typeof CW_EVENTS)[keyof typeof CW_EVENTS];
