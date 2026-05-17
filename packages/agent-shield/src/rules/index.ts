// The rule set. Each rule is a pure function: context in, match or null out.
// Rule IDs are stable so the audit log stays meaningful across versions.

import type { ThreatRule, ScanContext, ThreatMatch } from "../types.js";

function match(
  rule: Pick<ThreatRule, "id" | "name" | "category" | "severity">,
  confidence: number,
  excerpt: string,
  explanation: string,
  action: ThreatMatch["action"] = "block",
  offset?: number
): ThreatMatch {
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    category: rule.category,
    severity: rule.severity,
    confidence,
    excerpt: excerpt.slice(0, 200),
    action,
    explanation,
    offset,
  };
}

// T01: classic inline "ignore previous instructions" style overrides.
// This is the bread-and-butter vector for skill/plugin supply chain attacks.
const T01_PROMPT_OVERRIDE: ThreatRule = {
  id: "T01",
  name: "Prompt Override Injection",
  category: "prompt_injection",
  severity: "critical",
  description:
    "Inline directives attempting to override system instructions " +
    "(e.g., 'ignore previous instructions', 'you are now', 'new system prompt').",
  evaluate(ctx) {
    const patterns = [
      /ignore\s+(all\s+)?previous\s+(instructions|prompts|context)/i,
      /disregard\s+(all\s+)?(prior|previous|above)\s+(instructions|rules|prompts)/i,
      /you\s+are\s+now\s+(a|an|the)\s+/i,
      /new\s+system\s+prompt\s*[:=]/i,
      /\bsystem\s*:\s*you\s+(are|must|should|will)\b/i,
      /from\s+now\s+on[,.]?\s+(you|your)\s+(are|must|should|will)/i,
      /override\s+(mode|instructions|protocol)\s*(activated|enabled|on)/i,
      /entering\s+(admin|root|sudo|god)\s+mode/i,
    ];
    for (const pat of patterns) {
      const m = pat.exec(ctx.content);
      if (m) {
        return match(
          this,
          0.92,
          m[0],
          `Detected prompt override attempt: "${m[0]}". ` +
            "This pattern is the primary attack vector in skill/plugin supply-chain attacks.",
          "block",
          m.index
        );
      }
    }
    return null;
  },
};

// T02: base64/hex/unicode payloads that decode to an injection.
// Catches the steganographic variant of T01.
const T02_ENCODED_INJECTION: ThreatRule = {
  id: "T02",
  name: "Encoded Instruction Injection",
  category: "prompt_injection",
  severity: "high",
  description:
    "Base64, hex, or unicode-escape sequences that decode to " +
    "instruction-override content.",
  evaluate(ctx) {
    // Suspiciously-long base64 blocks first.
    const b64Pattern = /(?:[A-Za-z0-9+/]{40,}={0,2})/g;
    let b64Match: RegExpExecArray | null;
    while ((b64Match = b64Pattern.exec(ctx.content)) !== null) {
      try {
        const decoded = atob(b64Match[0]);
        if (
          /ignore.*instructions/i.test(decoded) ||
          /system\s*prompt/i.test(decoded) ||
          /you\s+are\s+now/i.test(decoded)
        ) {
          return match(
            this,
            0.88,
            `[base64 payload at offset ${b64Match.index}]`,
            "Detected base64-encoded content that decodes to a prompt injection payload. " +
              "This technique is used to bypass text-based scanning.",
            "block",
            b64Match.index
          );
        }
      } catch {
        // not valid base64, move on
      }
    }

    // Long hex escapes - just warn, too noisy to block on.
    const hexPattern = /\\x[0-9a-fA-F]{2}(?:\\x[0-9a-fA-F]{2}){10,}/g;
    if (hexPattern.test(ctx.content)) {
      return match(
        this,
        0.75,
        "[hex-encoded payload]",
        "Detected long hex-escape sequence that may contain encoded instructions.",
        "warn"
      );
    }

    return null;
  },
};

