const INTERIM_EXECUTION_HINTS = [
  "on it",
  "pulling everything together",
  "give me a few",
  "give me a few min",
  "few minutes",
  "let me compile",
  "i'll gather",
  "i will gather",
  "working on it",
  "retrying now",
  "auto-announce when done",
  "我继续处理",
  "我继续执行",
  "我来继续执行",
  "我先处理一下",
  "完成后回报",
  "完成后同步",
] as const;

const FUTURE_PROMISE_HINTS = [
  "我先去看一下",
  "我先看一下图",
  "我先把结果图取出来",
  "我先把结果取出来",
  "看完后我再",
  "看完后再",
  "我接下来会",
  "下一步我会做什么",
  "我现在只做这一件事",
] as const;

const FUTURE_PROMISE_REGEXES = [
  /我(?:会|将|准备|打算)(?:先)?(?:去)?(?:帮你)?(?:看|查|检查|确认|复现|定位|分析|执行|处理|推进|跟进|跑|同步|拉取|截图|生成|获取|取出|拿到)/,
  /(?:我|让我|我这边|我这里)(?:先|马上|立刻|这就|现在就|待会|稍后|等下|等会|一会儿|一会)(?:去)?(?:帮你)?(?:看|查|检查|确认|复现|定位|分析|执行|处理|推进|跟进|跑|同步|拉取|截图|生成|获取|取出|拿到)/,
  /我来(?:先)?(?:帮你)?(?:看|查|检查|确认|复现|定位|分析|执行|处理|推进|跟进|跑|同步|拉取|截图|生成|获取|取出|拿到)/,
  /(?:看完|查完|确认完|处理完|跑完|同步完|拉取完|截图完|生成完).*(?:再|然后).*(?:回报|同步|反馈|回复|告诉你|跟你说)/,
  /先.*(?:再|然后).*(?:回报|同步|反馈|回复|告诉你|跟你说)/,
  /\b(i'?ll|i will)\b.*\b(check|look|see|investigate|get|run|do|pull|gather)\b/,
  /\blet me\b.*\b(check|look|see|investigate|get|run|do|pull|gather)\b/,
  /\bgive me\b.*\b(sec|secs|second|seconds|min|mins|minute|minutes|moment)\b/,
] as const;

const FINAL_RESULT_HINTS = [
  "here is the final result",
  "here are the final results",
  "结果如下",
  "最终结果",
  "结论如下",
  "下面是我的判断",
  "下面是好的地方",
  "下面是还要改的地方",
  "我已经看完图",
  "我已经看到图",
  "我已经看到结果",
] as const;

const BLOCKER_HINTS = ["当前卡点", "当前阻塞", "需要你", "请你提供", "无法继续", "缺少你"] as const;

const MAX_INTERIM_EXECUTION_WORDS = 45;
const MAX_INTERIM_EXECUTION_CHARS = 140;

function normalizeInterimExecutionText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isLikelyInterimExecutionMessage(value: string): boolean {
  const normalized = normalizeInterimExecutionText(value);
  if (!normalized) {
    return false;
  }
  if (FINAL_RESULT_HINTS.some((hint) => normalized.includes(hint))) {
    return false;
  }
  if (BLOCKER_HINTS.some((hint) => normalized.includes(hint))) {
    return false;
  }
  const words = normalized.split(" ").filter(Boolean).length;
  if (
    words <= MAX_INTERIM_EXECUTION_WORDS &&
    normalized.length <= MAX_INTERIM_EXECUTION_CHARS &&
    INTERIM_EXECUTION_HINTS.some((hint) => normalized.includes(hint))
  ) {
    return true;
  }
  if (FUTURE_PROMISE_HINTS.some((hint) => normalized.includes(hint))) {
    return true;
  }
  return FUTURE_PROMISE_REGEXES.some((pattern) => pattern.test(normalized));
}
