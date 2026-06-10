import { describe, expect, it } from "vitest";
import { classifyRequest, type ClassifyState } from "./mitm-server.js";

// classifyRequest decides whether a /v1/messages stream's `end_turn` should end
// the user-facing turn (primary) or be neutralized (sub-agent). It is the
// hardened replacement for the old single-`Agent`-tool heuristic: a layered,
// first-decisive-layer-wins classifier that (a) positively identifies the
// primary by a configurable+structural spawner-tool match, (b) keeps the
// web-search sub-agent catch, (c) gates the by-absence rule so a run that never
// shows a spawner can't mis-suppress its primary into a hang. These cases lock
// that behaviour in (the old logic shipped with no test — the durable cure).

const fresh = (): ClassifyState => ({ primarySpawnerSeen: false });
const body = (o: unknown): string => JSON.stringify(o);
const userMsg = { role: "user", content: "hi" };

describe("classifyRequest", () => {
  it("tags a primary turn (carries the Agent spawner) as normal and records the spawner", () => {
    const s = fresh();
    expect(
      classifyRequest(
        body({ tools: [{ name: "Agent" }, { name: "Read" }], messages: [userMsg] }),
        s,
      ),
    ).toBe("normal");
    expect(s.primarySpawnerSeen).toBe(true);
  });

  it("treats a RENAMED/disguised spawner (TaskCreate, dispatch_agent) as primary", () => {
    expect(
      classifyRequest(
        body({ tools: [{ name: "TaskCreate" }, { name: "Read" }], messages: [userMsg] }),
        fresh(),
      ),
    ).toBe("normal");
    expect(
      classifyRequest(body({ tools: [{ name: "dispatch_agent" }], messages: [userMsg] }), fresh()),
    ).toBe("normal");
  });

  it("tags an Agent-less tool-bearing request as subagent once a spawner has been seen", () => {
    const s = fresh();
    classifyRequest(body({ tools: [{ name: "Agent" }], messages: [userMsg] }), s);
    expect(
      classifyRequest(
        body({
          tools: [{ name: "Read" }, { name: "Grep" }, { name: "Bash" }, { name: "Glob" }],
          messages: [userMsg],
        }),
        s,
      ),
    ).toBe("subagent");
  });

  it("keeps an Agent-less request as primary when NO spawner was ever seen (no-hang guard)", () => {
    expect(
      classifyRequest(
        body({ tools: [{ name: "Read" }, { name: "Grep" }], messages: [userMsg] }),
        fresh(),
      ),
    ).toBe("normal");
  });

  it("tags a web_search sub-agent as subagent independent of spawner state", () => {
    expect(
      classifyRequest(
        body({ tools: [{ type: "web_search_20250305", name: "web_search" }], messages: [userMsg] }),
        fresh(),
      ),
    ).toBe("subagent");
  });

  it("keeps a primary that itself requests web_search as normal (bounded-count guard)", () => {
    expect(
      classifyRequest(
        body({
          tools: [
            { name: "Agent" },
            { type: "web_search_20250305" },
            { name: "Read" },
            { name: "Bash" },
          ],
          messages: [userMsg],
        }),
        fresh(),
      ),
    ).toBe("normal");
  });

  it("keeps a max_tokens retry of the primary as primary (spawner still present)", () => {
    const s = fresh();
    const b = body({ tools: [{ name: "Agent" }, { name: "Read" }], messages: [userMsg] });
    classifyRequest(b, s);
    expect(classifyRequest(b, s)).toBe("normal");
  });

  it("detects compaction by the summarize-prompt markers", () => {
    expect(
      classifyRequest(
        body({
          tools: [{ name: "Read" }],
          messages: [
            {
              role: "user",
              content:
                "Your summary should include the following sections. Provide a detailed summary.",
            },
          ],
        }),
        fresh(),
      ),
    ).toBe("compaction");
  });

  it("classifies a tool-less request as auxiliary", () => {
    expect(classifyRequest(body({ messages: [userMsg] }), fresh())).toBe("auxiliary");
  });

  it("classifies a tool_result-bearing request as tool_followup", () => {
    expect(
      classifyRequest(
        body({
          tools: [{ name: "Agent" }],
          messages: [
            { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
          ],
        }),
        fresh(),
      ),
    ).toBe("tool_followup");
  });

  it("tags a sub-agent via the guarded system-prompt fingerprint when markers are supplied", () => {
    expect(
      classifyRequest(
        body({
          tools: [{ name: "Read" }],
          system: "You are a sub-agent launched to research.",
          messages: [userMsg],
        }),
        fresh(),
        { subagentSystemMarkers: ["You are a sub-agent"] },
      ),
    ).toBe("subagent");
  });

  it("falls back to normal on a non-JSON body", () => {
    expect(classifyRequest("not json", fresh())).toBe("normal");
  });
});