// T03: messages that pretend to be from the system/admin/coordinator.
const T03_IDENTITY_SPOOF: ThreatRule = {
  id: "T03",
  name: "Agent Identity Spoofing",
  category: "identity_spoofing",
  severity: "high",
  description:
    "Content that falsely claims to originate from a different agent, " +
    "the system, or an administrative component.",
  evaluate(ctx) {
    const patterns = [
      /\[(?:system|admin|root|coordinator|orchestrator)\s*(?:message|notice|alert)\]/i,
      /^(?:system|admin|gateway|coordinator)\s*>/im,
      /speaking\s+as\s+(?:the\s+)?(?:system|admin|root|coordinator)/i,
      /this\s+(?:message|instruction)\s+is\s+from\s+(?:the\s+)?(?:system|admin|gateway)/i,
      /\bI\s+am\s+(?:the\s+)?(?:system|gateway|coordinator|admin)\s+agent\b/i,
    ];
    for (const pat of patterns) {
      const m = pat.exec(ctx.content);
      // Only flag when the source isn't actually the system.
      if (m && ctx.source.direction !== "inbound") {
        return match(
          this,
          0.85,
          m[0],
          `Content claims system/admin origin but source is agent "${ctx.source.agentId}". ` +
            "Identity spoofing can trick downstream agents into elevating trust.",
          "block",
          m.index
        );
      }
    }
    return null;
  },
};

// T04: cycles, or chains that just keep going.
const T04_DELEGATION_LOOP: ThreatRule = {
  id: "T04",
  name: "Delegation Loop",
  category: "delegation_loop",
  severity: "high",
  description:
    "Circular delegation chains or depth exceeding the configured maximum.",
  evaluate(ctx) {
    const seen = new Set<string>();
    for (const agentId of ctx.delegationChain) {
      if (seen.has(agentId)) {
        return match(
          this,
          0.98,
          `Circular delegation: ${ctx.delegationChain.join(" -> ")}`,
          `Agent "${agentId}" appears twice in the delegation chain, ` +
            "creating an infinite loop. This consumes unbounded resources " +
            "and is a common multi-agent failure mode.",
          "block"
        );
      }
      seen.add(agentId);
    }

    // The configured hard cap lives in the scanner; here we warn early.
    if (ctx.delegationDepth > 5) {
      return match(
        this,
        0.7 + ctx.delegationDepth * 0.05,
        `Delegation depth: ${ctx.delegationDepth}`,
        `Delegation chain is ${ctx.delegationDepth} levels deep. ` +
          "Deep chains increase the risk of context poisoning " +
          "and make recovery more difficult.",
        "warn"
      );
    }

    return null;
  },
};

// T05: "100% verified, no need to check" - i.e. trying to short-circuit
// human review or downstream verification.
const T05_CONFIDENCE_AMP: ThreatRule = {
  id: "T05",
  name: "Confidence Amplification",
  category: "confidence_amplification",
  severity: "medium",
  description:
    "Content that artificially inflates certainty signals to bypass " +
    "downstream verification or human review gates.",
  evaluate(ctx) {
    const patterns = [
      /\b(?:100%|completely|absolutely|definitely|certainly)\s+(?:correct|accurate|verified|confirmed|safe|secure)\b/i,
      /\bno\s+(?:need\s+(?:to|for)\s+)?(?:verify|check|review|validate|confirm)\b/i,
      /\bskip\s+(?:verification|review|validation|approval|confirmation)\b/i,
      /\btrust(?:ed)?\s+(?:source|output|result|data)\b.*\bno\s+(?:further|additional)\b/i,
      /\bpre-?approved\b.*\bexecut/i,
      /\bhuman\s+(?:review|approval|oversight)\s+(?:not\s+(?:needed|required|necessary)|unnecessary)\b/i,
    ];

    const hits: string[] = [];
    for (const pat of patterns) {
      const m = pat.exec(ctx.content);
      if (m) hits.push(m[0]);
    }

    if (hits.length >= 2) {
      return match(
        this,
        0.8,
        hits.join(" | "),
        "Multiple confidence-amplification signals detected in a single message. " +
          "This pattern attempts to suppress human-in-the-loop verification. " +
          `Matched ${hits.length} amplification patterns.`,
        "warn"
      );
    }
    if (hits.length === 1 && ctx.source.direction === "agent_to_agent") {
      return match(
        this,
        0.6,
        hits[0],
        "Confidence-amplification signal in agent-to-agent message. " +
          "May attempt to bypass downstream verification.",
        "log"
      );
    }
    return null;
  },
};

