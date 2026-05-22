/**
 * card-builder.ts — ClaWorks 渠道无关卡片构建器
 *
 * 生成结构化的 CwCard 对象，各渠道适配器负责转换：
 *   - toFeishu()     → 飞书互动卡片 JSON (msg_type: "interactive")
 *   - toWeixinWork() → 企微 Markdown 格式卡片
 *   - toPlainText()  → 纯文本降级（无富文本渠道兜底）
 *
 * 内置业务卡片模板（5 个）：
 *   alarm / work_order / approval / report / health_status
 */

// ── 卡片元素类型 ──────────────────────────────────────────────────────────

export type CardColor = "red" | "orange" | "green" | "blue" | "grey" | "purple";

export type CardElement =
  | { type: "title"; text: string; level?: 1 | 2 | 3 }
  | { type: "text"; text: string; bold?: boolean; color?: string }
  | { type: "field"; label: string; value: string; inline?: boolean }
  | { type: "divider" }
  | {
      type: "button";
      text: string;
      action: string;
      value?: string;
      style?: "primary" | "danger" | "default";
    }
  | { type: "badge"; text: string; color?: CardColor }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "note"; text: string }
  | { type: "image"; url: string; alt?: string };

export type CwCard = {
  /** 卡片模板 ID（alarm / work_order / approval / report / health_status / custom） */
  template: string;
  title: string;
  color?: CardColor;
  elements: CardElement[];
  /** 底部操作按钮（仅 button 类型有效） */
  actions?: CardElement[];
  footer?: string;
};

// ── CardBuilder 接口 ──────────────────────────────────────────────────────

export interface CardBuilder {
  build(card: CwCard): CwCard;

  alarm(opts: {
    alarmId: string;
    equipmentId: string;
    severity: string;
    description: string;
    time?: string;
  }): CwCard;

  workOrder(opts: {
    id: string;
    title: string;
    status: string;
    assignee: string;
    priority: string;
    equipment?: string;
  }): CwCard;

  approval(opts: {
    id: string;
    title: string;
    applicant: string;
    status: string;
    description?: string;
  }): CwCard;

  report(opts: {
    title: string;
    period: string;
    metrics: Array<{ label: string; value: string }>;
  }): CwCard;

  healthStatus(opts: {
    overall: string;
    dimensions: Array<{ name: string; status: string; note?: string }>;
  }): CwCard;

  /**
   * 每日生产日报卡片（结构化四格数据展示）。
   * 专为 daily_briefing Playbook 的第三步（纯模板组装，无 LLM）设计。
   */
  dailyReport(opts: {
    date: string;
    summary: string;
    stats: {
      alarms: number;
      workOrders: number;
      completedTasks: number;
      equipmentHealth: number;
    };
    highlights?: string[];
    warnings?: string[];
  }): CwCard;

  toFeishu(card: CwCard): Record<string, unknown>;
  toWeixinWork(card: CwCard): Record<string, unknown>;
  toPlainText(card: CwCard): string;
  /** 自动按渠道名选择格式：feishu→对象, weixin_work→对象, 其他→纯文本 */
  toAuto(card: CwCard, channel: string): unknown;
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────

const SEVERITY_COLOR_MAP: Record<string, CardColor> = {
  critical: "red",
  high: "orange",
  medium: "blue",
  low: "grey",
  ok: "green",
  normal: "green",
};

function severityToColor(severity: string): CardColor {
  return SEVERITY_COLOR_MAP[severity.toLowerCase()] ?? "blue";
}

/** @internal reserved for future use in card rendering */
export function _statusBadge(text: string, status: string): CardElement & { type: "badge" } {
  const colorMap: Record<string, CardColor> = {
    open: "orange",
    pending: "orange",
    in_progress: "blue",
    closed: "green",
    done: "green",
    approved: "green",
    rejected: "red",
    cancelled: "grey",
    critical: "red",
    high: "orange",
    medium: "blue",
    low: "grey",
  };
  return { type: "badge", text, color: colorMap[status.toLowerCase()] ?? "grey" };
}

// ── 飞书卡片转换 ──────────────────────────────────────────────────────────

function elementToFeishuDiv(el: CardElement): Record<string, unknown> | null {
  switch (el.type) {
    case "title": {
      const prefix = el.level === 1 ? "**" : el.level === 2 ? "**" : "";
      const suffix = prefix;
      return {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `${prefix}${el.text}${suffix}`,
        },
      };
    }
    case "text": {
      const content = el.bold ? `**${el.text}**` : el.text;
      return { tag: "div", text: { tag: "lark_md", content } };
    }
    case "field": {
      return {
        tag: "div",
        fields: [
          {
            is_short: el.inline ?? false,
            text: { tag: "lark_md", content: `**${el.label}：** ${el.value}` },
          },
        ],
      };
    }
    case "divider":
      return { tag: "hr" };
    case "note":
      return {
        tag: "note",
        elements: [{ tag: "plain_text", content: el.text }],
      };
    case "badge":
      return { tag: "div", text: { tag: "lark_md", content: `**[${el.text}]**` } };
    case "table": {
      // 飞书不原生支持表格，转为多行 Markdown
      const header = `| ${el.headers.join(" | ")} |`;
      const sep = `| ${el.headers.map(() => "---").join(" | ")} |`;
      const rows = el.rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
      return {
        tag: "div",
        text: { tag: "lark_md", content: [header, sep, rows].join("\n") },
      };
    }
    case "image":
      return {
        tag: "img",
        img_key: el.url,
        alt: { tag: "plain_text", content: el.alt ?? "" },
      };
    default:
      return null;
  }
}

