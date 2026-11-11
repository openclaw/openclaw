import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, symlink, link } from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it } from "vitest";
import { ATTACHMENT_CHUNK_BYTES } from "./attachment-contract.js";
import { attachWorkspaceFile } from "./attachment-file.js";
import plugin from "./index.js";
import { createKnowledgeService } from "./service.js";
import {
  apiFor,
  createVault,
  sessionActions,
  toolContext,
  useTestTempDirs,
} from "./test-support.js";

const dirs = useTestTempDirs();

// Register the production tool adapter with an isolated store and host workspace.
async function fixture() {
  const base = dirs.make("knowledge-attach-file-");
  const { root, config } = await createVault(base);
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  const api = apiFor(base, config);
  const factories = new Map<string, OpenClawPluginToolFactory>();
  plugin.register({
    ...api,
    id: "knowledge",
    session: {
      ...api.session,
      controls: { ...api.session?.controls, ...sessionActions().session.controls },
    },
    registerTool(factory, options) {
      if (typeof factory === "function" && options?.name) {
        factories.set(options.name, factory);
      }
    },
  });
  const context = {
    workspaceDir: workspace,
    fsPolicy: { workspaceOnly: true },
    agentId: "main",
    sessionId: randomUUID(),
    sessionKey: "agent:main:attach-file",
    memoryAudience: { kind: "owner-private" as const, agentId: "main" },
    assertInvocationCurrent() {},
    assertMemoryAudienceCurrent() {},
  };
  const bytes = Buffer.concat([
    Buffer.from("Original 🌱 transcript\n".repeat(6000)),
    Buffer.from([0, 255, 128]),
  ]);
  const filePath = path.join(workspace, "source.bin");
  await writeFile(filePath, bytes);
  const input = {
    requestId: randomUUID(),
    expectedVaultId: config.vaultId,
    filePath: "source.bin",
    filename: "original.bin",
    attribution: "Synthetic original",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const factory = factories.get("knowledge_attach_file");
  expect(factory, "File upload must be available through the registered agent tool").toBeTypeOf(
    "function",
  );
  const invoke = async (value = input, overrides = {}, signal?: AbortSignal) => {
    const tool = factory!({ ...context, ...overrides });
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected one attachment tool");
    }
    const response = await tool.execute(randomUUID(), value, signal);
    const block = response.content.find((entry) => entry.type === "text");
    if (!block || block.type !== "text") {
      throw new Error("Expected JSON receipt");
    }
    return { receipt: JSON.parse(block.text), serialized: JSON.stringify(response) };
  };
  return { root, workspace, base, bytes, input, invoke, filePath, api, context };
}

it("transfers multi-chunk original bytes through the registered tool without model-visible payloads", async () => {
  const f = await fixture();
  expect(f.bytes.length).toBeGreaterThan(ATTACHMENT_CHUNK_BYTES * 2);
  const { receipt, serialized } = await f.invoke();
  expect(receipt.state).toBe("complete");
  expect(receipt.evidence.sha256).toBe(f.input.sha256);
  expect(receipt.receivedBytes).toBe(f.bytes.length);
  expect(await readFile(path.join(f.root, "private", receipt.evidence.path))).toEqual(f.bytes);
  expect(serialized.length).toBeLessThan(2500);
  expect(serialized).not.toContain(f.bytes.subarray(0, 100).toString("base64"));
  expect(serialized).not.toContain("Original");
  expect((await f.invoke()).receipt).toEqual(receipt);
});

it("rejects workspace escapes, symbolic links, hardlinks and sandbox host-path confusion", async () => {
  const f = await fixture();
  const outside = path.join(f.base, "outside.bin");
  await writeFile(outside, f.bytes);
  await symlink(outside, path.join(f.workspace, "alias.bin"));
  await link(outside, path.join(f.workspace, "hard.bin"));
  for (const filePath of [outside, "../outside.bin", "alias.bin", "hard.bin"]) {
    await expect(f.invoke({ ...f.input, filePath })).rejects.toThrow(/workspace|alias|file/i);
  }
  await expect(f.invoke(f.input, { sandboxed: true })).rejects.toThrow(/sandbox/i);
  await expect(f.invoke(f.input, { workspaceDir: undefined })).rejects.toThrow(/workspace/i);
});

it("does not finalize changed source bytes or cancelled invocations", async () => {
  const f = await fixture();
  await expect(f.invoke({ ...f.input, sha256: "0".repeat(64) })).rejects.toThrow(/hash|SHA-256/i);
  const controller = new AbortController();
  controller.abort();
  await expect(f.invoke(f.input, {}, controller.signal)).rejects.toThrow();
  await expect(
    f.invoke(f.input, {
      assertInvocationCurrent() {
        throw new Error("revoked");
      },
    }),
  ).rejects.toThrow("revoked");
});

// Interrupt after an acknowledged durable chunk, then resume via the public tool.
it("resumes interrupted durable uploads without changing source bytes or request identity", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const context = { ...toolContext(f.api), tool: f.context, signal: controller.signal };
  const service = createKnowledgeService(f.api);
  await expect(
    attachWorkspaceFile(
      f.input,
      context,
      () => {},
      async (chunk) => {
        const receipt = await service.attach(chunk, context);
        controller.abort();
        return receipt;
      },
    ),
  ).rejects.toThrow();
  const { receipt } = await f.invoke();
  expect(receipt.state).toBe("complete");
  expect(receipt.evidence.sha256).toBe(f.input.sha256);
  expect(await readFile(path.join(f.root, "private", receipt.evidence.path))).toEqual(f.bytes);
});

it("honors the host-pinned root and retains empty files", async () => {
  const f = await fixture();
  await expect(
    f.invoke(f.input, { fsPolicy: { workspaceOnly: true, root: path.join(f.base, "absent") } }),
  ).rejects.toThrow(/workspace/i);
  await writeFile(f.filePath, "");
  const { receipt } = await f.invoke({ ...f.input, sha256: createHash("sha256").digest("hex") });
  expect(receipt.state).toBe("complete");
  expect(receipt.receivedBytes).toBe(0);
  expect(await readFile(path.join(f.root, "private", receipt.evidence.path))).toEqual(
    Buffer.alloc(0),
  );
});

// Keep the source-change check at the transfer/storage composition boundary.
it("does not install an original when the source changes after an acknowledged chunk", async () => {
  const f = await fixture();
  const context = { ...toolContext(f.api), tool: f.context };
  const service = createKnowledgeService(f.api);
  let changed = false;
  await expect(
    attachWorkspaceFile(
      f.input,
      context,
      () => {},
      async (chunk) => {
        const receipt = await service.attach(chunk, context);
        if (!changed) {
          changed = true;
          await writeFile(f.filePath, Buffer.alloc(f.bytes.length, 1));
        }
        return receipt;
      },
    ),
  ).rejects.toThrow(/changed|SHA-256/);
  await expect(
    readFile(path.join(f.root, "private", "artifacts", f.input.requestId, f.input.filename)),
  ).rejects.toThrow(/ENOENT/);
  await expect(
    attachWorkspaceFile(
      f.input,
      {
        source: "session-action",
        api: f.api,
        action: {
          pluginId: "knowledge",
          actionId: "attach_file",
          client: { connId: "operator", scopes: ["operator.write"] },
        },
      },
      () => {},
      async () => {
        throw new Error("must not read or upload");
      },
    ),
  ).rejects.toThrow(/agent tools/);
});
