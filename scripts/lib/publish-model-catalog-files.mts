import fs from "node:fs";
import path from "node:path";
import { readRegularFileSync, writeSiblingTempFile } from "@openclaw/fs-safe/advanced";

type Output = { file: string; content: string };
type Snapshot = { buffer: Buffer; mode: number } | undefined;
type Recovery = { dir: string };

function snapshot(file: string): Snapshot {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) {
    return undefined;
  }
  const { buffer } = readRegularFileSync({ filePath: file });
  return { buffer, mode: stat.mode & 0o777 };
}

function resolveOutput(outputFile: string): string {
  let file = outputFile;
  const seen = new Set<string>();
  while (true) {
    if (file.endsWith(path.sep)) {
      return fs.realpathSync.native(file);
    }
    const parent = fs.realpathSync.native(path.dirname(file));
    file = path.join(parent, path.basename(file));
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return file;
    }
    if (seen.has(file)) {
      throw new Error(`Catalog output symlink cycle: ${file}`);
    }
    seen.add(file);
    const target = fs.readlinkSync(file);
    // Keep symlink/.. components for the filesystem to resolve in order.
    file = path.isAbsolute(target) ? target : `${parent}${path.sep}${target}`;
  }
}

function saveRecoveryFile(recovery: Recovery, name: string, content: string | Buffer): void {
  const file = path.join(recovery.dir, name);
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Local artifact publication, not a transaction across two filesystem names. */
export async function publishModelCatalogPair(
  outputs: [Output, Output],
  warn: (message: string) => void,
): Promise<void> {
  // Resolve output links before preparing sibling temps, leaving the links intact.
  const prepared = outputs.map((output) => {
    fs.mkdirSync(path.dirname(output.file), { recursive: true });
    const file = resolveOutput(output.file);
    return { ...output, file, parent: path.dirname(file) };
  });
  if (new Set(prepared.map((output) => output.file)).size !== outputs.length) {
    throw new Error("--out and --out-v2 must name different files");
  }
  const plans = prepared.map((output) =>
    Object.assign(output, { previous: snapshot(output.file) }),
  );
  const recoveries: Array<Recovery & (typeof plans)[number]> = [];
  let publicationStarted = false;
  let published = false;
  try {
    for (const output of plans) {
      const dir = fs.mkdtempSync(path.join(output.parent, ".catalog-pair-"));
      recoveries.push({ ...output, dir });
    }
    for (const [index, recovery] of recoveries.entries()) {
      saveRecoveryFile(recovery, "next.json", recovery.content);
      const previous = recovery.previous;
      if (previous) {
        saveRecoveryFile(recovery, "previous.json", previous.buffer);
      }
      saveRecoveryFile(
        recovery,
        "RECOVERY.txt",
        [
          "Catalog pair recovery artifacts; not proof of publication.",
          ...recoveries.map((entry, i) => `output ${i + 1}: ${entry.file}; recovery: ${entry.dir}`),
          `This directory belongs to output ${index + 1}.`,
          previous
            ? `previous.json holds original bytes; mode ${previous.mode.toString(8)}.`
            : "The output was absent before this attempt.",
          "next.json holds the validated candidate bytes.",
          "Stop writers and inspect BOTH outputs before restoring or completing the pair.",
          "Do not blindly overwrite a replacement or rerun publication to recover.",
          "Retained artifacts are never automatically replayed or removed by a later run.",
          "",
        ].join("\n"),
      );
    }
    // The documented single publisher owns both outputs during this operation.
    publicationStarted = true;
    for (const output of recoveries) {
      const mode = output.previous?.mode;
      await writeSiblingTempFile({
        dir: output.parent,
        chmodDir: false,
        producerIsolation: "private-directory",
        mode,
        syncTempFile: true,
        writeTemp: async (tempPath) => {
          fs.writeFileSync(tempPath, output.content, {
            flag: "wx",
            mode: mode ?? 0o666,
          });
        },
        resolveFinalPath: () => output.file,
      });
    }
    published = true;
  } catch (cause) {
    if (publicationStarted) {
      // A failed rename/verification can already have published. Never roll back
      // over a foreign replacement; retain both old/new sets for reconciliation.
      throw new Error(
        `Catalog pair publication incomplete; inspect both outputs. Recovery retained: ${recoveries.map((entry) => entry.dir).join(", ")}. Cause: ${String(cause)}`,
        { cause },
      );
    }
    throw cause;
  } finally {
    // Cleanup failure cannot undo a visible pair. Interrupted publication keeps
    // both recovery sets; failures before publication only need owned cleanup.
    if (!publicationStarted || published) {
      for (const recovery of recoveries) {
        try {
          fs.rmSync(recovery.dir, { recursive: true, force: true });
        } catch (error) {
          warn(
            `Catalog ${published ? "pair published; " : ""}recovery cleanup failed; retained ${recovery.dir}: ${String(error)}`,
          );
        }
      }
    }
  }
}
