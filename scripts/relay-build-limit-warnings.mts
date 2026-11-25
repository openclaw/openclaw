import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { reportLimitViolations } from "./lib/check-limits.mts";

function decodeCommand(value: string) {
  return value.replace(/%25|%0D|%0A|%3A|%2C/gu, (escape) => {
    switch (escape) {
      case "%0D":
        return "\r";
      case "%0A":
        return "\n";
      case "%3A":
        return ":";
      case "%2C":
        return ",";
      default:
        return "%";
    }
  });
}

const input = process.argv[2] ? createReadStream(process.argv[2]) : process.stdin;
const seen = new Set<string>();
for await (const line of createInterface({ input, crlfDelay: Infinity })) {
  // BuildKit prefixes process output and can repeat it in a failed-step excerpt.
  const match =
    /^(?:#\d+ (?:\d+(?:\.\d+)? )?)?::warning file=([^,]*),line=(\d+),col=0,title=(.*?)::(.*)$/u.exec(
      line,
    );
  if (!match || seen.has(match[0].replace(/^#\d+ (?:\d+(?:\.\d+)? )?/u, ""))) {
    continue;
  }
  const [, file, sourceLine, title, message] = match;
  seen.add(match[0].replace(/^#\d+ (?:\d+(?:\.\d+)? )?/u, ""));
  reportLimitViolations([
    {
      file: decodeCommand(file!),
      line: Number(sourceLine),
      title: decodeCommand(title!),
      message: decodeCommand(message!),
    },
  ]);
}
