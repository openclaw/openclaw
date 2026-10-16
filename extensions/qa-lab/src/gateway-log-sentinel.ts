import {
  isRecord,
  normalizeOptionalString as readNonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  extractQaMessageText,
  readQaMessageToolCalls,
  readQaTranscriptMessages,
} from "./runtime-transcript.js";

type GatewayLogSentinelKind =
  | "plugin-hook-failure"
  | "plugin-contract-error"
  | "direct-reply-self-message"
  | "final-reply-delivery-failure"
  | "codex-app-server-timeout"
  | "stalled-agent-run"
  | "cron-model-allowlist"
  | "live-quota-or-subscription";

type GatewayLogSentinelVerdict =
  | "product-bug"
  | "qa-harness-bug"
  | "fixture-bug"
  | "environment-blocked";

type GatewayLogSentinelOwner =
  | "plugin"
  | "openclaw-routing"
  | "codex-runtime"
  | "openclaw-cron"
  | "environment";

export type GatewayLogSentinelFinding = {
  kind: GatewayLogSentinelKind;
  verdict: GatewayLogSentinelVerdict;
  owner: GatewayLogSentinelOwner;
  productImpact: "P0" | "P1" | "P2" | "P3" | "P4";
  qaImpact: "P0" | "P1" | "P2" | "P3" | "P4";
  line: number;
  text: string;
};

type GatewayLogSentinelScanOptions = {
  since?: number;
  kinds?: readonly GatewayLogSentinelKind[];
  ignoreKinds?: readonly GatewayLogSentinelKind[];
};

type GatewayLogSentinelRule = Omit<GatewayLogSentinelFinding, "line" | "text" | "qaImpact"> & {
  test: (line: string) => boolean;
};

const GATEWAY_LOG_SENTINEL_RULES: GatewayLogSentinelRule[] = [
  {
    kind: "plugin-hook-failure",
    verdict: "qa-harness-bug",
    owner: "plugin",
    productImpact: "P1",
    test: (line) =>
      /\bbefore_(?:prompt_build|tool_call)\b/iu.test(line) &&
      /\b(?:crash(?:ed)?|exception|failed|failure|error)\b/iu.test(line),
  },
  {
    kind: "plugin-contract-error",
    verdict: "qa-harness-bug",
    owner: "plugin",
    productImpact: "P1",
    test: (line) =>
      /\bcontracts\.tools\b/iu.test(line) &&
      /\b(?:missing|invalid|registration|register|manifest|contract|schema|declare|error)\b/iu.test(
        line,
      ),
  },
  {
    // Channel reply dispatchers log `<channel> final reply failed: <error>` when
    // the final answer never reached the chat; the channel may only show a
    // generic notice, so the log line is the actionable evidence.
    kind: "final-reply-delivery-failure",
    verdict: "product-bug",
    owner: "openclaw-routing",
    productImpact: "P1",
    test: (line) => /\bfinal reply failed\b/iu.test(line),
  },
  {
    kind: "codex-app-server-timeout",
    verdict: "product-bug",
    owner: "codex-runtime",
    productImpact: "P1",
    test: (line) =>
      /\bcodex app-server\b.*\btimed out\b|\btimed out\b.*\bcodex app-server\b/iu.test(line),
  },
  {
    kind: "stalled-agent-run",
    verdict: "product-bug",
    owner: "codex-runtime",
    productImpact: "P1",
    test: (line) =>
      /\bcodex_app_server\b.*\b(?:stalled|no progress|progress stalled)\b|\b(?:stalled|no progress|progress stalled)\b.*\bcodex_app_server\b/iu.test(
        line,
      ),
  },
  {
    kind: "cron-model-allowlist",
    verdict: "product-bug",
    owner: "openclaw-cron",
    productImpact: "P2",
    test: (line) =>
      /\bcron\b/iu.test(line) &&
      (/\bmodel allowlist\b/iu.test(line) ||
        /\ballowlist\b.*\bmodel\b/iu.test(line) ||
        /\bmodel\b.*\b(?:not in|outside|blocked by)\b.*\ballowlist\b/iu.test(line)),
  },
  {
    kind: "live-quota-or-subscription",
    verdict: "environment-blocked",
    owner: "environment",
    productImpact: "P4",
    test: (line) =>
      /\b(?:quota exceeded|insufficient_quota|subscription exhausted|no active subscription|billing hard limit|usage limit)\b/iu.test(
        line,
      ),
  },
];

function filterGatewayLogSentinelFindings(
  findings: GatewayLogSentinelFinding[],
  options: GatewayLogSentinelScanOptions | undefined,
) {
  const kinds = new Set(options?.kinds ?? []);
  const ignoreKinds = new Set(options?.ignoreKinds ?? []);
  return findings.filter((finding) => {
    if (kinds.size > 0 && !kinds.has(finding.kind)) {
      return false;
    }
    return !ignoreKinds.has(finding.kind);
  });
}

