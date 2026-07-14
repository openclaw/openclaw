import { describe, expect, it } from "vitest";
import {
  applyChatDelta,
  applyToolBoundary,
  buildTabPreamble,
  createChatStream,
  deriveTabSessionKey,
  friendlyToolName,
  gatewayUrlFromRelayUrl,
  isLoopbackUrl,
  renderMarkdownLite,
  resetChatStream,
} from "./panel-core.js";

describe("deriveTabSessionKey", () => {
  it("threads the tab off the agent main key", () => {
    expect(deriveTabSessionKey("agent:main:main", 42)).toBe("agent:main:main:thread:tab-42");
  });

  it("strips an existing :thread: suffix before threading", () => {
    expect(deriveTabSessionKey("agent:main:main:thread:xyz", 7)).toBe(
      "agent:main:main:thread:tab-7",
    );
  });

  it("appends a generation suffix for fresh chats on the same tab", () => {
    expect(deriveTabSessionKey("agent:main:main", 7, 2)).toBe("agent:main:main:thread:tab-7-g2");
    expect(deriveTabSessionKey("agent:main:main", 7, 0)).toBe("agent:main:main:thread:tab-7");
  });

  it("returns null without a main key or tab id", () => {
    expect(deriveTabSessionKey(null, 7)).toBeNull();
    expect(deriveTabSessionKey("", 7)).toBeNull();
    expect(deriveTabSessionKey("agent:main:main", undefined)).toBeNull();
  });
});

describe("applyChatDelta", () => {
  const delta = (overrides: Record<string, unknown>) => ({ runId: "r1", ...overrides });

  it("accumulates incremental deltaText", () => {
    const stream = createChatStream();
    expect(applyChatDelta(stream, delta({ deltaText: "Hello" }))).toEqual({
      segmentText: "Hello",
      newBubble: true,
    });
    expect(applyChatDelta(stream, delta({ deltaText: " world" }))).toEqual({
      segmentText: "Hello world",
      newBubble: false,
    });
  });

  it("prefers the authoritative cumulative snapshot over deltaText", () => {
    const stream = createChatStream();
    applyChatDelta(stream, delta({ deltaText: "Hel" }));
    const result = applyChatDelta(
      stream,
      delta({ deltaText: "ignored", message: { content: [{ text: "Hello there" }] } }),
    );
    expect(result).toEqual({ segmentText: "Hello there", newBubble: false });
  });

  it("re-flushed cumulative snapshots cannot duplicate text", () => {
    const stream = createChatStream();
    applyChatDelta(stream, delta({ message: { content: [{ text: "Hello world" }] } }));
    const result = applyChatDelta(
      stream,
      delta({ message: { content: [{ text: "Hello world" }] } }),
    );
    expect(result).toEqual({ segmentText: "Hello world", newBubble: false });
  });

  it("replace=true swaps the full buffer", () => {
    const stream = createChatStream();
    applyChatDelta(stream, delta({ deltaText: "draft one" }));
    const result = applyChatDelta(stream, delta({ deltaText: "final text", replace: true }));
    expect(result).toEqual({ segmentText: "final text", newBubble: true });
  });

  it("a new runId starts a fresh bubble and clears prior state", () => {
    const stream = createChatStream();
    applyChatDelta(stream, delta({ deltaText: "old run" }));
    const result = applyChatDelta(stream, { runId: "r2", deltaText: "new run" });
    expect(result).toEqual({ segmentText: "new run", newBubble: true });
  });

  it("tool boundaries segment post-tool commentary into a new bubble", () => {
    const stream = createChatStream();
    applyChatDelta(stream, delta({ deltaText: "Let me check." }));
    applyToolBoundary(stream);
    const result = applyChatDelta(stream, delta({ deltaText: " Done: it works." }));
    expect(result).toEqual({ segmentText: " Done: it works.", newBubble: false });
  });

  it("rebases onto a buffer reset that continues the current segment", () => {
    const stream = createChatStream();
    applyChatDelta(stream, delta({ deltaText: "Intro." }));
    applyToolBoundary(stream);
    applyChatDelta(stream, delta({ deltaText: "After tool" }));
    // Gateway restarts its buffer at the current segment (non-prefix vs the
    // old full text, but a continuation of what this bubble already shows).
    const result = applyChatDelta(
      stream,
      delta({ message: { content: [{ text: "After tool, more" }] }, deltaText: ", more" }),
    );
    expect(result).toEqual({ segmentText: "After tool, more", newBubble: false });
  });

  it("returns null when there is nothing to render", () => {
    const stream = createChatStream();
    expect(applyChatDelta(stream, delta({ deltaText: "" }))).toBeNull();
    expect(applyChatDelta(stream, null)).toBeNull();
  });

  it("resetChatStream clears run state", () => {
    const stream = createChatStream();
    applyChatDelta(stream, delta({ deltaText: "text" }));
    resetChatStream(stream);
    expect(stream).toEqual({ runId: null, full: "", segStart: 0 });
  });
});

