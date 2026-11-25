// Never read the target's argv, environment, executable names, or fd paths.
import { closeSync, openSync, readSync, readdirSync } from "node:fs";

const rootPid = Number(process.argv[2]);
const maxProcesses = 12;
const maxThreads = 32;
const maxBytes = 15 * 1024;
let outputBytes = 0;
let threadCount = 0;

function emit(line) {
  const text = `${line}\n`;
  if (outputBytes + text.length <= maxBytes) {
    outputBytes += text.length;
    process.stdout.write(text);
  }
}

function read(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(8192);
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function stat(pid, tid) {
  const raw = read(tid ? `/proc/${pid}/task/${tid}/stat` : `/proc/${pid}/stat`);
  if (!raw) {
    return undefined;
  }
  // comm can contain spaces and parentheses; omit it entirely from the result.
  const fields = raw.slice(raw.lastIndexOf(") ") + 2).split(/\s+/u);
  if (!/^[A-Z]$/u.test(fields[0] ?? "") || !/^\d+$/u.test(fields[1] ?? "")) {
    return undefined;
  }
  return { state: fields[0], ppid: Number(fields[1]) };
}

function numericIds(text) {
  return (text?.match(/\b[1-9]\d*\b/gu) ?? []).map(Number).slice(0, maxProcesses);
}

function signals(taskRoot) {
  const raw = read(`${taskRoot}/status`);
  return (
    raw
      ?.split("\n")
      .flatMap((line) => {
        const match = /^(SigPnd|ShdPnd|SigBlk|SigIgn|SigCgt):\s+([0-9a-f]{1,16})$/u.exec(line);
        return match ? [`${match[1]}=${match[2]}`] : [];
      })
      .join(" ") || "signals=unavailable"
  );
}

function waitState(taskRoot) {
  const rawWchan = read(`${taskRoot}/wchan`)?.trim();
  const wchan = rawWchan && /^[\w.]{1,128}$/u.test(rawWchan) ? rawWchan : "unavailable";
  const rawStack = read(`${taskRoot}/stack`);
  const stack = rawStack
    ?.split("\n")
    .flatMap((line) => {
      const match = /^\[<[0-9a-f]+>\]\s+([\w.]+)(?:\+0x[0-9a-f]+\/0x[0-9a-f]+)?(?:\s|$)/u.exec(
        line,
      );
      return match ? [match[1].slice(0, 80)] : [];
    })
    .slice(0, 8)
    .join(",");
  return `wchan=${wchan} stack=${stack || "unavailable"}`;
}

if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
  process.exitCode = 1;
} else {
  emit(`[vitest] fork OS diagnostics: pid=${rootPid}`);
  const ancestors = new Set();
  let ancestor = rootPid;
  while (ancestor > 0 && ancestors.size < 8 && !ancestors.has(ancestor)) {
    ancestors.add(ancestor);
    const info = stat(ancestor);
    emit(
      `ancestry pid=${ancestor} ppid=${info?.ppid ?? "unavailable"} state=${info?.state ?? "unavailable"}`,
    );
    ancestor = info?.ppid ?? 0;
  }

  const pending = [rootPid];
  const seen = new Set();
  while (pending.length && seen.size < maxProcesses) {
    const pid = pending.shift();
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const info = stat(pid);
    emit(
      `process pid=${pid} ppid=${info?.ppid ?? "unavailable"} state=${info?.state ?? "unavailable"}`,
    );
    let tids;
    try {
      tids = readdirSync(`/proc/${pid}/task`).filter((tid) => /^[1-9]\d*$/u.test(tid));
    } catch {
      emit(`threads pid=${pid} unavailable`);
      continue;
    }
    for (const tid of tids.slice(0, maxThreads - threadCount)) {
      threadCount += 1;
      const taskRoot = `/proc/${pid}/task/${tid}`;
      const task = stat(pid, tid);
      emit(
        `thread pid=${pid} tid=${tid} state=${task?.state ?? "unavailable"} ${waitState(taskRoot)} ${signals(taskRoot)}`,
      );
      for (const child of numericIds(read(`${taskRoot}/children`))) {
        if (pending.length < maxProcesses && !seen.has(child) && !pending.includes(child)) {
          pending.push(child);
        }
      }
    }
    if (threadCount >= maxThreads) {
      emit(`threads limit=${maxThreads}`);
      break;
    }
  }
  if (pending.length) {
    emit(`processes limit=${maxProcesses}`);
  }
}
