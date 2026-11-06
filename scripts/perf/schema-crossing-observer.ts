// Benchmark-only host I/O and integrity-transport attribution; no product hooks.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";

export function observeSchemaCrossing() {
  const events: Array<{
    operation: string;
    startedAt: number;
    durationMs: number;
    bytes?: number;
  }> = [];
  const integrityRequests: Array<{ transport: string; options: unknown }> = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The observer forwards each native receiver and restores this exact method.
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    const operation =
      /^PRAGMA\s+(foreign_key_check|quick_check|integrity_check|wal_checkpoint)/iu.exec(sql)?.[1];
    if (operation) {
      const measure = <T extends (...args: never[]) => unknown>(original: T) =>
        new Proxy(original, {
          apply(target, thisArg, args) {
            const startedAt = performance.now();
            try {
              return Reflect.apply(target, thisArg, args);
            } finally {
              events.push({ operation, startedAt, durationMs: performance.now() - startedAt });
            }
          },
        });
      statement.get = measure(statement.get.bind(statement));
      statement.all = measure(statement.all.bind(statement));
      statement.iterate = new Proxy(statement.iterate.bind(statement), {
        apply(target, thisArg, args) {
          const iterator: ReturnType<typeof target> = Reflect.apply(target, thisArg, args);
          iterator.next = measure(iterator.next.bind(iterator));
          return iterator;
        },
      });
    }
    return statement;
  };
  const originalOpen = fs.promises.open;
  fs.promises.open = async (...openArgs: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...openArgs);
    const read = handle.read.bind(handle);
    const readEvent = { operation: "file-read", startedAt: 0, durationMs: 0, bytes: 0 };
    handle.read = new Proxy(read, {
      async apply(target, thisArg, args) {
        const startedAt = performance.now();
        if (readEvent.startedAt === 0) {
          readEvent.startedAt = startedAt;
          events.push(readEvent);
        }
        try {
          const result = await Reflect.apply(target, thisArg, args);
          readEvent.bytes += result.bytesRead;
          return result;
        } finally {
          readEvent.durationMs += performance.now() - startedAt;
        }
      },
    });
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      const startedAt = performance.now();
      try {
        return await sync();
      } finally {
        events.push({
          operation: "file-sync",
          startedAt,
          durationMs: performance.now() - startedAt,
        });
      }
    };
    return handle;
  };
  const spawn = childProcess.spawnSync;
  childProcess.spawnSync = new Proxy(spawn, {
    apply(target, thisArg, args) {
      if (Array.isArray(args[1]) && args[1].includes("--check-sync")) {
        const request = deserialize(args[2].input);
        integrityRequests.push({ transport: "sync", options: request.integrity });
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  const fork = childProcess.fork;
  childProcess.fork = new Proxy(fork, {
    apply(target, thisArg, args) {
      const child = Reflect.apply(target, thisArg, args) as ReturnType<typeof fork>;
      const send = child.send.bind(child);
      child.send = new Proxy(send, {
        apply(sendTarget, sendThisArg, sendArgs) {
          const request = sendArgs[0];
          if (request?.integrity && request?.databaseLabel) {
            integrityRequests.push({ transport: "async", options: request.integrity });
          }
          return Reflect.apply(sendTarget, sendThisArg, sendArgs);
        },
      });
      return child;
    },
  });
  syncBuiltinESMExports();
  return {
    events,
    integrityRequests,
    close() {
      DatabaseSync.prototype.prepare = prepare;
      fs.promises.open = originalOpen;
      childProcess.spawnSync = spawn;
      childProcess.fork = fork;
      syncBuiltinESMExports();
    },
  };
}
