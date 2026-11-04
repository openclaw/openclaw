import fs from "node:fs";

function main() {
  const [directory, expected, device, inode, offsetText, maxText] = process.argv.slice(2);
  try {
    if (!directory) {
      process.exitCode = 1;
      return;
    }
    process.chdir(directory);
    if (fs.realpathSync(".") !== expected) {
      process.exitCode = 78;
      return;
    }
    const bound = fs.statSync(".", { bigint: true });
    if (String(bound.dev) !== device || String(bound.ino) !== inode) {
      process.exitCode = 78;
      return;
    }
    const all = fs
      .readdirSync(".", { withFileTypes: true })
      .toSorted((a, b) => a.name.localeCompare(b.name));
    const offset = Number(offsetText);
    const max = Number(maxText);
    const entries = all.slice(offset, offset + max).map((entry) => {
      const stat = fs.lstatSync(entry.name);
      return {
        name: entry.name,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    });
    process.stdout.write(JSON.stringify({ entries, total: all.length }));
  } catch {
    process.exitCode = 1;
  }
}

main();
