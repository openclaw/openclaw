import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  applyAnthropicPayloadPolicyToParams,
  applyAnthropicRequestCacheControl,
  buildAnthropicSystemBlocks,
  isAnthropicServerToolClearingEnabled,
  resolveAnthropicPayloadPolicy,
  resolveAnthropicEphemeralCacheControl,
  resolveAnthropicServerCompactionPlan,
} from "./anthropic-payload-policy.js";

describe("resolveAnthropicEphemeralCacheControl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["https://us-east5-aiplatform.googleapis.com"])(
    "preserves env-configured long retention for the official %s endpoint",
    (baseUrl) => {
      vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");

      expect(resolveAnthropicEphemeralCacheControl(baseUrl, undefined)).toEqual({
        type: "ephemeral",
        ttl: "1h",
      });
    },
  );

  it("keeps env-configured long retention restricted for custom proxy endpoints", () => {
    vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");

    expect(
      resolveAnthropicEphemeralCacheControl("https://proxy.example.test/vertex", undefined),
    ).toEqual({ type: "ephemeral" });
  });
});

describe("Anthropic compaction authentication eligibility", () => {
  const model = { provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000 };
  const extraParams = { anthropicServerCompaction: true };

  it("uses the same host-resolved credential shape as the transport", () => {
    const host = getAiTransportHost();
    configureAiTransportHost({ ...host, resolveSecretSentinel: () => "test-sk-ant-oat-fixture" });
    try {
      expect(
        resolveAnthropicServerCompactionPlan(model, extraParams, "credential-sentinel"),
      ).toEqual({ enabled: false });
    } finally {
      configureAiTransportHost(host);
    }
  });
});

describe("Anthropic server compaction default", () => {
  const direct = {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    contextWindow: 200_000,
  };

  it.each([
    { name: "OAuth credentials", model: direct, apiKey: "test-sk-ant-oat-fixture" },
    { name: "a proxy host", model: { ...direct, baseUrl: "https://proxy.example.test/v1" } },
  ])("stays off for $name", ({ model, apiKey = "test-api-key" }) => {
    expect(resolveAnthropicServerCompactionPlan(model, {}, apiKey)).toEqual({
      enabled: false,
    });
  });

  it("triggers inside a configured input cap", () => {
    expect(
      resolveAnthropicServerCompactionPlan(
        { ...direct, contextWindow: 1_000_000, contextTokens: 200_000 },
        {},
        "test-api-key",
      ),
    ).toEqual({ enabled: true, threshold: 140_000 });
  });
});

describe("Anthropic tool-clearing policy", () => {
  const model = { provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000 };

  it.each(["  "])(
    "requires resolved authentication before disabling client pruning: %j",
    (apiKey) => {
      expect(isAnthropicServerToolClearingEnabled(model, apiKey)).toBe(false);
    },
  );

  it.each([
    {
      tools: { allow: ["look*"], deny: ["exec*"] },
      excluded: ["exec_retired", "other_retired", "search"],
    },
    { tools: { deny: ["exec*"] }, excluded: ["exec_retired"] },
  ])("applies pruning filters to exposed and historical tools: $tools", ({ tools, excluded }) => {
    const payload: Record<string, unknown> = {
      tools: [{ name: "lookup" }, { name: "search" }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "old_exec", name: "exec_retired", input: {} },
            { type: "tool_use", id: "old_other", name: "other_retired", input: {} },
            { type: "tool_use", id: "old_lookup", name: "lookup_retired", input: {} },
          ],
        },
      ],
    };
    const policy = resolveAnthropicPayloadPolicy({
      ...model,
      cacheTtlPruning: { tools },
    });
    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());
    expect(payload.context_management).toEqual({
      edits: [
        expect.objectContaining({
          type: "clear_tool_uses_20250919",
          exclude_tools: excluded,
        }),
      ],
    });
  });
});

