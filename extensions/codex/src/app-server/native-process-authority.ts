import { randomUUID } from "node:crypto";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { protectCodexAppServerLiveThread } from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import {
  readCodexNotificationThreadId,
  readCodexNotificationTurnId,
} from "./notification-correlation.js";
import { isJsonObject, type CodexAppServerRequestResult } from "./protocol.js";
import { retainSharedCodexAppServerClientIfCurrent } from "./shared-client.js";

type RetainedSource = NonNullable<
  ReturnType<NonNullable<EmbeddedRunAttemptParamsV2["hostCapabilities"]["retainSourceAuthority"]>>
>;
type NativeTurn = { threadId: string; turnId: string };
type NativeCommand = NativeTurn & { itemId: string };
type ProcessCustody = { terminate: () => Promise<void> };
type CommandAdmission = NativeCommand & {
  owner: CodexNativeProcessAuthority;
  client: CodexNativeProcessClient;
  parentTurn: NativeTurn;
  accepting: boolean;
  processes: Set<ProcessCustody>;
  assertActive: () => void;
  releaseClient?: () => void;
  releaseThread: () => void;
};

const clients = new WeakMap<CodexAppServerClient, CodexNativeProcessClient>();

/** A physical client joins native call receipts to its concrete sandbox processes. */
export function getCodexNativeProcessClient(
  client: CodexAppServerClient,
): CodexNativeProcessClient {
  let owner = clients.get(client);
  if (!owner) {
    owner = new CodexNativeProcessClient(client);
    clients.set(client, owner);
  }
  return owner;
}

export function hasCodexNativeBackgroundProcesses(
  client: CodexAppServerClient,
  threadId: string,
): boolean {
  return clients.get(client)?.hasProcesses(threadId) ?? false;
}

