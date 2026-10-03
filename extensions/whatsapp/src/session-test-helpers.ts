import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { expect, type MockInstance, vi } from "vitest";
import { baileys, getLastSocket, resetBaileysMocks, resetLoadConfigMock } from "./test-helpers.js";

export function resetSessionTestMocks(): void {
  vi.clearAllMocks();
  resetBaileysMocks();
  resetLoadConfigMock();
}

export async function cleanupSessionTest(
  waitForCredsSaveQueue: (authDir?: string) => Promise<void>,
): Promise<void> {
  await waitForCredsSaveQueue();
  resetLogger();
  setLoggerOverride(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
}

export async function flushCredsUpdate(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export async function emitCredsUpdate(
  waitForCredsSaveQueue: (authDir?: string) => Promise<void>,
  authDir?: string,
): Promise<void> {
  getLastSocket().ev.emit("creds.update", {});
  await flushCredsUpdate();
  if (authDir) {
    await waitForCredsSaveQueue(authDir);
  }
}

export function createTempAuthDir(prefix: string): string {
  return path.resolve(
    fsSync.mkdtempSync(path.join((process.env.TMPDIR ?? "/tmp").replace(/\/+$/, ""), `${prefix}-`)),
  );
}

export function mockFsOpenForCredsWrites(params?: {
  onTempWrite?: (filePath: string) => Promise<void> | void;
}) {
  const open = fs.open.bind(fs);
  const writeFile = fs.writeFile.bind(fs);
  type FileHandle = Awaited<ReturnType<typeof fs.open>>;
  const handles: Array<{
    filePath: string;
    flags: string | number | undefined;
    mode: number | undefined;
    handle: FileHandle;
    chmod: MockInstance<FileHandle["chmod"]>;
    sync: MockInstance<FileHandle["sync"]>;
    close: MockInstance<FileHandle["close"]>;
  }> = [];
  const writes: Array<{ filePath: string; data: unknown }> = [];
  const writeFileSpy = vi
    .spyOn(fs, "writeFile")
    .mockImplementation(async (target, data, options) => {
      const observed = handles.find(({ handle }) => handle === target);
      if (observed && path.basename(observed.filePath).startsWith(".creds.")) {
        writes.push({ filePath: observed.filePath, data });
        await params?.onTempWrite?.(observed.filePath);
      }
      return await writeFile(target, data, options);
    });
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
    const handle = await open(filePath, flags, mode);
    if (typeof filePath === "string") {
      handles.push({
        filePath,
        flags,
        mode: typeof mode === "number" ? mode : undefined,
        handle,
        chmod: vi.spyOn(handle, "chmod"),
        sync: vi.spyOn(handle, "sync"),
        close: vi.spyOn(handle, "close"),
      });
    }
    return handle;
  });
  return {
    handles,
    writes,
    get tempHandles() {
      return handles.filter(
        ({ filePath, flags }) => flags === "wx" && path.basename(filePath).startsWith(".creds."),
      );
    },
    get dirHandles() {
      return handles.filter(({ flags }) => flags === "r");
    },
    restore() {
      writeFileSpy.mockRestore();
      openSpy.mockRestore();
    },
  };
}

export function firstMockCall(
  mock: { mock: { calls: Array<readonly unknown[]> } },
  label: string,
): readonly unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

export function readLastSocketOptions(): {
  connectTimeoutMs?: number;
  defaultQueryTimeoutMs?: number;
  fireInitQueries?: boolean;
  keepAliveIntervalMs?: number;
  printQRInTerminal?: boolean;
  qrTimeout?: number;
  waWebSocketUrl?: string | URL;
  logger?: { level?: string; trace?: unknown };
  browser?: [string, string, string];
} {
  const [options] = firstMockCall(
    baileys.makeWASocket as ReturnType<typeof vi.fn>,
    "Baileys socket creation",
  );
  if (typeof options !== "object" || options === null) {
    throw new Error("expected Baileys socket options");
  }
  return options as {
    connectTimeoutMs?: number;
    defaultQueryTimeoutMs?: number;
    fireInitQueries?: boolean;
    keepAliveIntervalMs?: number;
    printQRInTerminal?: boolean;
    qrTimeout?: number;
    waWebSocketUrl?: string | URL;
    logger?: { level?: string; trace?: unknown };
    browser?: [string, string, string];
  };
}

export function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

export function expectRuntimeLogContaining(
  runtime: { log: ReturnType<typeof vi.fn> },
  text: string,
): void {
  expect(runtime.log.mock.calls.map(([message]) => String(message)).join("\n")).toContain(text);
}
