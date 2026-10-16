// OC Path tests cover edit plugin behavior.
import { describe, expect, it } from "vitest";
import { setJsoncOcPath } from "../../jsonc/edit.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { parseOcPath } from "../../oc-path.js";

describe("setJsoncOcPath — value replacement", () => {
  const config = `{
  "plugins": {
    "entries": {
      "github": {
        "token": "old"
      }
    }
  }
}`;

  it("replaces nested objects", () => {
    const { ast } = parseJsonc(config);
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/plugins.entries"), {
      kind: "object",
      entries: [{ key: "gitlab", line: 0, value: { kind: "string", value: "tok" } }],
    });
    expect(JSON.parse(r.raw)).toEqual({
      plugins: { entries: { gitlab: "tok" } },
    });
  });

  it("reports no-root on empty AST", () => {
    const { ast } = parseJsonc("");
    expect(() =>
      setJsoncOcPath(ast, parseOcPath("oc://config/x"), {
        kind: "string",
        value: "y",
      }),
    ).toThrow(expect.objectContaining({ reason: "no-root" }));
  });
});

describe("setJsoncOcPath — $last positional", () => {
  it("edits the last array element via $last", () => {
    const { ast } = parseJsonc('{ "items": [10, 20, 30] }');
    const r = setJsoncOcPath(ast, parseOcPath("oc://config.jsonc/items/$last"), {
      kind: "number",
      value: 99,
    });
    expect(JSON.parse(r.raw)).toEqual({ items: [10, 20, 99] });
  });

  it("reports unresolved for $last against an empty array", () => {
    const { ast } = parseJsonc('{ "items": [] }');
    expect(() =>
      setJsoncOcPath(ast, parseOcPath("oc://config.jsonc/items/$last"), {
        kind: "number",
        value: 99,
      }),
    ).toThrow(expect.objectContaining({ reason: "unresolved" }));
  });
});

describe("setJsoncOcPath — quoted segments (regression: resolve↔edit symmetry)", () => {
  it("edits a key containing slashes via quoted segment", () => {
    // The provider/model alias key contains a `/`; without quoting
    // it would be split as two segments. `resolveJsoncOcPath` handles
    // this; `setJsoncOcPath` MUST handle it the same way or the path
    // becomes resolve-only. Closes ClawSweeper P2 on PR #78678.
    const raw = `{
  "agents": {
    "defaults": {
      "models": {
        "anthropic/claude-opus-4-7": { "alias": "opus" }
      }
    }
  }
}
`;
    const { ast } = parseJsonc(raw);
    const before = JSON.stringify(ast);
    const r = setJsoncOcPath(
      ast,
      parseOcPath('oc://config.jsonc/agents.defaults.models/"anthropic/claude-opus-4-7"/alias'),
      { kind: "string", value: "big-opus" },
    );
    expect(JSON.stringify(ast)).toBe(before);
    expect(JSON.parse(r.raw)).toEqual({
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-7": { alias: "big-opus" },
          },
        },
      },
    });
  });
});