describe("renderMarkdownLite", () => {
  it("escapes HTML before rendering markdown", () => {
    expect(renderMarkdownLite('<img src="x">')).toBe('&lt;img src="x"&gt;');
  });

  it("renders code blocks, inline code, bold, and line breaks", () => {
    expect(renderMarkdownLite("```js\ncode\n```")).toBe("<pre>js\ncode</pre>");
    expect(renderMarkdownLite("a `b` **c**\nd")).toBe("a <code>b</code> <strong>c</strong><br>d");
  });

  it("keeps newlines inside fenced blocks while breaking outside text", () => {
    expect(renderMarkdownLite("before\n```a\nb```\nafter")).toBe(
      "before<br><pre>a\nb</pre><br>after",
    );
  });

  it("fenced-block placeholder cannot collide with user text", () => {
    expect(renderMarkdownLite("gap 0 text ```c```")).toBe("gap 0 text <pre>c</pre>");
    expect(renderMarkdownLite("<F0> ```x```")).toBe("&lt;F0&gt; <pre>x</pre>");
  });
});

describe("friendlyToolName", () => {
  it("strips MCP prefixes and underscores", () => {
    expect(friendlyToolName("mcp__openclaw__browser_click")).toBe("browser click");
    expect(friendlyToolName("mcp__other__do_thing")).toBe("do thing");
    expect(friendlyToolName("")).toBe("tool");
  });
});

describe("isLoopbackUrl", () => {
  it("accepts loopback hosts and rejects remote ones", () => {
    expect(isLoopbackUrl("http://127.0.0.1:18789")).toBe(true);
    expect(isLoopbackUrl("ws://localhost/")).toBe(true);
    expect(isLoopbackUrl("wss://[::1]:1234/x")).toBe(true);
    expect(isLoopbackUrl("wss://gateway.example.ts.net")).toBe(false);
  });
});

describe("gatewayUrlFromRelayUrl", () => {
  it("derives the gateway origin from a gateway-hosted relay URL", () => {
    expect(gatewayUrlFromRelayUrl("wss://gw.example.com/browser/extension")).toBe(
      "wss://gw.example.com",
    );
  });

  it("returns null for loopback relay ports and malformed input", () => {
    expect(gatewayUrlFromRelayUrl("ws://127.0.0.1:18797/extension")).toBeNull();
    expect(gatewayUrlFromRelayUrl("http://gw.example.com/browser/extension")).toBeNull();
    expect(gatewayUrlFromRelayUrl("not a url")).toBeNull();
  });
});

describe("buildTabPreamble", () => {
  it("names the pinned tab and forbids re-navigation", () => {
    const preamble = buildTabPreamble("https://example.com/form", "Example Form");
    expect(preamble).toContain("https://example.com/form (Example Form)");
    expect(preamble).toContain("do NOT re-navigate");
    expect(preamble.endsWith("\n\n")).toBe(true);
  });

  it("is empty without a URL", () => {
    expect(buildTabPreamble("", "t")).toBe("");
  });
});