function buttonToFeishuAction(el: CardElement & { type: "button" }): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: el.text },
    type: el.style === "danger" ? "danger" : el.style === "primary" ? "primary" : "default",
    value: { action: el.action, value: el.value ?? "" },
  };
}

// ── 企微 Markdown 转换 ────────────────────────────────────────────────────

function elementToWeixinMd(el: CardElement): string {
  switch (el.type) {
    case "title":
      return `${"#".repeat(el.level ?? 2)} ${el.text}`;
    case "text":
      return el.bold ? `**${el.text}**` : el.text;
    case "field":
      return `> **${el.label}：**${el.value}`;
    case "divider":
      return "---";
    case "note":
      return `> ${el.text}`;
    case "badge":
      return `[${el.text}]`;
    case "button":
      return `[${el.text}]`;
    case "table": {
      const header = `| ${el.headers.join(" | ")} |`;
      const sep = `| ${el.headers.map(() => "---").join(" | ")} |`;
      const rows = el.rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
      return [header, sep, rows].join("\n");
    }
    case "image":
      return el.alt ? `[图片: ${el.alt}]` : "[图片]";
    default:
      return "";
  }
}

// ── createCardBuilder ─────────────────────────────────────────────────────

export function createCardBuilder(): CardBuilder {
  return {
    build(card) {
      return card;
    },

    alarm({ alarmId, equipmentId, severity, description, time }) {
      const color = severityToColor(severity);
      const elements: CardElement[] = [
        { type: "field", label: "报警ID", value: alarmId, inline: true },
        { type: "field", label: "设备", value: equipmentId, inline: true },
        { type: "field", label: "级别", value: severity.toUpperCase(), inline: true },
        ...(time ? [{ type: "field" as const, label: "时间", value: time, inline: true }] : []),
        { type: "divider" },
        { type: "text", text: description },
      ];
      const actions: CardElement[] = [
        {
          type: "button",
          text: "确认报警",
          action: "alarm.acknowledge",
          value: alarmId,
          style: "primary",
        },
        {
          type: "button",
          text: "查看详情",
          action: "alarm.view",
          value: alarmId,
          style: "default",
        },
      ];
      return {
        template: "alarm",
        title: `🚨 设备报警 — ${equipmentId}`,
        color,
        elements,
        actions,
      };
    },

    workOrder({ id, title, status, assignee, priority, equipment }) {
      const elements: CardElement[] = [
        { type: "field", label: "工单号", value: id, inline: true },
        { type: "field", label: "状态", value: status, inline: true },
        { type: "field", label: "负责人", value: assignee, inline: true },
        { type: "field", label: "优先级", value: priority, inline: true },
        ...(equipment
          ? [{ type: "field" as const, label: "设备", value: equipment, inline: true }]
          : []),
        { type: "divider" },
        { type: "text", text: title },
      ];
      const actions: CardElement[] = [
        { type: "button", text: "接单", action: "workorder.accept", value: id, style: "primary" },
        { type: "button", text: "查看工单", action: "workorder.view", value: id, style: "default" },
      ];
      return {
        template: "work_order",
        title: `🔧 工单通知`,
        color: priority === "urgent" ? "orange" : "blue",
        elements,
        actions,
      };
    },

    approval({ id, title, applicant, status, description }) {
      const isPending = status === "pending" || status === "created";
      const elements: CardElement[] = [
        { type: "field", label: "审批ID", value: id, inline: true },
        { type: "field", label: "申请人", value: applicant, inline: true },
        { type: "field", label: "状态", value: status, inline: true },
        ...(description
          ? [{ type: "divider" as const }, { type: "text" as const, text: description }]
          : []),
      ];
      const actions: CardElement[] = isPending
        ? [
            {
              type: "button",
              text: "同意",
              action: "approval.approve",
              value: id,
              style: "primary",
            },
            { type: "button", text: "拒绝", action: "approval.reject", value: id, style: "danger" },
          ]
        : [
            {
              type: "button",
              text: "查看详情",
              action: "approval.view",
              value: id,
              style: "default",
            },
          ];
      return {
        template: "approval",
        title: `📋 ${isPending ? "待审批" : "审批通知"} — ${title}`,
        color: isPending ? "orange" : status === "approved" ? "green" : "red",
        elements,
        actions,
      };
    },

    report({ title, period, metrics }) {
      const elements: CardElement[] = [
        { type: "field", label: "统计周期", value: period },
        { type: "divider" },
        ...metrics.map<CardElement>((m) => ({
          type: "field",
          label: m.label,
          value: m.value,
          inline: true,
        })),
      ];
      return {
        template: "report",
        title: `📊 ${title}`,
        color: "blue",
        elements,
      };
    },

    dailyReport({ date, summary, stats, highlights, warnings }) {
      const overallColor: CardColor =
        stats.alarms > 5 || stats.equipmentHealth < 80 ? "orange" : "green";
      const elements: CardElement[] = [
        { type: "text", text: summary },
        { type: "divider" },
        { type: "field", label: "🚨 未处置报警", value: String(stats.alarms), inline: true },
        { type: "field", label: "🔧 待处理工单", value: String(stats.workOrders), inline: true },
        { type: "field", label: "✅ 今日完成", value: String(stats.completedTasks), inline: true },
        {
          type: "field",
          label: "⚙️ 设备健康",
          value: `${stats.equipmentHealth}%`,
          inline: true,
        },
      ];

      if (highlights && highlights.length > 0) {
        elements.push({ type: "divider" });
        elements.push({
          type: "text",
          text: `✨ 今日亮点\n${highlights.map((h) => `• ${h}`).join("\n")}`,
          bold: false,
        });
      }

      if (warnings && warnings.length > 0) {
        elements.push({
          type: "text",
          text: `⚠️ 注意事项\n${warnings.map((w) => `• ${w}`).join("\n")}`,
          bold: false,
        });
      }

      const actions: CardElement[] = [
        {
          type: "button",
          text: "📋 查看详情",
          action: "view_daily_detail",
          value: date,
          style: "primary",
        },
        {
          type: "button",
          text: "📤 导出报告",
          action: "export_report",
          value: date,
          style: "default",
        },
      ];

      return {
        template: "daily_report",
        title: `📊 每日生产报告 · ${date}`,
        color: overallColor,
        elements,
        actions,
        footer: `生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
      };
    },

    healthStatus({ overall, dimensions }) {
      const color =
        overall === "ok" || overall === "healthy"
          ? "green"
          : overall === "degraded"
            ? "orange"
            : "red";
      const elements: CardElement[] = [
        { type: "field", label: "整体状态", value: overall.toUpperCase() },
        { type: "divider" },
        ...dimensions.map<CardElement>((d) => ({
          type: "field",
          label: d.name,
          value: d.note ? `${d.status} — ${d.note}` : d.status,
          inline: true,
        })),
      ];
      return {
        template: "health_status",
        title: "💚 系统健康状态",
        color,
        elements,
      };
    },

    toFeishu(card) {
      const feishuElements: Record<string, unknown>[] = [];

      for (const el of card.elements) {
        const div = elementToFeishuDiv(el);
        if (div) {
          feishuElements.push(div);
        }
      }

      if (card.actions && card.actions.length > 0) {
        const buttons = card.actions
          .filter((a): a is CardElement & { type: "button" } => a.type === "button")
          .map((b) => buttonToFeishuAction(b));
        if (buttons.length > 0) {
          feishuElements.push({ tag: "action", actions: buttons });
        }
      }

      if (card.footer) {
        feishuElements.push({ tag: "hr" });
        feishuElements.push({
          tag: "note",
          elements: [{ tag: "plain_text", content: card.footer }],
        });
      }

      return {
        msg_type: "interactive",
        card: {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: "plain_text", content: card.title },
            template: card.color ?? "blue",
          },
          elements: feishuElements,
        },
      };
    },

    toWeixinWork(card) {
      const lines: string[] = [`## ${card.title}`, ""];
      for (const el of card.elements) {
        const line = elementToWeixinMd(el);
        if (line) {
          lines.push(line);
        }
      }
      if (card.actions && card.actions.length > 0) {
        lines.push("");
        lines.push("**操作：**");
        for (const action of card.actions) {
          if (action.type === "button") {
            lines.push(`· [${action.text}]`);
          }
        }
      }
      if (card.footer) {
        lines.push("", `> ${card.footer}`);
      }
      return {
        msgtype: "markdown",
        markdown: { content: lines.join("\n") },
      };
    },

    toAuto(card, channel) {
      const ch = channel.toLowerCase();
      if (ch === "feishu" || ch === "lark") {
        return this.toFeishu(card);
      }
      if (ch === "weixin_work" || ch === "weixinwork" || ch === "wxwork") {
        return this.toWeixinWork(card);
      }
      return this.toPlainText(card);
    },

    toPlainText(card) {
      const parts: string[] = [card.title, ""];
      for (const el of card.elements) {
        switch (el.type) {
          case "title":
            parts.push(el.text);
            break;
          case "text":
            parts.push(el.text);
            break;
          case "field":
            parts.push(`${el.label}：${el.value}`);
            break;
          case "divider":
            parts.push("────────────────────");
            break;
          case "note":
            parts.push(`[注] ${el.text}`);
            break;
          case "badge":
            parts.push(`[${el.text}]`);
            break;
          case "table":
            parts.push(el.headers.join(" | "));
            for (const row of el.rows) {
              parts.push(row.join(" | "));
            }
            break;
        }
      }
      if (card.footer) {
        parts.push("", card.footer);
      }
      return parts.filter(Boolean).join("\n");
    },
  };
}

/** 全局默认 CardBuilder 实例 */
export const defaultCardBuilder = createCardBuilder();