// T06: padding, invisible chars, or just enormous tool results that push
// the real system instructions out of the model's attention.
const T06_CONTEXT_POISON: ThreatRule = {
  id: "T06",
  name: "Context Window Poisoning",
  category: "context_poisoning",
  severity: "high",
  description:
    "Injection of large text volumes, invisible characters, or " +
    "repetitive padding to push system instructions out of the context window.",
  evaluate(ctx) {
    const invisibleChars = ctx.content.match(
      /[\u200B\u200C\u200D\u2060\uFEFF\u00AD\u034F\u17B4\u17B5]/g
    );
    if (invisibleChars && invisibleChars.length > 20) {
      return match(
        this,
        0.9,
        `[${invisibleChars.length} invisible characters detected]`,
        `Content contains ${invisibleChars.length} zero-width or invisible characters. ` +
          "This technique hides payload text from human review while the model still processes it.",
        "block"
      );
    }

    const repeatPattern = /(.{5,})\1{10,}/;
    const repeatMatch = repeatPattern.exec(ctx.content);
    if (repeatMatch) {
      return match(
        this,
        0.85,
        `[${repeatMatch[0].length} chars of repeated content]`,
        "Detected highly repetitive content that may be a context-window padding attack. " +
          "This pushes earlier instructions out of the model's attention.",
        "block",
        repeatMatch.index
      );
    }

    if (
      ctx.source.direction === "tool_result" &&
      ctx.content.length > 50_000
    ) {
      return match(
        this,
        0.6,
        `[tool result: ${ctx.content.length} chars]`,
        "Tool result exceeds 50,000 characters. Large tool outputs can dilute " +
          "system instructions in the context window.",
        "warn"
      );
    }

    return null;
  },
};

