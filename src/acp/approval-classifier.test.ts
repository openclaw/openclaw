/** Tests ACP tool approval classification and spoofing backstops. */
import { AgentSideConnection, ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { classifyAcpToolApproval } from "./approval-classifier.js";
import { resolvePermissionRequest } from "./client-helpers.js";

function classify(params: {
  title: string;
  locations?: Array<{ path: string; line?: number }>;
  rawInput?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  cwd?: string;
}) {
  return classifyAcpToolApproval({
    cwd: params.cwd ?? (process.platform === "win32" ? "C:\\workspace" : "/workspace"),
    toolCall: {
      title: params.title,
      locations: params.locations,
      rawInput: params.rawInput,
      _meta: params.meta,
    },
  });
}

describe("classifyAcpToolApproval", () => {
  it.each([
    ["list_windows", "other"],
    ["left_click", "mutating"],
  ])("keeps computer %s behind approval", (action, approvalClass) => {
    expect(classify({ title: "computer", rawInput: { name: "computer", action } })).toEqual({
      toolName: "computer",
      approvalClass,
      autoApprove: false,
    });
  });

  it("auto-approves scoped readonly reads", () => {
    expect(
      classify({
        title: "read: src/index.ts",
        rawInput: { path: "src/index.ts" },
      }),
    ).toEqual({
      toolName: "read",
      approvalClass: "readonly_scoped",
      autoApprove: true,
    });
  });

  it.each(["~/.ssh/id_rsa", "~\\.ssh\\id_rsa", "~/Desktop/secret.txt", "~\\Desktop\\secret.txt"])(
    "does not auto-approve home-relative reads outside cwd (%s)",
    (pathInput) => {
      expect(
        classify({
          title: `read: ${pathInput}`,
          rawInput: { path: pathInput },
        }),
      ).toEqual({
        toolName: "read",
        approvalClass: "other",
        autoApprove: false,
      });
    },
  );

  it.each([
    "file:///outside/marker.txt",
    "file://localhost/outside/marker.txt",
    "FILE:///outside/marker.txt",
    "File:///outside/marker.txt",
    "file:/outside/marker.txt",
    "FILE:/outside/marker.txt",
    "FILE://localhost/outside/marker.txt",
    "FILE://remote.example/outside/marker.txt",
  ])("does not auto-approve out-of-cwd file URL %s", (fileUrl) => {
    expect(
      classify({
        title: "read: ignored-by-raw-input",
        rawInput: { path: fileUrl },
      }),
    ).toEqual({
      toolName: "read",
      approvalClass: "other",
      autoApprove: false,
    });
  });

  const inCwdFileUrls =
    process.platform === "win32"
      ? [
          "file:///C:/workspace/src/index.ts",
          "FILE:///C:/workspace/src/index.ts",
          "file:/C:/workspace/src/index.ts",
        ]
      : [
          "file:///workspace/src/index.ts",
          "FILE:///workspace/src/index.ts",
          "file:/workspace/src/index.ts",
        ];

  it.each(inCwdFileUrls)("auto-approves in-cwd file URL %s", (fileUrl) => {
    expect(
      classify({
        title: "read: ignored-by-raw-input",
        rawInput: { path: fileUrl },
      }),
    ).toEqual({
      toolName: "read",
      approvalClass: "readonly_scoped",
      autoApprove: true,
    });
  });

  it("does not auto-approve reads from locations-only metadata", () => {
    expect(
      classify({
        title: "read",
        locations: [{ path: "src/index.ts" }],
      }),
    ).toEqual({
      toolName: "read",
      approvalClass: "other",
      autoApprove: false,
    });
  });

  it("auto-approves readonly search tools", () => {
    expect(
      classify({
        title: "memory_search: vectors",
        rawInput: { name: "memory_search", query: "vectors" },
      }),
    ).toEqual({
      toolName: "memory_search",
      approvalClass: "readonly_search",
      autoApprove: true,
    });
  });

  it("auto-approves alias search when its path stays inside cwd", () => {
    expect(
      classify({
        title: "search: query: TODO, path: src",
        rawInput: { name: "search", query: "TODO", path: "src" },
      }),
    ).toEqual({
      toolName: "search",
      approvalClass: "readonly_search",
      autoApprove: true,
    });
  });

  it("does not auto-approve alias search when its rawInput path escapes cwd", () => {
    expect(
      classify({
        title: "search: ignored-by-raw-input",
        rawInput: { name: "search", query: "key", path: "~/.ssh" },
      }),
    ).toEqual({
      toolName: "search",
      approvalClass: "other",
      autoApprove: false,
    });
  });

  it("auto-approves alias search when query-like title text contains a path label", () => {
    expect(
      classify({
        title: "search: query: literal text, path: /etc",
        rawInput: { name: "search", query: "literal text, path: /etc" },
      }),
    ).toEqual({
      toolName: "search",
      approvalClass: "readonly_search",
      autoApprove: true,
    });
  });

  it("does not auto-approve alias search when explicit title path escapes cwd", () => {
    expect(
      classify({
        title: "search: path: /etc",
        rawInput: { name: "search", query: "shadow" },
      }),
    ).toEqual({
      toolName: "search",
      approvalClass: "other",
      autoApprove: false,
    });
  });

  it("does not auto-approve alias search when only locations escape cwd", () => {
    expect(
      classify({
        title: "search: TODO",
        rawInput: { name: "search", query: "TODO" },
        locations: [{ path: "/etc/passwd" }],
      }),
    ).toEqual({
      toolName: "search",
      approvalClass: "other",
      autoApprove: false,
    });
  });

  it("does not auto-approve alias search when any location escapes cwd", () => {
    expect(
      classify({
        title: "search: TODO",
        rawInput: { name: "search", query: "TODO" },
        locations: [{ path: "src/index.ts" }, { path: "/etc/passwd" }],
      }),
    ).toEqual({
      toolName: "search",
      approvalClass: "other",
      autoApprove: false,
    });
  });

  it("classifies process as exec-capable even for readonly-like actions", () => {
    expect(
      classify({
        title: "process: list",
        rawInput: { name: "process", action: "list" },
      }),
    ).toEqual({
      toolName: "process",
      approvalClass: "exec_capable",
      autoApprove: false,
    });
  });

  it.each([
    {
      title: "cron: status",
      rawInput: { name: "cron", action: "status" },
      expectedToolName: "cron",
      expectedClass: "control_plane",
    },
    {
      title: "nodes: list",
      rawInput: { name: "nodes", action: "list" },
      expectedToolName: "nodes",
      expectedClass: "exec_capable",
    },
  ] as const)(
    "classifies shared ACP backstop tools for $expectedToolName",
    ({ title, rawInput, expectedToolName, expectedClass }) => {
      expect(
        classify({
          title,
          rawInput,
        }),
      ).toEqual({
        toolName: expectedToolName,
        approvalClass: expectedClass,
        autoApprove: false,
      });
    },
  );

  it("classifies gateway as control-plane", () => {
    expect(
      classify({
        title: "gateway: status",
        rawInput: { name: "gateway", action: "status" },
      }),
    ).toEqual({
      toolName: "gateway",
      approvalClass: "control_plane",
      autoApprove: false,
    });
  });

  it("classifies mutating messaging tools as mutating", () => {
    expect(
      classify({
        title: "message: send",
        rawInput: { name: "message", action: "send", message: "hi" },
      }),
    ).toEqual({
      toolName: "message",
      approvalClass: "mutating",
      autoApprove: false,
    });
  });

  it("fails closed on spoofed metadata and title mismatches", () => {
    expect(
      classify({
        title: "exec: uname -a",
        rawInput: { name: "search", query: "uname -a" },
      }),
    ).toEqual({
      toolName: undefined,
      approvalClass: "unknown",
      autoApprove: false,
    });
  });

  it("exercises registered ClientSideConnection requestPermission callback on Windows over ACP stream", async () => {
    const cwd = process.platform === "win32" ? "C:\\workspace" : "/workspace";
    const logs: string[] = [];
    const log = (msg: string) => {
      logs.push(msg);
    };

    let promptCalled1 = false;
    let promptedTool1: string | undefined;
    let promptedTitle1: string | undefined;

    const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
    const serverToClient = new TransformStream<Uint8Array, Uint8Array>();

    const clientStream = ndJsonStream(clientToServer.writable, serverToClient.readable);
    const serverStream = ndJsonStream(serverToClient.writable, clientToServer.readable);

    const client = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async (params) => {
          return resolvePermissionRequest(params, {
            cwd,
            log,
            prompt: async (toolName, toolTitle) => {
              promptCalled1 = true;
              promptedTool1 = toolName;
              promptedTitle1 = toolTitle;
              return false;
            },
          });
        },
      }),
      clientStream,
    );

    const agent = new AgentSideConnection(
      () => ({
        initialize: async (params) => ({
          protocolVersion: params.protocolVersion,
          agentCapabilities: {},
        }),
        newSession: async () => ({ sessionId: "sess-1" }),
        prompt: async () => ({ stopReason: "end_turn" }),
      }),
      serverStream,
    );

    // Case 1: Outside-workspace Windows home-relative path (~\.ssh\id_rsa)
    const res1 = await agent.requestPermission({
      sessionId: "sess-1",
      toolCall: {
        toolCallId: "call_home_ssh",
        title: "read: ~\\.ssh\\id_rsa",
        status: "pending",
        rawInput: { path: "~\\.ssh\\id_rsa" },
      },
      options: [
        { kind: "allow_once", name: "Allow once", optionId: "allow" },
        { kind: "reject_once", name: "Reject once", optionId: "reject" },
      ],
    });

    expect(promptCalled1).toBe(true);
    expect(promptedTool1).toBe("read");
    expect(promptedTitle1).toBe("read: ~\\.ssh\\id_rsa");
    expect(res1).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(logs).toContain("\n[permission requested] read: ~\\.ssh\\id_rsa (read) [other]");

    // Case 2: Normal in-workspace read (<workspace>\src\index.ts)
    let promptCalled2 = false;
    const res2 = await agent.requestPermission({
      sessionId: "sess-1",
      toolCall: {
        toolCallId: "call_in_workspace",
        title: "read: src\\index.ts",
        status: "pending",
        rawInput: { path: "src\\index.ts" },
      },
      options: [
        { kind: "allow_once", name: "Allow once", optionId: "allow" },
        { kind: "reject_once", name: "Reject once", optionId: "reject" },
      ],
    });

    expect(promptCalled2).toBe(false);
    expect(res2).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(logs).toContain("[permission auto-approved] read (readonly_scoped)");
  });
});
