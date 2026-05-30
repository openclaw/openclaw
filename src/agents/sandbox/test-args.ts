export function findDockerArgsCall(calls: unknown[][], command: string): string[] | undefined {
  return calls.find((call) => Array.isArray(call[0]) && call[0][0] === command)?.[0] as
    | string[]
    | undefined;
}

export function collectDockerFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && typeof args[i + 1] === "string") {
      values.push(args[i + 1]);
    }
  }
  return values;
}
