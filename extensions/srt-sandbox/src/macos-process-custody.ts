/** Decode only the literal shell-quote grammar emitted by pinned SRT. */
function parseLiteralCommand(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (/\s/.test(char)) {
      if (started) {
        words.push(word);
      }
      word = "";
      started = false;
    } else if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) {
        throw new Error("srt-sandbox: malformed macOS sandbox wrapper");
      }
      word += command.slice(index + 1, end);
      started = true;
      index = end;
    } else if (command.slice(index, index + 3) === `"'"`) {
      word += "'";
      started = true;
      index += 2;
    } else if (/^[A-Za-z0-9_./:=@+,-]$/.test(char)) {
      word += char;
      started = true;
    } else {
      throw new Error("srt-sandbox: nonliteral macOS sandbox wrapper is unsupported");
    }
  }
  if (started) {
    words.push(word);
  }
  return words;
}

/** Keep every guest descendant in its host-owned group at the syscall boundary. */
export function restrictMacosSandboxArgv(argv: string[]): string[] {
  if (process.platform !== "darwin") {
    return argv;
  }
  if (argv.length !== 3 || argv[1] !== "-c") {
    throw new Error("srt-sandbox: unsupported macOS sandbox argv");
  }
  const words = parseLiteralCommand(argv[2]!);
  if (words[0] !== "env") {
    throw new Error("srt-sandbox: missing macOS sandbox environment");
  }
  let index = 1;
  while (index < words.length) {
    if (words[index] === "-u" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(words[index + 1] ?? "")) {
      index += 2;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) {
      index++;
    } else {
      break;
    }
  }
  if (
    words[index] !== "/usr/bin/sandbox-exec" ||
    words[index + 1] !== "-p" ||
    !words[index + 2]?.startsWith("(version 1)\n") ||
    !words[index + 3]?.startsWith("/") ||
    words[index + 4] !== "-c" ||
    words.length !== index + 6
  ) {
    throw new Error("srt-sandbox: unsupported macOS Seatbelt invocation");
  }
  // Darwin ABI: SYS_setpgid=82, SYS_setsid=147, SYS_posix_spawn=244. Append to the existing
  // filesystem/network profile; applying a second sandbox is not supported.
  words[index + 2] +=
    "\n(deny syscall-unix (syscall-number 82) (syscall-number 147) (syscall-number 244))";
  return ["/usr/bin/env", ...words.slice(1)];
}
