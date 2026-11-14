import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The verifier owns containment and loader policy; inventory only observes types.
function auditMacPortability(runtime, executable, app = false) {
  const inside = (candidate) => candidate === runtime || candidate.startsWith(`${runtime}/`);
  const systemLibrary = (candidate) => {
    // A system-looking prefix must not hide a load path that escapes with ../.
    const normalized = path.normalize(candidate);
    return normalized.startsWith("/usr/lib/") || normalized.startsWith("/System/Library/");
  };
  function expandLoaderPath(value, filename, entrypoint = executable) {
    return value
      .replace(/^@loader_path(?=\/|$)/u, path.dirname(filename))
      .replace(/^@executable_path(?=\/|$)/u, path.dirname(entrypoint));
  }
  function loadSlices(filename) {
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    const fd = fs.openSync(filename, flags);
    let output;
    let sliceCount;
    try {
      const header = Buffer.alloc(8);
      if (
        !fs.fstatSync(fd).isFile() ||
        fs.readSync(fd, header, 0, header.length, 0) !== header.length
      ) {
        throw new Error(`Unreadable native header in ${filename}`);
      }
      const magic = header.readUInt32BE(0);
      sliceCount = magic === 0xcafebabe || magic === 0xcafebabf ? header.readUInt32BE(4) : 1;
      // Stable descriptor labels keep filenames out of the tool's record framing.
      // Explicit all-slice selection is required even when a host slice exists.
      output = execFileSync("/usr/bin/otool", ["-arch", "all", "-h", "-l", "/dev/fd/3"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", fd],
      });
    } finally {
      fs.closeSync(fd);
    }
    const sections = output.split(/^\/dev\/fd\/3(?: \(architecture .+\))?:\n/mu);
    if (sections.shift() !== "" || sections.length !== sliceCount) {
      throw new Error(`Incomplete native architecture output in ${filename}`);
    }
    return sections.map((section) => {
      const blocks = section.split(/Load command \d+\n/u);
      const preamble = blocks.shift();
      if (!preamble) {
        throw new Error(`Missing native architecture header in ${filename}`);
      }
      const [heading, columnsLine, valuesLine, ...extra] = preamble.trim().split("\n");
      const columns = columnsLine?.trim().split(/\s+/u) ?? [];
      const values = valuesLine?.trim().split(/\s+/u) ?? [];
      if (heading !== "Mach header" || extra.length || columns.length !== values.length) {
        throw new Error(`Unreadable native architecture header in ${filename}`);
      }
      const headerValue = (name) => {
        const value = values[columns.indexOf(name)];
        if (value === undefined || !Number.isInteger(Number(value))) {
          throw new Error(`Unreadable native ${name} in ${filename}`);
        }
        return value;
      };
      const architecture = ["cputype", "cpusubtype", "caps"].map(headerValue).join(":");
      if (blocks.length !== Number(headerValue("ncmds"))) {
        throw new Error(`Incomplete native load commands in ${filename}`);
      }
      const commands = blocks.flatMap((block) => {
        const command = /^\s*cmd (LC_\w+)$/mu.exec(block)?.[1];
        // LC_ID_DYLIB is an install ID, not a file the loader will open.
        if (!command || !/^LC_(?:LOAD.*DYLIB|REEXPORT_DYLIB|RPATH)$/u.test(command)) {
          return [];
        }
        const value = /^\s*(?:name|path) (.+) \(offset \d+\)$/mu.exec(block)?.[1];
        if (!value) {
          throw new Error(`Unreadable native load command in ${filename}`);
        }
        return [{ command, value }];
      });
      return { architecture, commands };
    });
  }

  const output = execFileSync(
    "/usr/bin/python3",
    [fileURLToPath(new URL("./mac-native-inventory.py", import.meta.url)), runtime],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const records = output.split("\0");
  if (records.pop() !== "" || records.length % 2 !== 0) {
    throw new Error("Incomplete runtime native inventory");
  }
  const native = [];
  const executables = new Set();
  for (let index = 0; index < records.length; index += 2) {
    const kind = records[index];
    const filename = records[index + 1];
    if (!filename || !inside(filename)) {
      throw new Error("Invalid runtime inventory path");
    }
    if (kind === "symlink") {
      if (!inside(fs.realpathSync(filename))) {
        throw new Error(`Runtime symlink escapes bundle: ${filename}`);
      }
    } else if (kind === "executable" || kind === "library") {
      native.push(filename);
      if (kind === "executable") {
        executables.add(filename);
      }
    } else {
      throw new Error(`Invalid runtime inventory kind: ${kind}`);
    }
  }
  const resolvedExecutable = fs.realpathSync(executable);
  if (!inside(resolvedExecutable)) {
    throw new Error("Runtime executable escapes bundle");
  }
  if (app) {
    if (!executables.has(resolvedExecutable)) {
      throw new Error(`Missing native app executable: ${resolvedExecutable}`);
    }
    const images = new Map(native.map((filename) => [filename, loadSlices(filename)]));
    const inspected = new Set();
    const sliceKey = (filename, slice) => `${filename}\0${slice.architecture}`;
    const rpathsFor = (filename, slice, entrypoint) =>
      slice.commands
        .filter(({ command }) => command === "LC_RPATH")
        .map(({ value }) => expandLoaderPath(value, filename, entrypoint));
    const matchingSlice = (filename, architecture) => {
      const slices = images.get(filename) ?? [];
      return (
        slices.find((slice) => slice.architecture === architecture) ??
        slices.find((slice) => slice.architecture.split(":")[0] === architecture.split(":")[0])
      );
    };
    function visit(filename, slice, entrypoint, inheritedRpaths, visited) {
      const key = sliceKey(filename, slice);
      if (visited.has(key)) {
        return;
      }
      visited.add(key);
      inspected.add(key);
      const rpaths = [...rpathsFor(filename, slice, entrypoint), ...inheritedRpaths];
      for (const { command, value } of slice.commands) {
        // Swift Build can retain unused toolchain search paths. Only resolved
        // load dependencies must be portable; the runtime's stricter audit stays separate.
        if (command === "LC_RPATH") {
          continue;
        }
        const candidates = value.startsWith("@rpath/")
          ? rpaths.map((prefix) => path.join(prefix, value.slice(7)))
          : [expandLoaderPath(value, filename, entrypoint)];
        const target = candidates.find(
          (candidate) =>
            systemLibrary(candidate) ||
            (path.isAbsolute(candidate) &&
              inside(path.resolve(candidate)) &&
              fs.existsSync(candidate) &&
              inside(fs.realpathSync(candidate))),
        );
        if (!target) {
          throw new Error(
            `Nonportable ${command} in ${filename} (${slice.architecture}): ${value}`,
          );
        }
        if (!systemLibrary(target)) {
          const dependency = fs.realpathSync(target);
          const dependencySlice = matchingSlice(dependency, slice.architecture);
          if (!dependencySlice) {
            throw new Error(
              `Missing native dependency slice in ${dependency}: ${slice.architecture}`,
            );
          }
          visit(dependency, dependencySlice, entrypoint, rpaths, visited);
        }
      }
    }
    // Each MH_EXECUTE starts a fresh dyld process, including nested Sparkle,
    // MLX, and runtime helpers. Sibling executables never supply its runpaths.
    for (const entrypoint of executables) {
      for (const slice of images.get(entrypoint)) {
        visit(entrypoint, slice, entrypoint, [], new Set());
      }
    }
    // dlopen-only libraries are absent from executable load-command graphs.
    // Runtime addons keep Bun as their host; other app libraries use OpenClaw.
    const privateRuntime = path.join(runtime, "Contents/Resources/runtime");
    for (const [filename, slices] of images) {
      const entrypoint = filename.startsWith(`${privateRuntime}/`)
        ? path.join(privateRuntime, "bin/bun")
        : resolvedExecutable;
      for (const slice of slices) {
        if (!inspected.has(sliceKey(filename, slice))) {
          const hostSlice = matchingSlice(entrypoint, slice.architecture);
          const rpaths = hostSlice ? rpathsFor(entrypoint, hostSlice, entrypoint) : [];
          visit(filename, slice, entrypoint, rpaths, new Set());
        }
      }
    }
    return native.length;
  }
  const executableSlices = loadSlices(resolvedExecutable);
  const executableRpaths = new Map(
    executableSlices.map(({ architecture, commands }) => [
      architecture,
      commands.filter(({ command }) => command === "LC_RPATH"),
    ]),
  );
  for (const filename of native) {
    const slices = filename === resolvedExecutable ? executableSlices : loadSlices(filename);
    for (const { architecture, commands } of slices) {
      // A working slice must not supply missing loader paths to another slice.
      const rpaths = [
        ...(executableRpaths.get(architecture) ?? []),
        ...commands.filter(({ command }) => command === "LC_RPATH"),
      ];
      for (const { command, value } of commands) {
        const candidates = value.startsWith("@rpath/")
          ? rpaths.map(({ value: prefix }) =>
              path.join(expandLoaderPath(prefix, filename), value.slice(7)),
            )
          : [expandLoaderPath(value, filename)];
        if (
          !candidates.some(
            (candidate) =>
              systemLibrary(candidate) ||
              (path.isAbsolute(candidate) &&
                inside(path.resolve(candidate)) &&
                fs.existsSync(candidate) &&
                inside(fs.realpathSync(candidate))),
          )
        ) {
          throw new Error(`Nonportable ${command} in ${filename} (${architecture}): ${value}`);
        }
      }
    }
  }
  return native.length;
}

export function auditMacRuntimePortability(runtime, executable) {
  return auditMacPortability(runtime, executable);
}

function auditMacAppPortability(app) {
  const root = fs.realpathSync(app);
  return auditMacPortability(root, path.join(root, "Contents/MacOS/OpenClaw"), true);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [app] = process.argv.slice(2);
  if (!app) {
    throw new Error("Usage: mac-runtime-portability.mjs <app>");
  }
  console.log(`Verified app native dependencies (${auditMacAppPortability(app)} images)`);
}
