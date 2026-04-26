import { createReadStream, existsSync, statSync, watch as fsWatch } from "node:fs";
import { createInterface } from "node:readline";
import { logPaths } from "./paths.js";

export interface TailOptions {
  follow?: boolean;
  lines?: number;
  /** "out" (default) reads dashboard.out.log; "err" reads dashboard.err.log. */
  stream?: "out" | "err";
  /** Output sink (defaults to process.stdout). */
  out?: NodeJS.WritableStream;
  /** Override file path resolution for tests. */
  filePath?: string;
}

function resolveLogFile(opts: TailOptions): string {
  if (opts.filePath) {
    return opts.filePath;
  }
  const paths = logPaths();
  return opts.stream === "err" ? paths.errLog : paths.outLog;
}

async function readLastLines(file: string, count: number): Promise<string[]> {
  return await new Promise((resolve) => {
    const buf: string[] = [];
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }) });
    rl.on("line", (line) => {
      buf.push(line);
      if (buf.length > count) {
        buf.shift();
      }
    });
    rl.on("close", () => resolve(buf));
    rl.on("error", () => resolve(buf));
  });
}

export async function tailLogs(opts: TailOptions = {}): Promise<{ exitCode: number }> {
  const sink = opts.out ?? process.stdout;
  const file = resolveLogFile(opts);
  const lines = opts.lines ?? 50;

  if (!existsSync(file)) {
    sink.write(`no logs yet at ${file}\n`);
    return { exitCode: 0 };
  }

  const tail = await readLastLines(file, lines);
  for (const line of tail) {
    sink.write(`${line}\n`);
  }

  if (!opts.follow) {
    return { exitCode: 0 };
  }

  return await new Promise((resolve) => {
    let position = statSync(file).size;
    const watcher = fsWatch(file, (event) => {
      if (event !== "change") {
        return;
      }
      const size = (() => {
        try {
          return statSync(file).size;
        } catch {
          return position;
        }
      })();
      if (size < position) {
        position = 0;
      }
      if (size <= position) {
        return;
      }
      const stream = createReadStream(file, { start: position, end: size - 1, encoding: "utf8" });
      stream.on("data", (chunk) => sink.write(chunk));
      stream.on("end", () => {
        position = size;
      });
    });

    const cleanup = () => {
      watcher.close();
      resolve({ exitCode: 0 });
    };
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });
}
