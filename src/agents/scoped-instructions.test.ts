import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import type { AgentMessage } from "./runtime/index.js";
import {
  ScopedInstructionDelivery,
  wrapToolsWithScopedInstructions,
} from "./scoped-instructions.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const continuation = { details: { status: "not_executed", reason: "scoped_instructions" } };

describe("scoped instruction delivery through core coding tools", () => {
  let root: string;
  let delivery: ScopedInstructionDelivery;
  let tools: ReturnType<typeof createCoreCodingTools>;
  let transcript: AgentMessage[];
  let queued: AgentMessage[];

  beforeEach(async () => {
    root = await fs.realpath(tempDirs.make("scoped-instructions-"));
    delivery = new ScopedInstructionDelivery();
    transcript = [];
    queued = [];
    delivery.bind(async (content, paths) => {
      queued.push({
        role: "custom",
        customType: "openclaw.scoped-instructions",
        content,
        display: false,
        details: { paths },
        timestamp: 1,
      });
    });
    tools = makeTools(delivery);
    await fs.mkdir(path.join(root, "one"));
    await fs.mkdir(path.join(root, "two"));
  });

  function makeTools(instructionDelivery: ScopedInstructionDelivery) {
    return wrapToolsWithScopedInstructions(
      createCoreCodingTools({
        codingRoot: root,
        containmentRoot: root,
        includeBaseCodingTools: true,
        shellTools: "patch-only",
        workspaceOnly: true,
        readOnly: false,
        applyPatchEnabled: true,
        applyPatchWorkspaceOnly: true,
        execDefaults: {},
        processDefaults: {},
      }),
      instructionDelivery,
      root,
      root,
    );
  }

  const file = (relative: string) => path.join(root, relative);
  async function put(relative: string, text: string) {
    await fs.writeFile(file(relative), text);
  }
  async function call(name: string, args: unknown) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error("Missing tool: " + name);
    }
    return tool.execute("call-" + name, args);
  }
  function modelContext(messages: AgentMessage[] = transcript) {
    transcript = [...messages, ...queued];
    queued = [];
    delivery.observeMessages(transcript);
    return transcript;
  }
  function instructions() {
    return JSON.stringify(modelContext().at(-1));
  }

  it("defers the original mutation without an error, delivers root-to-nearest scope, and requires a new model decision", async () => {
    await put("AGENTS.md", "root fixture guidance");
    await put("one/AGENTS.md", "near fixture guidance");
    await put("two/AGENTS.md", "unrelated sibling guidance");
    const args = { path: "one/new.txt", content: "created after context" };
    await expect(call("write", args)).resolves.toMatchObject(continuation);
    await expect(fs.stat(file("one/new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    // A discarded result or a sequential retry in Code Mode is not a new model request.
    await expect(call("write", args)).resolves.toMatchObject(continuation);
    const history: AgentMessage[] = [{ role: "user", content: "do the task", timestamp: 1 }];
    const next = modelContext(history);
    expect(next.slice(0, -1)).toEqual(history);
    expect(history).toHaveLength(1);
    const text = JSON.stringify(next.at(-1));
    expect(text.indexOf("root fixture guidance")).toBeLessThan(
      text.indexOf("near fixture guidance"),
    );
    expect(text).not.toContain("unrelated sibling guidance");
    expect(text).toContain("do not grant permissions");
    await call("write", args);
    expect(await fs.readFile(file("one/new.txt"), "utf8")).toBe("created after context");
    // The transcript, not the truncated tool result, owns the instructions.
    expect(instructions()).toContain("near fixture guidance");
  });

  it("has no context round trip for a scope without guides and preserves file-tool diagnostics", async () => {
    await call("write", { path: "one/new.txt", content: "plain" });
    expect(modelContext()).toEqual([]);
    const result = await call("read", { path: "one/new.txt" });
    expect(JSON.stringify(result)).toContain("plain");
    await expect(
      call("edit", { path: "one/new.txt", edits: [{ oldText: "missing", newText: "new" }] }),
    ).rejects.toThrow("Could not find the exact text in");
    expect(await fs.readFile(file("one/new.txt"), "utf8")).toBe("plain");
  });

  it("scopes sibling and parallel targets separately without treating caught failures as delivery", async () => {
    await put("one/AGENTS.md", "one-only");
    await put("two/AGENTS.md", "two-only");
    const results = await Promise.all([
      call("write", { path: "one/new.txt", content: "one" }),
      call("write", { path: "two/new.txt", content: "two" }),
    ]);
    for (const result of results) {
      expect(result).toMatchObject(continuation);
    }
    await expect(fs.stat(file("one/new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(file("two/new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const text = JSON.stringify(modelContext());
    expect(text).toContain("## Target: " + file("one/new.txt"));
    expect(text).toContain("## Target: " + file("two/new.txt"));
    for (const [directory, own, sibling] of [
      ["one", "one-only", "two-only"],
      ["two", "two-only", "one-only"],
    ]) {
      const scope = transcript.find((message) =>
        JSON.stringify(message).includes("## Target: " + file(directory + "/new.txt")),
      );
      expect(JSON.stringify(scope)).toContain(own);
      expect(JSON.stringify(scope)).not.toContain(sibling);
    }
    await call("write", { path: "one/new.txt", content: "one" });
    await call("write", { path: "two/new.txt", content: "two" });
    expect(await fs.readFile(file("two/new.txt"), "utf8")).toBe("two");
  });

  it("redelivers changed, added, and removed instructions before editing", async () => {
    await put("AGENTS.md", "first");
    await put("one/existing.txt", "old");
    const args = { path: "one/existing.txt", edits: [{ oldText: "old", newText: "new" }] };
    await expect(call("edit", args)).resolves.toMatchObject(continuation);
    modelContext();
    await put("AGENTS.md", "second");
    await expect(call("edit", args)).resolves.toMatchObject(continuation);
    expect(instructions()).toContain("second");
    await put("one/AGENTS.md", "new nested guide");
    await expect(call("edit", args)).resolves.toMatchObject(continuation);
    expect(instructions()).toContain("new nested guide");
    await fs.unlink(file("one/AGENTS.md"));
    await call("edit", args);
    expect(instructions()).toContain("no longer present");
    expect(await fs.readFile(file("one/existing.txt"), "utf8")).toBe("new");
  });

  it.each(["read", "ls"])(
    "%s completes with guidance without a read/list round trip",
    async (name) => {
      await put("one/AGENTS.md", "readable scope rules");
      await put("one/data.txt", "ordinary result");
      const result = await call(name, { path: name === "read" ? "one/data.txt" : "one" });
      expect(JSON.stringify(result)).toContain(name === "read" ? "ordinary result" : "data.txt");
      expect(result).not.toMatchObject(continuation);
      expect(instructions()).toContain("readable scope rules");
      await call("write", { path: "one/new.txt", content: "no extra continuation" });
      expect(await fs.readFile(file("one/new.txt"), "utf8")).toBe("no extra continuation");
    },
  );

  it("does not inherit another attempt's delivery and invalidates on context replacement", async () => {
    await put("one/AGENTS.md", "remember this scope");
    await call("ls", { path: "one" });
    modelContext();
    const parentDelivery = delivery;
    delivery = new ScopedInstructionDelivery();
    delivery.bind(async () => {});
    tools = makeTools(delivery);
    await expect(call("write", { path: "one/new.txt", content: "new" })).resolves.toMatchObject(
      continuation,
    );
    delivery = parentDelivery;
    tools = makeTools(delivery);
    delivery.clear();
    delivery.observeMessages([]);
    await expect(call("write", { path: "one/new.txt", content: "new" })).resolves.toMatchObject(
      continuation,
    );
    expect(instructions()).toContain("remember this scope");
  });

  it("reports removed guides after resuming persisted context without blocking the operation", async () => {
    await put("one/AGENTS.md", "old scope");
    await call("ls", { path: "one" });
    modelContext();
    await fs.unlink(file("one/AGENTS.md"));
    delivery = new ScopedInstructionDelivery();
    delivery.bind(async (content) => {
      queued.push({ role: "user", content, timestamp: 2 });
    }, transcript);
    tools = makeTools(delivery);
    await call("write", { path: "one/new.txt", content: "current" });
    expect(instructions()).toContain("no longer present");
    expect(await fs.readFile(file("one/new.txt"), "utf8")).toBe("current");
  });

  it("revalidates an empty scope after resuming a summary without guide metadata", async () => {
    const summary: AgentMessage = {
      role: "compactionSummary",
      summary: "Earlier subsystem guidance was summarized here.",
      tokensBefore: 100,
      timestamp: 1,
    };
    delivery.bind(
      async (content) => {
        queued.push({ role: "user", content, timestamp: 2 });
      },
      [summary],
    );
    await call("write", { path: "one/new.txt", content: "data" });
    expect(await fs.readFile(file("one/new.txt"), "utf8")).toBe("data");
    expect(JSON.stringify(modelContext([summary]))).toContain("including when the list is empty");
    await call("write", { path: "one/another.txt", content: "current decision" });
    expect(await fs.readFile(file("one/another.txt"), "utf8")).toBe("current decision");
  });

  it("reblocks when delivered context disappears without trusting a previous acknowledgement", async () => {
    await put("one/AGENTS.md", "scope rules");
    const args = { path: "one/new.txt", content: "new" };
    await expect(call("write", args)).resolves.toMatchObject(continuation);
    modelContext();
    delivery.observeMessages([]);
    await expect(call("write", args)).resolves.toMatchObject(continuation);
    await expect(fs.stat(file("one/new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["unavailable", "failed"])(
    "continues with a warning when context delivery is %s",
    async (kind) => {
      await put("one/AGENTS.md", "scope rules");
      if (kind === "unavailable") {
        delivery = new ScopedInstructionDelivery();
        tools = makeTools(delivery);
      } else {
        delivery.bind(async () => {
          throw new Error("transcript unavailable");
        });
      }
      const result = await call("write", { path: "one/new.txt", content: "new" });
      expect(JSON.stringify(result)).toContain("without confirmed delivery");
      expect(await fs.readFile(file("one/new.txt"), "utf8")).toBe("new");
    },
  );

  it("preserves cancellation before guide discovery or filesystem effects", async () => {
    await put("one/AGENTS.md", "scope rules");
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled fixture"));
    const write = tools.find((tool) => tool.name === "write")!;
    await expect(
      write.execute("cancelled", { path: "one/new.txt", content: "new" }, aborted.signal),
    ).rejects.toThrow("cancelled fixture");
    await expect(fs.stat(file("one/new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(queued).toEqual([]);
  });

  it("discovers from the admitted root when the tool cwd is nested", async () => {
    await put("AGENTS.md", "admitted root guide");
    await put("one/AGENTS.md", "nested guide");
    tools = wrapToolsWithScopedInstructions(
      createCoreCodingTools({
        codingRoot: file("one"),
        containmentRoot: root,
        includeBaseCodingTools: true,
        shellTools: "disabled",
        workspaceOnly: true,
        readOnly: false,
        applyPatchEnabled: false,
        applyPatchWorkspaceOnly: true,
        execDefaults: {},
        processDefaults: {},
      }),
      delivery,
      file("one"),
      root,
    );
    await expect(
      call("write", { path: "../one/new.txt", content: "nested" }),
    ).resolves.toMatchObject(continuation);
    const context = instructions();
    expect(context.indexOf("admitted root guide")).toBeLessThan(context.indexOf("nested guide"));
    await call("write", { path: "new.txt", content: "nested" });
    expect(await fs.readFile(file("one/new.txt"), "utf8")).toBe("nested");
  });

  it("preflights the actual patch envelope, including both move endpoints and deletes", async () => {
    await put("one/AGENTS.md", "source guide");
    await put("two/AGENTS.md", "destination guide");
    await put("one/source.txt", "before\n");
    await put("two/delete.txt", "delete me\n");
    const input = [
      "*** Begin Patch",
      "*** Update File: one/source.txt",
      "*** Move to: two/moved.txt",
      "@@",
      "-before",
      "+after",
      "*** Delete File: two/delete.txt",
      "*** Add File: one/added.txt",
      "+added",
      "*** End Patch",
    ].join("\n");
    await expect(call("apply_patch", { input })).resolves.toMatchObject(continuation);
    expect(await fs.readFile(file("one/source.txt"), "utf8")).toBe("before\n");
    expect(await fs.readFile(file("two/delete.txt"), "utf8")).toBe("delete me\n");
    const text = instructions();
    expect(text).toContain("source guide");
    expect(text).toContain("destination guide");
    await call("apply_patch", { input });
    expect(await fs.readFile(file("two/moved.txt"), "utf8")).toBe("after\n");
    expect(await fs.readFile(file("one/added.txt"), "utf8")).toBe("added\n");
    await expect(fs.stat(file("two/delete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(file("one/source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(call("apply_patch", { input: "invalid" })).rejects.toThrow("first line");
  });

  it("resolves literal @ patch paths before selecting scoped instructions", async () => {
    await fs.mkdir(file("@one"));
    await put("@one/AGENTS.md", "literal directory guidance");
    await put("one/AGENTS.md", "different reference directory guidance");
    const input = "*** Begin Patch\n*** Add File: @one/new.txt\n+data\n*** End Patch";
    await expect(call("apply_patch", { input })).resolves.toMatchObject(continuation);
    const text = instructions();
    expect(text).toContain("literal directory guidance");
    expect(text).not.toContain("different reference directory guidance");
    await call("apply_patch", { input });
    expect(await fs.readFile(file("@one/new.txt"), "utf8")).toBe("data\n");
    await expect(fs.stat(file("one/new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps mixed guide/code patches intact using the starting instruction snapshot", async () => {
    const input =
      "*** Begin Patch\n*** Add File: one/AGENTS.md\n+first rules\n*** Add File: one/new.txt\n+data\n*** End Patch";
    await call("apply_patch", { input });
    expect(await fs.readFile(file("one/AGENTS.md"), "utf8")).toBe("first rules\n");
    expect(await fs.readFile(file("one/new.txt"), "utf8")).toBe("data\n");
    expect(queued).toEqual([]);
    const update =
      "*** Begin Patch\n*** Update File: one/AGENTS.md\n@@\n-first rules\n+second rules\n*** Update File: one/new.txt\n@@\n-data\n+updated\n*** End Patch";
    await expect(call("apply_patch", { input: update })).resolves.toMatchObject(continuation);
    expect(instructions()).toContain("first rules");
    await call("apply_patch", { input: update });
    expect(await fs.readFile(file("one/AGENTS.md"), "utf8")).toBe("second rules\n");
    expect(await fs.readFile(file("one/new.txt"), "utf8")).toBe("updated\n");
    await expect(call("write", { path: "one/next.txt", content: "next" })).resolves.toMatchObject(
      continuation,
    );
    expect(instructions()).toContain("second rules");
    await call("write", { path: "one/next.txt", content: "next" });
    expect(await fs.readFile(file("one/next.txt"), "utf8")).toBe("next");
  });

  it.skipIf(process.platform === "win32")(
    "uses canonical target scopes and never loads escaping guide symlinks",
    async () => {
      await put("one/AGENTS.md", "canonical directory rules");
      await fs.symlink(file("one"), file("alias"), "dir");
      await expect(
        call("write", { path: "alias/new.txt", content: "data" }),
      ).resolves.toMatchObject(continuation);
      expect(instructions()).toContain("canonical directory rules");
      await call("write", { path: "alias/new.txt", content: "data" });
      expect(await fs.readFile(file("one/new.txt"), "utf8")).toBe("data");
      const outside = tempDirs.make("outside-scoped-instructions-");
      await fs.writeFile(path.join(outside, "AGENTS.md"), "untrusted outside guidance");
      await fs.symlink(path.join(outside, "AGENTS.md"), file("two/AGENTS.md"));
      const result = await call("write", { path: "two/new.txt", content: "allowed" });
      expect(JSON.stringify(result)).toContain("No complete delivery is claimed");
      expect(instructions()).not.toContain("untrusted outside guidance");
      expect(await fs.readFile(file("two/new.txt"), "utf8")).toBe("allowed");
      await expect(
        call("write", { path: path.join(outside, "new.txt"), content: "blocked" }),
      ).rejects.toThrow();
      await expect(fs.stat(path.join(outside, "new.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each([
    "directory",
    "oversized",
    "reader-budget",
    ...(process.platform === "win32" ? [] : ["unreadable", "broken-symlink"]),
  ])("warns without disabling file operations when a guide is %s", async (kind) => {
    if (kind === "directory") {
      await fs.mkdir(file("one/AGENTS.md"));
    } else if (kind === "oversized") {
      await put("one/AGENTS.md", "x".repeat(128 * 1024 + 1));
    } else if (kind === "reader-budget") {
      await put("one/AGENTS.md", "long line ".repeat(9000));
    } else if (kind === "unreadable") {
      await put("one/AGENTS.md", "rules that filesystem permissions make unavailable");
      await fs.chmod(file("one/AGENTS.md"), 0);
    } else {
      await fs.symlink(file("missing-guide"), file("one/AGENTS.md"));
    }
    const result = await call("write", { path: "one/new.txt", content: "allowed" });
    const text = JSON.stringify(result);
    expect(text).toContain("No complete delivery is claimed");
    expect(text.length).toBeLessThan(2000);
    expect(await fs.readFile(file("one/new.txt"), "utf8")).toBe("allowed");
    expect(instructions()).toContain("any previous content is not current");
  });
  it.each(["read-policy", "read-disabled"])(
    "does not bypass %s for automatic guide reads",
    async (mode) => {
      const { createOpenClawCodingToolsInternal } = await import("./agent-tools.js");
      const { createEmptyPluginRegistry } = await import("../plugins/registry.js");
      const { setActivePluginRegistry } = await import("../plugins/runtime.js");
      const { initializeGlobalHookRunner, resetGlobalHookRunner } =
        await import("../plugins/hook-runner-global.js");
      await put("one/AGENTS.md", "GUIDANCE_MUST_NOT_BYPASS_READ_POLICY");
      const registry = createEmptyPluginRegistry();
      registry.trustedToolPolicies = [
        {
          pluginId: "scoped-read-policy-fixture",
          source: "test",
          policy: {
            id: "deny-guide-read",
            description: "Read-policy regression fixture",
            evaluate: (event) =>
              event.toolName === "read"
                ? { block: true, blockReason: "Guide read denied" }
                : undefined,
          },
        },
      ];
      setActivePluginRegistry(registry);
      initializeGlobalHookRunner(registry);
      try {
        tools = wrapToolsWithScopedInstructions(
          createOpenClawCodingToolsInternal({
            workspaceDir: root,
            config: {
              tools: {
                fs: { workspaceOnly: true },
                ...(mode === "read-disabled" ? { deny: ["read"] } : {}),
              },
            },
            toolConstructionPlan: {
              includeBaseCodingTools: true,
              includeShellTools: false,
              includeChannelTools: false,
              includeOpenClawTools: false,
              includePluginTools: false,
            },
          }),
          delivery,
          root,
          root,
        );
        const result = await call("write", {
          path: "one/new.txt",
          content: "normal write remains available",
        });
        expect(JSON.stringify(result)).toContain("No complete delivery is claimed");
        expect(await fs.readFile(file("one/new.txt"), "utf8")).toBe(
          "normal write remains available",
        );
        expect(instructions()).not.toContain("GUIDANCE_MUST_NOT_BYPASS_READ_POLICY");
        if (mode === "read-policy") {
          await expect(call("read", { path: "one/AGENTS.md" })).resolves.toMatchObject({
            details: { status: "blocked" },
          });
        } else {
          expect(tools.some((tool) => tool.name === "read")).toBe(false);
        }
      } finally {
        resetGlobalHookRunner();
        setActivePluginRegistry(createEmptyPluginRegistry());
      }
    },
  );
});