export function extractGatewayMessageText(message: Record<string, unknown>) {
  return extractQaMessageText(message, (type) => {
    const normalized = readNonEmptyString(type)?.toLowerCase().replace(/_/g, "");
    return (
      normalized === "outputtext" ||
      normalized === "text" ||
      normalized === "message" ||
      normalized === "toolresult"
    );
  });
}

function parseJsonArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function hasCurrentChatMessageSend(message: Record<string, unknown>) {
  for (const { block, tool, args } of readQaMessageToolCalls(message, {
    includeFunctionCalls: true,
  })) {
    if (
      isCurrentChatMessageSend(
        tool,
        block ? (block.input ?? block.arguments ?? block.args ?? null) : args,
      )
    ) {
      return true;
    }
  }
  return false;
}

function isCurrentChatMessageSend(name: unknown, rawArgs: unknown) {
  if (readNonEmptyString(name) !== "message") {
    return false;
  }
  const args = parseJsonArguments(rawArgs);
  if (!isRecord(args) || readNonEmptyString(args.action)?.toLowerCase() !== "send") {
    return false;
  }
  const explicitTarget =
    readNonEmptyString(args.conversationId) ??
    readNonEmptyString(args.conversation) ??
    readNonEmptyString(args.to) ??
    readNonEmptyString(args.target);
  if (!explicitTarget) {
    return true;
  }
  return /\b(?:current|same-chat|qa-operator|dm:qa-operator)\b/iu.test(explicitTarget);
}

export function createDirectReplyTranscriptSentinelScanner() {
  let lastAssistantText = "";
  let sentToCurrentChat = false;
  return {
    recordMessage(message: Record<string, unknown>) {
      if (message.role !== "assistant") {
        return;
      }
      const text = extractGatewayMessageText(message);
      if (text) {
        lastAssistantText = text;
      }
      sentToCurrentChat ||= hasCurrentChatMessageSend(message);
    },
    findings(): GatewayLogSentinelFinding[] {
      if (!sentToCurrentChat || lastAssistantText.toLowerCase() !== "sent.") {
        return [];
      }
      return [
        {
          kind: "direct-reply-self-message",
          verdict: "product-bug",
          owner: "openclaw-routing",
          productImpact: "P1",
          qaImpact: "P0",
          line: 1,
          text: "assistant called message(action=send) and then produced final text Sent.",
        },
      ];
    },
  };
}

export function scanDirectReplyTranscriptSentinels(
  transcriptBytes: string,
): GatewayLogSentinelFinding[] {
  const scanner = createDirectReplyTranscriptSentinelScanner();
  for (const message of readQaTranscriptMessages(transcriptBytes)) {
    scanner.recordMessage(message);
  }
  return scanner.findings();
}

export function scanGatewayLogSentinels(
  logs: string | undefined,
  options?: GatewayLogSentinelScanOptions,
): GatewayLogSentinelFinding[] {
  if (!logs) {
    return [];
  }
  const startOffset = Math.max(0, Math.min(logs.length, Math.floor(options?.since ?? 0)));
  const lineOffset = logs.slice(0, startOffset).split(/\r?\n/u).length - 1;
  const findings: GatewayLogSentinelFinding[] = [];
  for (const [index, rawLine] of logs.slice(startOffset).split(/\r?\n/u).entries()) {
    const text = rawLine.trim();
    if (!text) {
      continue;
    }
    for (const { test, ...finding } of GATEWAY_LOG_SENTINEL_RULES) {
      if (!test(text)) {
        continue;
      }
      findings.push({
        ...finding,
        qaImpact: "P0",
        line: lineOffset + index + 1,
        text,
      });
    }
  }
  return filterGatewayLogSentinelFindings(findings, options);
}

export function formatGatewayLogSentinelSummary(findings: readonly GatewayLogSentinelFinding[]) {
  if (findings.length === 0) {
    return "no gateway log sentinels";
  }
  return findings
    .map(
      (finding) =>
        `${finding.kind}@${finding.line} ${finding.verdict} owner=${finding.owner}: ${finding.text}`,
    )
    .join("\n");
}

export function assertNoGatewayLogSentinels(
  logs: string | undefined,
  options?: GatewayLogSentinelScanOptions,
) {
  const findings = scanGatewayLogSentinels(logs, options);
  if (findings.length === 0) {
    return findings;
  }
  throw new Error(
    `Gateway log sentinel(s) detected:\n${formatGatewayLogSentinelSummary(findings)}`,
  );
}