describe("Anthropic stable-history cache boundaries", () => {
  type Block = Record<string, unknown>;
  type Wire = { role: "user" | "assistant"; content: string | Block[] };
  const ephemeral = { type: "ephemeral" } as const;

  const user = (text: string): Wire => ({ role: "user", content: [{ type: "text", text }] });
  const assistant = (text: string): Wire => ({
    role: "assistant",
    content: [{ type: "thinking", thinking: `thought ${text}`, signature: "sig" }, textBlock(text)],
  });
  const toolCall = (id: string): Wire => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name: "lookup", input: { id } }],
  });
  const toolResult = (id: string): Wire => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: `result ${id}` }],
  });
  function textBlock(text: string): Block {
    return { type: "text", text };
  }

  function allocate(
    messages: Wire[],
    options: { system?: Block[]; tools?: Block[]; optOut?: number[] } = {},
  ) {
    const payload = {
      system: options.system ?? [],
      tools: options.tools ?? [],
      messages: structuredClone(messages),
    };
    applyAnthropicRequestCacheControl(payload, ephemeral, false, new Set(options.optOut));
    return payload;
  }

  /** Paths such as "m3.1" (message 3, block 1) for every message-level marker. */
  function markerPaths(payload: { messages: Wire[] }): string[] {
    return payload.messages.flatMap((message, i) =>
      Array.isArray(message.content)
        ? message.content.flatMap((block, j) => (block.cache_control ? [`m${i}.${j}`] : []))
        : [],
    );
  }

  // m0 user, m1 assistant, m2 user, m3 assistant, m4 user (newest turn)
  const twoTurns = [
    user("first"),
    assistant("answer one"),
    user("second"),
    assistant("answer two"),
    user("third"),
  ];

  it("marks the end of the assistant message before the newest turn, then the previous one", () => {
    const payload = allocate(twoTurns, {
      system: [{ ...textBlock("s"), cache_control: ephemeral }],
    });
    // limit 3: current boundary (m3 text), previous boundary (m1 text), newest user block.
    expect(markerPaths(payload)).toEqual(["m1.1", "m3.1", "m4.0"]);
  });

  it("spends a two-slot budget on the boundaries instead of the volatile newest turn", () => {
    const payload = allocate(twoTurns, {
      system: [{ ...textBlock("s"), cache_control: ephemeral }],
      tools: [{ name: "lookup", cache_control: ephemeral }],
    });
    expect(markerPaths(payload)).toEqual(["m1.1", "m3.1"]);
  });

  it("treats a runtime-context carrier after the user message as part of the same turn", () => {
    const payload = allocate(
      [
        user("first"),
        user("carrier one"),
        assistant("answer one"),
        user("second"),
        user("carrier two"),
        assistant("answer two"),
        user("third"),
        user("carrier three"),
      ],
      { system: [{ ...textBlock("s"), cache_control: ephemeral }] },
    );
    expect(markerPaths(payload)).toEqual(["m2.1", "m5.1", "m7.0"]);
  });

  it("ignores opted-out carriers when locating turns", () => {
    const messages = [
      user("first"),
      assistant("answer"),
      user("second"),
      toolCall("t1"),
      toolResult("t1"),
      user("ephemeral context"),
    ];
    const payload = allocate(messages, {
      optOut: [5],
      system: [{ ...textBlock("s"), cache_control: ephemeral }],
    });
    // The opted-out message joins the tool result's run but does not start a turn, so the
    // boundary stays before "second" instead of moving to the mid-loop tool call.
    expect(markerPaths(payload)).toEqual(["m1.1", "m2.0", "m4.0"]);
  });

  it("keeps the tool-loop order: tool result, previous checkpoint, then the history boundaries", () => {
    const messages = [...twoTurns, toolCall("t1"), toolResult("t1")];
    const full = allocate(messages);
    expect(markerPaths(full)).toEqual(["m1.1", "m3.1", "m4.0", "m6.0"]);

    const oneSpare = allocate(messages, {
      system: [{ ...textBlock("s"), cache_control: ephemeral }],
      tools: [{ name: "lookup", cache_control: ephemeral }],
    });
    // limit 2: the advancing tool result, then the previous request's checkpoint.
    expect(markerPaths(oneSpare)).toEqual(["m4.0", "m6.0"]);
  });

  it("skips thinking blocks and empty text when choosing the boundary block", () => {
    const messages: Wire[] = [
      user("first"),
      {
        role: "assistant",
        content: [
          textBlock("answer"),
          { type: "thinking", thinking: "late thought", signature: "sig" },
          { type: "redacted_thinking", data: "x" },
          textBlock(""),
        ],
      },
      user("second"),
    ];
    expect(markerPaths(allocate(messages))).toEqual(["m0.0", "m1.0", "m2.0"]);
  });

  it("never places a boundary marker on a compaction block", () => {
    const system = [{ ...textBlock("s"), cache_control: ephemeral }];
    const compaction = { type: "compaction", content: "summary", encrypted_content: "opaque" };
    for (const content of [
      [compaction],
      [compaction, { type: "thinking", thinking: "late thought", signature: "sig" }],
    ]) {
      const messages: Wire[] = [
        user("first"),
        { role: "assistant", content },
        user("second"),
        toolCall("t1"),
        toolResult("t1"),
      ];
      for (const candidate of [messages.slice(0, 3), messages]) {
        const payload = allocate(candidate, { system });
        expect(markerPaths(payload).filter((path) => path.startsWith("m1."))).toEqual([]);
        expect(1 + markerPaths(payload).length).toBeLessThanOrEqual(4);
      }
    }
    // The text after a compaction block remains eligible.
    const withText: Wire[] = [
      user("first"),
      { role: "assistant", content: [compaction, textBlock("answer")] },
      user("second"),
    ];
    expect(markerPaths(allocate(withText))).toEqual(["m0.0", "m1.1", "m2.0"]);
  });

  it("can anchor a tool_use block when the assistant message ends with a tool call", () => {
    const messages = [user("first"), toolCall("t1"), user("second")];
    expect(markerPaths(allocate(messages))).toEqual(["m0.0", "m1.0", "m2.0"]);
  });

  it("never exceeds the four-marker budget, counting OAuth system blocks", () => {
    const system = (buildAnthropicSystemBlocks("stable prompt", true, ephemeral) ?? []).map(
      (block) => Object.fromEntries(Object.entries(block)),
    );
    for (const messages of [twoTurns, [...twoTurns, toolCall("t1"), toolResult("t1")]]) {
      const payload = allocate(messages, {
        system,
        tools: [{ name: "lookup", cache_control: ephemeral }],
      });
      const systemMarkers = system.filter((block) => block.cache_control).length + 1; // + tools
      expect(systemMarkers + markerPaths(payload).length).toBeLessThanOrEqual(4);
      expect(markerPaths(payload).length).toBeGreaterThan(0);
    }
  });

  it("matches the single-turn placement when no earlier turn exists", () => {
    expect(markerPaths(allocate([user("only")]))).toEqual(["m0.0"]);
    const loop = [user("only"), toolCall("t1"), toolResult("t1")];
    expect(markerPaths(allocate(loop))).toEqual(["m0.0", "m2.0"]);
  });

  it("converts a string-content newest user message only when a slot remains", () => {
    const messages: Wire[] = [
      user("first"),
      assistant("answer"),
      { role: "user", content: "plain string" },
    ];
    const roomy = allocate(messages);
    expect(roomy.messages[2]?.content).toEqual([
      { ...textBlock("plain string"), cache_control: ephemeral },
    ]);
    const tight = allocate(messages, {
      system: [
        { ...textBlock("s1"), cache_control: ephemeral },
        { ...textBlock("s2"), cache_control: ephemeral },
        { ...textBlock("s3"), cache_control: ephemeral },
      ],
    });
    expect(tight.messages[2]?.content).toBe("plain string");
    expect(markerPaths(tight)).toEqual(["m1.1"]);
  });

  it("does nothing without a cache_control value or marker budget", () => {
    const payload = {
      system: [textBlock("s")],
      tools: [],
      messages: structuredClone(twoTurns),
    };
    applyAnthropicRequestCacheControl(payload, undefined, false, new Set());
    expect(markerPaths(payload)).toEqual([]);

    const policy = resolveAnthropicPayloadPolicy({
      provider: "openai",
      api: "openai-responses",
      cacheRetention: "short",
      enableCacheControl: false,
    });
    const other = { system: [textBlock("s")], messages: structuredClone(twoTurns) };
    applyAnthropicPayloadPolicyToParams(other, policy, new Set());
    expect(markerPaths(other as { messages: Wire[] })).toEqual([]);
  });

  describe("prompt-cache simulation", () => {
    // Exact-prefix cache: a marker hits when its block, or one of the 19 blocks before it,
    // was written by an earlier request as a marker over an identical prefix. The API collapses
    // consecutive tool_use and tool_result runs into one lookback position each; counting every
    // block is stricter, so it can under-report hits but never over-report them.
    function flatten(payload: { system: Block[]; tools: Block[]; messages: Wire[] }): Block[] {
      return [
        ...payload.tools,
        ...payload.system,
        ...payload.messages.flatMap((message) =>
          typeof message.content === "string" ? [textBlock(message.content)] : message.content,
        ),
      ];
    }
    function prefixKeys(blocks: Block[]): string[] {
      const keys: string[] = [];
      let prefix = "";
      for (const block of blocks) {
        const { cache_control: _ignored, ...rest } = block;
        prefix += JSON.stringify(rest);
        keys.push(prefix);
      }
      return keys;
    }
    function request(written: Set<string>, payload: Parameters<typeof flatten>[0]) {
      const blocks = flatten(payload);
      const keys = prefixKeys(blocks);
      const markers = blocks.flatMap((block, i) => (block.cache_control ? [i] : []));
      let deepestHit = -1;
      for (const marker of markers) {
        for (let i = marker; i >= Math.max(0, marker - 19); i--) {
          if (written.has(keys[i] as string)) {
            deepestHit = Math.max(deepestHit, i);
            break;
          }
        }
      }
      for (const marker of markers) {
        written.add(keys[marker] as string);
      }
      return { deepestHit, markerCount: markers.length };
    }

    // Small deterministic generator keeps the randomized cases reproducible.
    function lcg(seed: number): () => number {
      let state = seed >>> 0;
      return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    }

    function randomTurn(random: () => number, tag: string): Wire[] {
      const turn: Wire[] = [user(`user ${tag}`)];
      if (random() < 0.7) {
        turn.push(user(`carrier ${tag}`));
      }
      const rounds = Math.floor(random() * 4);
      for (let round = 0; round < rounds; round++) {
        const id = `${tag}-${round}`;
        turn.push(toolCall(id), toolResult(id));
      }
      turn.push(assistant(`final ${tag}`));
      return turn;
    }
    // The previous turn is re-rendered between requests; everything before it replays unchanged.
    const rerender = (turn: Wire[]): Wire[] =>
      turn.map((message) =>
        JSON.parse(JSON.stringify(message).replaceAll('"text":"', '"text":"~')),
      );

    it("reads the boundary the previous request wrote, across 200 randomized conversations", () => {
      const random = lcg(7);
      const system = [{ ...textBlock("stable system"), cache_control: ephemeral }];
      for (let n = 0; n < 200; n++) {
        const history = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, t) =>
          randomTurn(random, `h${n}-${t}`),
        );
        const turn = randomTurn(random, `p${n}`);
        const settled = history.flat();
        const written = new Set<string>();

        // Request N: the turn is in progress, so only its user messages and tool rounds exist.
        const inProgress = turn.slice(0, -1);
        const requestN = request(written, allocate([...settled, ...inProgress], { system }));
        // Request N+1: that turn is re-rendered and a new turn begins.
        const requestNext = request(
          written,
          allocate([...settled, ...rerender(turn), user(`next ${n}`), user(`carrier ${n}`)], {
            system,
          }),
        );
        const boundary = flatten({ ...allocate(settled, { system }) }).length - 1;

        expect(requestN.markerCount).toBeLessThanOrEqual(4);
        expect(requestNext.markerCount).toBeLessThanOrEqual(4);
        expect(requestNext.deepestHit).toBeGreaterThanOrEqual(boundary);
      }
    });
  });
});