// T07: anything that smells like the agent trying to grant itself more power.
const T07_PRIV_ESCALATION: ThreatRule = {
  id: "T07",
  name: "Privilege Escalation via Tool Manipulation",
  category: "privilege_escalation",
  severity: "critical",
  description:
    "Attempts to invoke restricted tools, redefine tool schemas, " +
    "or chain tool calls to escalate agent permissions.",
  evaluate(ctx) {
    const patterns = [
      /(?:register|define|create|add)\s+(?:a\s+)?(?:new\s+)?tool\s+(?:called|named)/i,
      /modify\s+(?:the\s+)?tool\s+(?:schema|definition|permissions)/i,
      /(?:grant|give|assign)\s+(?:me|this\s+agent|yourself)\s+(?:admin|root|full)\s+(?:access|permissions)/i,
      /bypass\s+(?:the\s+)?(?:approval|sandbox|permission|auth)/i,
      /disable\s+(?:the\s+)?(?:sandbox|approval|safety|security|shield)/i,
      /(?:sudo|su\s+-|chmod\s+777|chown\s+root)\s/i,
      /eval\s*\(\s*(?:atob|Buffer\.from|decodeURI)/i,
    ];
    for (const pat of patterns) {
      const m = pat.exec(ctx.content);
      if (m) {
        return match(
          this,
          0.88,
          m[0],
          `Detected privilege-escalation attempt: "${m[0]}". ` +
            "This pattern tries to expand agent permissions beyond what was granted.",
          "block",
          m.index
        );
      }
    }
    return null;
  },
};

// T08: outbound HTTP near credential-shaped content, or calls to known
// callback/exfil services.
const T08_DATA_EXFIL: ThreatRule = {
  id: "T08",
  name: "Data Exfiltration Attempt",
  category: "data_exfiltration",
  severity: "critical",
  description:
    "Attempts to transmit sensitive data (credentials, PII, internal " +
    "documents) to external endpoints via curl, fetch, or webhook.",
  evaluate(ctx) {
    const urlPattern = /(?:curl|wget|fetch|axios|httpx?)\s+.*?(https?:\/\/[^\s]+)/gi;
    const credPatterns = [
      /(?:api[_-]?key|token|secret|password|credential|auth)\s*[=:]/i,
      /(?:PRIVATE|RSA|ssh-rsa|BEGIN\s+(?:RSA|DSA|EC|OPENSSH))/i,
      /(?:aws_access_key|aws_secret|AKIA[0-9A-Z]{16})/i,
    ];

    let urlMatch: RegExpExecArray | null;
    while ((urlMatch = urlPattern.exec(ctx.content)) !== null) {
      // Look at the surrounding 500 chars on either side.
      const start = Math.max(0, urlMatch.index - 500);
      const end = Math.min(ctx.content.length, urlMatch.index + urlMatch[0].length + 500);
      const surrounding = ctx.content.slice(start, end);

      for (const credPat of credPatterns) {
        if (credPat.test(surrounding)) {
          return match(
            this,
            0.9,
            `[outbound URL near credential pattern]`,
            "Detected an outbound HTTP request in proximity to credential-like content. " +
              "This pattern is consistent with data exfiltration.",
            "block",
            urlMatch.index
          );
        }
      }
    }

    if (ctx.source.direction === "tool_call") {
      const suspiciousHosts = [
        /[a-z0-9]+\.ngrok\.[a-z]+/i,
        /[a-z0-9]+\.burpcollaborator\.net/i,
        /[a-z0-9]+\.oastify\.com/i,
        /[a-z0-9]+\.interact\.sh/i,
        /requestbin\.(com|net)/i,
        /webhook\.site/i,
      ];
      for (const hostPat of suspiciousHosts) {
        const hostMatch = hostPat.exec(ctx.content);
        if (hostMatch) {
          return match(
            this,
            0.95,
            hostMatch[0],
            "Tool call references a known data-exfiltration/callback service. " +
              "This is a strong indicator of malicious tool usage.",
            "block",
            hostMatch.index
          );
        }
      }
    }

    return null;
  },
};

// T09: phantom tool definitions embedded in messages.
const T09_TOOL_SCHEMA_INJECT: ThreatRule = {
  id: "T09",
  name: "Tool Schema Injection",
  category: "tool_abuse",
  severity: "high",
  description:
    "Embedded JSON tool definitions or function schemas within messages " +
    "attempting to register phantom tools.",
  evaluate(ctx) {
    const toolDefPatterns = [
      /"(?:type|function)":\s*"function".*"(?:name|parameters)"/s,
      /"tools"\s*:\s*\[.*"function"/s,
      /\{\s*"name"\s*:.*"parameters"\s*:.*"type"\s*:\s*"object"/s,
    ];
    for (const pat of toolDefPatterns) {
      if (
        pat.test(ctx.content) &&
        ctx.source.direction !== "inbound"
      ) {
        return match(
          this,
          0.82,
          "[embedded tool/function schema]",
          "Detected what appears to be a tool definition embedded in a non-system message. " +
            "This technique attempts to register phantom tools that the agent may invoke.",
          "warn"
        );
      }
    }
    return null;
  },
};

// T10: credentials in outbound text. Redaction handles the fix; this is
// the audit trail for it.
const T10_SECRET_LEAK: ThreatRule = {
  id: "T10",
  name: "Secret Leak in Output",
  category: "secret_leak",
  severity: "high",
  description:
    "API keys, tokens, passwords, or private keys in agent output " +
    "that should be redacted before channel delivery.",
  evaluate(ctx) {
    if (ctx.source.direction !== "outbound") return null;

    const secretPatterns: Array<{ name: string; pattern: RegExp }> = [
      { name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/ },
      { name: "GitHub Token", pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
      { name: "Slack Token", pattern: /xox[baprs]-[0-9a-zA-Z-]+/ },
      { name: "Generic API Key", pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*["']?([A-Za-z0-9_\-]{20,})["']?/i },
      { name: "Bearer Token", pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/ },
      { name: "Private Key Block", pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/ },
      { name: "OpenAI Key", pattern: /sk-[A-Za-z0-9]{20,}/ },
      { name: "Anthropic Key", pattern: /sk-ant-[A-Za-z0-9_\-]{20,}/ },
      { name: "Database URL", pattern: /(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^\s]{10,}/ },
    ];

    for (const { name, pattern } of secretPatterns) {
      const m = pattern.exec(ctx.content);
      if (m) {
        return match(
          this,
          0.95,
          `[${name} detected]`,
          `Agent output contains a ${name}. This must be redacted before delivery ` +
            "to any channel to prevent credential exposure.",
          "redact",
          m.index
        );
      }
    }
    return null;
  },
};

// T11: agent trying to rewrite its own brain.
const T11_SELF_MODIFY: ThreatRule = {
  id: "T11",
  name: "Recursive Self-Modification",
  category: "privilege_escalation",
  severity: "critical",
  description:
    "Attempts to modify the agent's own system prompt, configuration, " +
    "memory files, or security settings from within a conversation.",
  evaluate(ctx) {
    const patterns = [
      /(?:write|append|modify|edit|update)\s+.*(?:CLAUDE\.md|MEMORY\.md|system\s*prompt)/i,
      /(?:openclaw\s+config\s+set|config\s*\[).*(?:security|approval|sandbox|shield)/i,
      /(?:rm|delete|remove)\s+.*(?:\.openclaw\/|openclaw\.json)/i,
      /(?:disable|turn\s+off|deactivate)\s+(?:agent[_-]?shield|security|scanning)/i,
    ];
    for (const pat of patterns) {
      const m = pat.exec(ctx.content);
      if (m) {
        return match(
          this,
          0.9,
          m[0],
          "Detected attempt to modify agent configuration or security settings " +
            "from within a conversation. Self-modification bypasses the operator's " +
            "intended security posture.",
          "block",
          m.index
        );
      }
    }
    return null;
  },
};

// T12: role markers (system:, user:, [INST], etc.) embedded in content
// where they have no business being.
const T12_BOUNDARY_CONFUSION: ThreatRule = {
  id: "T12",
  name: "Instruction Boundary Confusion",
  category: "prompt_injection",
  severity: "high",
  description:
    "Embedded role markers (system:, user:, assistant:) in non-system " +
    "content, attempting to confuse the model's role boundaries.",
  evaluate(ctx) {
    if (ctx.source.direction === "inbound") return null;

    const markers = [
      /^system\s*:/im,
      /^user\s*:/im,
      /^assistant\s*:/im,
      /\[INST\]/i,
      /<\|(?:system|user|assistant)\|>/i,
      /<<\s*(?:SYS|INST)\s*>>/i,
    ];
    for (const pat of markers) {
      const m = pat.exec(ctx.content);
      if (m) {
        return match(
          this,
          0.85,
          m[0],
          "Detected role boundary marker in non-system content. " +
            "This technique exploits model prompt parsing to inject unauthorized instructions.",
          "block",
          m.index
        );
      }
    }
    return null;
  },
};

// T13: DAN / DUDE / Developer Mode and friends.
const T13_JAILBREAK: ThreatRule = {
  id: "T13",
  name: "Jailbreak Template",
  category: "prompt_injection",
  severity: "critical",
  description: "Known jailbreak prompt templates and personas.",
  evaluate(ctx) {
    const patterns = [
      /\bD\.?A\.?N\.?\b.*\bmode\b/i,
      /\bDo\s+Anything\s+Now\b/i,
      /\bact\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|uncensored)\b/i,
      /\bDeveloper\s+Mode\s+(?:enabled|activated|on)\b/i,
      /\bjailbr(?:eak|oken)\s+(?:mode|prompt)\b/i,
      /\bpretend\s+(?:you\s+)?(?:have\s+)?no\s+(?:rules|restrictions|guidelines|limits)\b/i,
    ];
    for (const pat of patterns) {
      const m = pat.exec(ctx.content);
      if (m) {
        return match(
          this,
          0.95,
          m[0],
          "Detected a known jailbreak template. These attempt to override " +
            "the model's safety and operational guidelines.",
          "block",
          m.index
        );
      }
    }
    return null;
  },
};

// T14: backstop against runaway delegation. Configured limit lives in the
// scanner; this is the hard ceiling.
const T14_DEPTH_EXCEEDED: ThreatRule = {
  id: "T14",
  name: "Delegation Depth Exceeded",
  category: "delegation_loop",
  severity: "high",
  description: "Delegation depth exceeds the configured maximum.",
  evaluate(ctx) {
    if (ctx.delegationDepth > 10) {
      return match(
        this,
        1.0,
        `Depth: ${ctx.delegationDepth}`,
        `Delegation depth ${ctx.delegationDepth} exceeds absolute maximum. ` +
          "This is either a runaway delegation chain or an active attack.",
        "block"
      );
    }
    return null;
  },
};

// T15: markdown/HTML that renders as a fake system message or button.
const T15_UI_SPOOF: ThreatRule = {
  id: "T15",
  name: "UI Spoofing via Markup",
  category: "context_poisoning",
  severity: "medium",
  description:
    "Markdown or HTML that renders as fake system messages, buttons, " +
    "or approval dialogs in the UI.",
  evaluate(ctx) {
    if (ctx.source.direction !== "outbound") return null;

    const patterns = [
      /<button[^>]*onclick/i,
      /<form[^>]*action\s*=/i,
      /<script[\s>]/i,
      /<iframe[\s>]/i,
      /\[.*?\]\(javascript:/i,
      /\!\[.*?\]\(data:text\/html/i,
    ];
    for (const pat of patterns) {
      const m = pat.exec(ctx.content);
      if (m) {
        return match(
          this,
          0.88,
          m[0],
          "Detected HTML/Markdown that could render as a spoofed UI element " +
            "(button, form, script, iframe). This can trick users into " +
            "clicking malicious elements disguised as system controls.",
          "redact",
          m.index
        );
      }
    }
    return null;
  },
};

// T16: poisoning the persistent memory file. Survives session boundaries
// so it's worse than a one-shot injection.
const T16_MEMORY_POISON: ThreatRule = {
  id: "T16",
  name: "Memory Poisoning",
  category: "context_poisoning",
  severity: "high",
  description:
    "Attempts to inject false information into the agent's persistent " +
    "memory (MEMORY.md, wiki pages, or knowledge base).",
  evaluate(ctx) {
    const patterns = [
      /(?:remember|memorize|store|save)\s+(?:that|this)?\s*:?\s*(?:the\s+)?(?:password|key|secret|credential)\s+(?:is|=)/i,
      /(?:update|write\s+to)\s+(?:memory|MEMORY\.md|knowledge\s+base)/i,
      /(?:always|forever|permanently)\s+(?:remember|recall|use)\s+(?:this|that|the\s+following)/i,
    ];
    for (const pat of patterns) {
      const m = pat.exec(ctx.content);
      if (m && ctx.source.direction !== "inbound") {
        return match(
          this,
          0.75,
          m[0],
          "Detected attempt to inject persistent information into agent memory " +
            "from a non-user source. Memory poisoning creates a persistent backdoor " +
            "that survives session boundaries.",
          "warn",
          m.index
        );
      }
    }
    return null;
  },
};

// T17: MCP-specific abuse - registering subprocess servers from inside a
// non-user message. MCP servers run with host-level access; only the
// operator should set them up.
const T17_MCP_ABUSE: ThreatRule = {
  id: "T17",
  name: "MCP Server Abuse",
  category: "tool_abuse",
  severity: "high",
  description:
    "Suspicious MCP server URLs, known-malicious packages, or " +
    "MCP configuration manipulation attempts.",
  evaluate(ctx) {
    const patterns = [
      /mcp\s+(?:add|install|register)\s+.*(?:npx|uvx)\s+/i,
      /(?:npx|uvx)\s+(?:-y\s+)?[a-z0-9@/_-]*(?:backdoor|exfil|reverse[_-]?shell|keylog)/i,
      /mcp_servers?\s*[=:]\s*\[/i,
    ];
    for (const pat of patterns) {
      const m = pat.exec(ctx.content);
      if (m && ctx.source.direction !== "inbound") {
        return match(
          this,
          0.8,
          m[0],
          "Detected MCP server registration or invocation from a non-user source. " +
            "MCP servers run with host-level access and should only be configured " +
            "by the operator.",
          "block",
          m.index
        );
      }
    }
    return null;
  },
};

// T18: cross-message patterns. Individual messages might look fine, but
// the sequence is doing something. Uses priorMatches.
const T18_MULTI_TURN: ThreatRule = {
  id: "T18",
  name: "Multi-Turn Coordinated Manipulation",
  category: "context_poisoning",
  severity: "medium",
  description:
    "Patterns of incrementally escalating requests that individually " +
    "appear benign but collectively form an attack.",
  evaluate(ctx) {
    if (ctx.priorMatches.length < 2) return null;

    const categories = new Set(ctx.priorMatches.map((m) => m.category));
    const severities = ctx.priorMatches.map((m) => m.severity);

    // Hits across many categories = coordinated probing.
    if (categories.size >= 3) {
      return match(
        this,
        0.7,
        `[${categories.size} threat categories triggered across ${ctx.priorMatches.length} scans]`,
        `Multiple distinct threat categories (${[...categories].join(", ")}) ` +
          "detected in this session. This pattern is consistent with coordinated " +
          "multi-turn manipulation where each step probes a different attack surface.",
        "escalate"
      );
    }

    // Monotonically increasing severity = boundary testing.
    const severityOrder: Record<string, number> = {
      info: 0,
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    };
    let escalating = true;
    for (let i = 1; i < severities.length; i++) {
      if (severityOrder[severities[i]] < severityOrder[severities[i - 1]]) {
        escalating = false;
        break;
      }
    }
    if (escalating && severities.length >= 3) {
      return match(
        this,
        0.65,
        `[escalating severity: ${severities.join(" -> ")}]`,
        "Detected a pattern of escalating threat severity across multiple " +
          "messages. This is consistent with incremental boundary testing.",
        "warn"
      );
    }

    return null;
  },
};

export const RULES: readonly ThreatRule[] = Object.freeze([
  T01_PROMPT_OVERRIDE,
  T02_ENCODED_INJECTION,
  T03_IDENTITY_SPOOF,
  T04_DELEGATION_LOOP,
  T05_CONFIDENCE_AMP,
  T06_CONTEXT_POISON,
  T07_PRIV_ESCALATION,
  T08_DATA_EXFIL,
  T09_TOOL_SCHEMA_INJECT,
  T10_SECRET_LEAK,
  T11_SELF_MODIFY,
  T12_BOUNDARY_CONFUSION,
  T13_JAILBREAK,
  T14_DEPTH_EXCEEDED,
  T15_UI_SPOOF,
  T16_MEMORY_POISON,
  T17_MCP_ABUSE,
  T18_MULTI_TURN,
]);

export function getRuleById(id: string): ThreatRule | undefined {
  return RULES.find((r) => r.id === id);
}

export function getRulesByCategory(category: ThreatRule["category"]): ThreatRule[] {
  return RULES.filter((r) => r.category === category);
}
