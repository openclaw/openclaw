//#region src/kernel/event-names.d.ts
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
declare const CW_EVENTS: {
  readonly SYSTEM_STARTUP: "system.startup";
  readonly SYSTEM_STARTUP_WARNINGS: "system.startup_warnings";
  readonly SYSTEM_READY: "system.ready";
  readonly SYSTEM_RUNTIME_STARTED: "system.runtime.started";
  readonly SYSTEM_RUNTIME_STOPPED: "system.runtime.stopped";
  readonly SYSTEM_PACKS_RELOADED: "system.packs_reloaded";
  readonly SYSTEM_ONBOARDING_STARTED: "system.onboarding_started";
  readonly SYSTEM_ANOMALY: "system.anomaly";
  readonly SYSTEM_SCHEDULE_FIRED: "system.schedule.fired"; /** im-bridge 收到用户 IM 消息后发布 */
  readonly IM_MESSAGE_RECEIVED: "im.message.received";
  readonly INTENT_CLASSIFIED: "intent.classified";
  readonly INTENT_LOW_CONFIDENCE: "intent.low_confidence";
  readonly PLAYBOOK_STARTED: "playbook.started";
  readonly PLAYBOOK_COMPLETED: "playbook.completed";
  readonly PLAYBOOK_FAILED: "playbook.failed";
  readonly PLAYBOOK_STEP_SLOW: "playbook.step_slow"; /** 内部：playbook 运行完成（evolve-engine 订阅） */
  readonly PLAYBOOK_RUN_COMPLETED: "playbook.run.completed"; /** 内部：playbook 运行失败（evolve-engine 订阅） */
  readonly PLAYBOOK_RUN_FAILED: "playbook.run.failed";
  readonly PLAYBOOK_TRIGGER: "playbook.trigger"; /** 外部系统（domain-operations、业务 pack 等）发布新报警记录时使用。 */
  readonly ALARM_CREATED: "alarm.created"; /** 保留：语义同 ALARM_CREATED，供已有代码向后兼容。 */
  readonly ALARM_TRIGGERED: "alarm.triggered";
  readonly ALARM_ACKNOWLEDGED: "alarm.acknowledged";
  readonly ALARM_RESOLVED: "alarm.resolved";
  readonly WORK_ORDER_CREATED: "work_order.created";
  readonly WORK_ORDER_STATUS_CHANGED: "work_order.status_changed";
  readonly WORK_ORDER_CLOSED: "work_order.closed";
  readonly TASK_CREATED: "task.created";
  readonly TASK_COMPLETED: "task.completed";
  readonly TASK_STATUS_CHANGED: "task.status_changed";
  readonly TASK_ASSIGNED: "task.assigned";
  readonly TASK_CANCELLED: "task.cancelled";
  readonly APPROVAL_CREATED: "approval.created";
  readonly APPROVAL_APPROVED: "approval.approved";
  readonly APPROVAL_REJECTED: "approval.rejected";
  readonly APPROVAL_HITL_REQUESTED: "approval.hitl_requested";
  readonly HITL_APPROVAL_REQUESTED: "hitl.approval_requested";
  readonly AGENT_TASK_COMPLETED: "agent.task_completed";
  readonly AGENT_TASK_FAILED: "agent.task_failed";
  readonly A2A_DELEGATE_STARTED: "a2a.delegate_started";
  readonly EVOLUTION_PACK_IMPORTED: "evolution.pack_imported";
  readonly EVOLVE_PLAYBOOK_DEPLOYED: "evolve.playbook_deployed";
  readonly EVOLVE_PLAYBOOK_DRAFTED: "evolve.playbook_drafted";
  readonly EVOLVE_SUGGESTIONS_READY: "evolve.suggestions_ready";
  readonly CAPABILITY_FEEDBACK_RECEIVED: "capability.feedback_received";
  readonly LEARN_FEEDBACK_RECORDED: "learn.feedback_recorded";
  readonly LEARN_OBSERVATION_RECORDED: "learn.observation_recorded";
  readonly LEARN_INTERFACE_REQUESTED: "learn.interface.requested";
  readonly PACK_INSTALLED: "pack.installed";
  readonly PACK_LOADED: "pack.loaded";
  readonly COMMS_BROADCAST_SENT: "comms.broadcast_sent";
  readonly COMMS_STREAM_STARTED: "comms.stream_started";
  readonly COMMS_STREAM_COMPLETED: "comms.stream_completed";
  readonly COMMS_STREAM_FAILED: "comms.stream_failed";
  readonly NOTIFICATION_SEND_REQUESTED: "notification.send_requested";
  readonly MONITOR_WATCH_REGISTERED: "monitor.watch_registered";
  readonly RESEARCH_MONITOR_UPDATE: "research.monitor_update";
  readonly CONNECT_APPLIED: "connect.applied";
  readonly CONNECT_APPLY_REQUESTED: "connect.apply_requested";
  readonly CONNECTOR_INVOKE_STARTED: "connector.invoke_started";
  readonly ENVIRONMENT_SCAN_COMPLETED: "environment.scan_completed";
  readonly SCHEDULE_JOB_REGISTERED: "schedule.job_registered";
  readonly RBAC_DENIED: "rbac.denied";
  readonly SWARM_ANNOUNCED: "swarm.announced";
  readonly SWARM_PEER_DISCOVERED: "swarm.peer_discovered";
  readonly SWARM_PEER_LOST: "swarm.peer_lost";
  readonly SWARM_SYNC_COMPLETED: "swarm.sync_completed";
  readonly REPORT_GENERATED: "report.generated";
  readonly HARNESS_SYNC_COMPLETED: "harness.sync_completed";
  readonly USER_FIRST_INTERACTION: "user.first_interaction";
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
  readonly ROBOT_PATROL: "robot.patrol";
};
type CwEventType = (typeof CW_EVENTS)[keyof typeof CW_EVENTS];
//#endregion
export { CwEventType as n, CW_EVENTS as t };