/** Read the native process owner's live inventory, never infer custody from a start event. */
export async function readCodexRetainedBackgroundCommands(params: {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string;
  commands: ReadonlyMap<string, string | null>;
  authority?: CodexNativeProcessAuthority;
  assertCurrent: () => void;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<{
  inventory: CodexAppServerRequestResult<"thread/backgroundTerminals/list">["data"];
  readCurrent: () => ReadonlyMap<string, string>;
}> {
  params.assertCurrent();
  const { data } = await params.client.request(
    "thread/backgroundTerminals/list",
    { threadId: params.threadId },
    { signal: params.signal, timeoutMs: params.timeoutMs },
  );
  params.signal.throwIfAborted();
  params.assertCurrent();
  // Consumption follows a second notification drain. Recheck source custody then,
  // so revocation during that await cannot turn an orphan into retained work.
  return {
    inventory: data,
    readCurrent: () => {
      params.signal.throwIfAborted();
      params.assertCurrent();
      const retained = new Map<string, string>();
      for (const { itemId, processId } of data) {
        if (
          params.commands.has(itemId) &&
          // Approval starts omit the process ID; the native inventory supplies it.
          (params.commands.get(itemId) === null || params.commands.get(itemId) === processId) &&
          (!params.authority ||
            params.authority.ownsCurrentCommand(params.client, {
              threadId: params.threadId,
              turnId: params.turnId,
              itemId,
            }))
        ) {
          retained.set(itemId, processId);
        }
      }
      return retained;
    },
  };
}

export class CodexNativeProcessClient {
  readonly id = randomUUID();
  readonly authPath = `/openclaw-${randomUUID()}`;
  private readonly threads = new Map<string, Map<string, CommandAdmission>>();
  private closed = false;

  constructor(private readonly client: CodexAppServerClient) {
    client.addNotificationHandler((notification) => {
      if (!isJsonObject(notification.params)) {
        return;
      }
      const threadId = readCodexNotificationThreadId(notification.params);
      const turnId = readCodexNotificationTurnId(notification.params);
      const commands = threadId ? this.threads.get(threadId) : undefined;
      if (!commands || !turnId) {
        return;
      }
      if (notification.method === "turn/completed") {
        for (const command of commands.values()) {
          if (command.turnId === turnId) {
            this.closeAdmission(command);
          }
        }
      } else if (notification.method === "item/completed") {
        const item = notification.params.item;
        const command =
          isJsonObject(item) && typeof item.id === "string" ? commands.get(item.id) : undefined;
        if (command?.turnId === turnId) {
          this.closeAdmission(command);
        }
      }
    });
    client.addCloseHandler(() => {
      this.closed = true;
      const owners = new Set<CodexNativeProcessAuthority>();
      for (const commands of this.threads.values()) {
        for (const command of commands.values()) {
          owners.add(command.owner);
        }
      }
      for (const owner of owners) {
        owner.cancelClient(this);
      }
    });
  }

  admit(
    owner: CodexNativeProcessAuthority,
    receipt: NativeCommand,
    parentTurn: NativeTurn,
    assertActive: () => void,
  ): void {
    if (this.closed) {
      throw new Error("Codex process source client is closed");
    }
    let commands = this.threads.get(receipt.threadId);
    const existing = commands?.get(receipt.itemId);
    if (existing) {
      if (existing.owner === owner && existing.turnId === receipt.turnId && existing.accepting) {
        return;
      }
      throw new Error("Codex reused an unsettled native command identity");
    }
    if (!commands) {
      commands = new Map();
      this.threads.set(receipt.threadId, commands);
    }
    const command: CommandAdmission = {
      ...receipt,
      owner,
      client: this,
      parentTurn,
      accepting: true,
      processes: new Set(),
      assertActive,
      releaseClient: retainSharedCodexAppServerClientIfCurrent(this.client),
      releaseThread: protectCodexAppServerLiveThread(this.client, receipt.threadId),
    };
    commands.set(receipt.itemId, command);
    owner.commands.add(command);
  }

  hasProcesses(threadId: string): boolean {
    return [...(this.threads.get(threadId)?.values() ?? [])].some(
      (command) => command.processes.size > 0,
    );
  }

  claim(metadata: unknown, terminate: () => Promise<void>) {
    if (
      this.closed ||
      !isJsonObject(metadata) ||
      typeof metadata.threadId !== "string" ||
      typeof metadata.toolCallId !== "string"
    ) {
      throw new Error("Codex process start requires its admitted native command");
    }
    const command = this.threads.get(metadata.threadId)?.get(metadata.toolCallId);
    if (!command) {
      throw new Error("Codex process start has no admitted native command");
    }
    const assertAdmission = () => {
      command.owner.assertCurrent();
      command.assertActive();
      if (
        this.closed ||
        !command.accepting ||
        this.threads.get(command.threadId)?.get(command.itemId) !== command
      ) {
        throw new Error("Codex native command admission has ended");
      }
    };
    assertAdmission();
    const process = { terminate };
    command.processes.add(process);
    let settled = false;
    return {
      assertAdmission,
      assertCurrent: () => {
        command.owner.assertCurrent();
        if (this.closed || settled) {
          throw new Error("Codex native process authority has ended");
        }
      },
      settle: () => {
        if (settled) {
          return;
        }
        settled = true;
        command.processes.delete(process);
        this.forgetSettled(command);
      },
      fail: (error: unknown) => command.owner.reportSettlementFailure(error),
    };
  }

  closeAdmission(command: CommandAdmission): void {
    command.accepting = false;
    this.forgetSettled(command);
  }

  private forgetSettled(command: CommandAdmission): void {
    if (command.accepting || command.processes.size > 0) {
      return;
    }
    const commands = this.threads.get(command.threadId);
    if (commands?.get(command.itemId) === command) {
      commands.delete(command.itemId);
      if (commands.size === 0) {
        this.threads.delete(command.threadId);
      }
    }
    command.owner.commands.delete(command);
    command.releaseThread();
    command.releaseClient?.();
    command.owner.releaseIfSettled();
  }
}

/** Original-source custody outlives foreground authority, never permitting new admission after release. */
export class CodexNativeProcessAuthority {
  readonly commands = new Set<CommandAdmission>();
  private holds = 1;
  private cancelled = false;
  private released = false;
  private cancellation?: Promise<void>;
  private parentTurn?: NativeTurn & { client: CodexAppServerClient };
  private readonly source: RetainedSource | undefined;
  private readonly onAbort = () => {
    if (!this.cancelled) {
      void this.cancel().catch(this.onCleanupFailure);
    }
  };

  constructor(
    host: EmbeddedRunAttemptParamsV2["hostCapabilities"],
    private readonly onCleanupFailure: (error: unknown) => void,
  ) {
    this.source = host.retainSourceAuthority?.();
    this.source?.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (this.source?.signal?.aborted) {
      this.onAbort();
    }
  }

  assertCurrent(): void {
    if (this.cancelled || this.released) {
      throw new Error("Codex native process source has ended");
    }
    try {
      this.source?.assertCurrent();
      if (this.cancelled || this.released) {
        throw new Error("Codex native process source has ended");
      }
    } catch (error) {
      this.onAbort();
      throw error;
    }
  }

  ownsCurrentCommand(client: CodexAppServerClient, receipt: NativeCommand): boolean {
    return this.findCurrentCommand(client, receipt) !== undefined;
  }

  private findCurrentCommand(
    client: CodexAppServerClient,
    receipt: NativeCommand,
  ): CommandAdmission | undefined {
    this.assertCurrent();
    return [...this.commands].find(
      (command) =>
        command.client === clients.get(client) &&
        command.threadId === receipt.threadId &&
        command.turnId === receipt.turnId &&
        command.itemId === receipt.itemId &&
        command.processes.size > 0,
    );
  }

  bindTurn(client: CodexAppServerClient, threadId: string, turnId: string): void {
    this.parentTurn = { client, threadId, turnId };
  }

  admit(
    client: CodexAppServerClient,
    receipt: NativeCommand,
    assertAdmissionCurrent: () => void,
    childParentThreadId?: string,
  ): void {
    this.assertCurrent();
    if (this.holds === 0) {
      throw new Error("Codex native process admission is closed");
    }
    const parent = this.parentTurn;
    if (
      parent?.client !== client ||
      (childParentThreadId
        ? childParentThreadId !== parent.threadId
        : receipt.threadId !== parent.threadId || receipt.turnId !== parent.turnId)
    ) {
      throw new Error("Codex native command does not belong to its admitted turn");
    }
    assertAdmissionCurrent();
    getCodexNativeProcessClient(client).admit(this, receipt, parent, assertAdmissionCurrent);
  }

  retainAdmission(): () => void {
    this.assertCurrent();
    this.holds += 1;
    let held = true;
    return () => {
      if (held) {
        held = false;
        this.release();
      }
    };
  }

  release(): void {
    if (this.holds === 0) {
      return;
    }
    this.holds -= 1;
    if (this.holds === 0) {
      for (const command of this.commands) {
        command.client.closeAdmission(command);
      }
    }
    this.releaseIfSettled();
  }

  releaseIfSettled(): void {
    if (this.released || this.holds > 0 || this.commands.size > 0) {
      return;
    }
    this.released = true;
    this.source?.signal?.removeEventListener("abort", this.onAbort);
    this.source?.release();
  }

  cancelTurn(client: CodexAppServerClient, threadId: string, turnId: string): Promise<void> {
    const owner = getCodexNativeProcessClient(client);
    return this.terminate(
      [...this.commands].filter(
        (command) =>
          command.client === owner &&
          command.parentTurn.threadId === threadId &&
          command.parentTurn.turnId === turnId,
      ),
    );
  }

  async cancelCommand(client: CodexAppServerClient, receipt: NativeCommand): Promise<boolean> {
    const command = this.findCurrentCommand(client, receipt);
    if (!command) {
      return false;
    }
    await this.terminate([command]);
    return true;
  }

  cancelClient(client: CodexNativeProcessClient): void {
    void this.terminate([...this.commands].filter((command) => command.client === client)).catch(
      this.onCleanupFailure,
    );
  }

  reportSettlementFailure(error: unknown): void {
    this.onCleanupFailure(
      new AggregateError(
        [error],
        "Codex native process cleanup failed; background work remains unsettled",
      ),
    );
  }

  private cancel(): Promise<void> {
    this.cancelled = true;
    return (this.cancellation ??= this.terminate([...this.commands]));
  }

  private async terminate(commands: CommandAdmission[]): Promise<void> {
    const processes = commands.flatMap((command) => {
      command.client.closeAdmission(command);
      return [...command.processes];
    });
    // These closures own concrete children. Native numeric process IDs may already belong to a successor.
    const results = await Promise.allSettled(processes.map((process) => process.terminate()));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Codex native process cleanup failed; background work remains unsettled",
      );
    }
  }
}
