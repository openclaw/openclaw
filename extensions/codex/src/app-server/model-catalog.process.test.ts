import * as childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  awaitGateBeforeSettlement,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCodexAppServerModelCatalog } from "./model-catalog.js";
import {
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

describe.skipIf(process.platform === "win32")("Codex model discovery process lifetime", () => {
  const dirs = useSessionStoreTempDirs(afterAll, "codex-model-lifetime-");

  it("retires timed-out discovery without interrupting a sibling lease, then reaps the pair", async ({
    signal,
  }) => {
    const root = dirs.make();
    const agentDir = path.join(root, "agent");
    const workspaceDir = path.join(root, "workspace");
    const executable = path.join(root, "codex.mjs");
    const receipts = await openFixtureReceiptChannel();
    const children: { child: childProcess.ChildProcess; closed: Promise<unknown> }[] = [];
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("CODEX_API_KEY", "");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      executable,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
${fixtureReceiptClientSource(receipts.endpoint)}
if (process.argv.includes("--native")) {
  fs.writeFileSync(path.join(process.env.CODEX_HOME, "native.pid"), String(process.pid));
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\\n");
      if (end < 0) break;
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: message.id, result: {
          userAgent: "codex-cli/${CODEX_APP_SERVER_VERSION}", codexHome: process.env.CODEX_HOME,
        } }) + "\\n");
      } else if (message.method === "model/list") {
        sendReceipt("discovery", "pending");
      } else if (message.method === "config/read") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { config: {} } }) + "\\n");
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  const child = spawn(process.execPath, [process.argv[1], "--native"], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => process.exit(code ?? 1));
}
`,
    );
    const spawn = childProcess.spawn;
    vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      const child = spawn(...args);
      if (Array.isArray(args[1]) && args[1].includes(executable)) {
        children.push({ child, closed: once(child, "close") });
      }
      return child;
    });
    const pluginConfig = {
      discovery: { timeoutMs: 5_000 },
      appServer: {
        command: process.execPath,
        args: [executable, "app-server"],
        homeScope: "agent",
      },
    };
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: { agentDir, workspace: workspaceDir } },
      },
    };
    const catalog = createCodexAppServerModelCatalog("codex");
    const leases: Awaited<ReturnType<typeof getLeasedSharedCodexAppServerClient>>[] = [];
    let settled: Promise<unknown> | undefined;
    try {
      const options = { config, agentDir, pluginConfig, timeoutMs: 5_000 };
      const sibling = await withinTest(getLeasedSharedCodexAppServerClient(options), signal);
      leases.push(sibling);
      expect(children).toHaveLength(1);
      const first = children[0];
      const firstPid = sibling.getTransportPid();
      if (!first || firstPid === undefined) {
        throw new Error("The shared client did not spawn a local transport");
      }
      expect(firstPid).toBe(first.child.pid);
      const nativePid = Number(
        await fs.readFile(path.join(agentDir, "codex-home", "native.pid"), "utf8"),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const loading = catalog.load(
        { config, agentId: "main", agentDir, workspaceDir },
        pluginConfig,
      );
      settled = loading.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      await withinTest(
        awaitGateBeforeSettlement(
          receipts.waitFor("discovery", "pending"),
          loading,
          "Discovery settled before sending model/list",
        ),
        signal,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await settled).toEqual(
        expect.objectContaining({ message: expect.stringContaining("timed out") }),
      );
      vi.useRealTimers();
      await expect(sibling.request("config/read", {})).resolves.toEqual({ config: {} });
      const replacement = await withinTest(getLeasedSharedCodexAppServerClient(options), signal);
      leases.push(replacement);
      expect(replacement.getTransportPid(), "timed-out discovery remained pooled").not.toBe(
        sibling.getTransportPid(),
      );
      expect(children).toHaveLength(2);
      expect(first.child.exitCode).toBeNull();
      releaseLeasedSharedCodexAppServerClient(sibling);
      leases.shift();
      await withinTest(first.closed, signal);
      for (const pid of [firstPid, nativePid]) {
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      }
    } finally {
      vi.useRealTimers();
      for (const client of leases) {
        releaseLeasedSharedCodexAppServerClient(client);
      }
      await clearSharedCodexAppServerClientAndWait();
      await Promise.all(children.map(({ closed }) => closed));
      await settled;
      catalog.dispose();
      await receipts.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
});
