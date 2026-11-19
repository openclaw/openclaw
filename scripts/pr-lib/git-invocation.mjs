import { realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve, win32 } from "node:path";
import { resolvePathEnvKey } from "../windows-cmd-helpers.mjs";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function windowsGitInvocation(selectedGit, env, cwd) {
  // Spawn resolves relative/root-relative cwd before Git performs drive-relative
  // PATH lookup; comparing the raw option can select the wrong drive directory.
  const resolvedCwd = win32.resolve(cwd);
  // Match Node's case-insensitive child environment, then gh 2.93's pinned
  // cli/safeexec v1.0.1 lookup. It skips implicit cwd, but honors PATH entries.
  const keys = Object.keys(env).toSorted();
  const childEnv = Object.fromEntries(keys.map((key) => [key, env[key]]));
  const value = (name) => childEnv[keys.find((key) => key.toLowerCase() === name)];
  const path = childEnv[resolvePathEnvKey(childEnv)] ?? "";
  const pathExt = value("pathext");
  const extensions = pathExt
    ? pathExt
        .toLowerCase()
        .split(";")
        .filter(Boolean)
        .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
    : [".com", ".exe", ".bat", ".cmd"];
  const directories = [];
  let directory = "",
    quoted = false;
  for (const char of path) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === ";" && !quoted) {
      directories.push(directory);
      directory = "";
    } else {
      directory += char;
    }
  }
  if (path) {
    directories.push(directory);
  }
  const absolute = (file) => {
    const drive = /^([a-z]:)(?![\\/])/i.exec(file)?.[1];
    if (drive && resolvedCwd.slice(0, 2).toLowerCase() !== drive.toLowerCase()) {
      return win32.resolve(value(`=${drive.toLowerCase()}`) || `${drive}\\`, file.slice(2));
    }
    return win32.resolve(resolvedCwd, file);
  };
  let observed, observedName;
  search: for (const dir of directories) {
    // Go filepath.Join preserves a drive-relative directory ending in ':'.
    const stem = dir.endsWith(":") ? `${dir}git` : win32.join(dir, "git");
    for (const extension of extensions.length ? extensions : [""]) {
      const name = `${stem}${extension}`;
      const file = absolute(name);
      try {
        if (!statSync(file).isDirectory()) {
          observed = file;
          observedName = name;
          break search;
        }
      } catch {
        /* safeexec continues past inaccessible/missing candidates. */
      }
    }
  }
  // gh passes safeexec's lexical result to Go exec, which searches PATH again
  // for a bare name. That second lookup can bypass this physical selection.
  const bareResult = observedName && win32.basename(observedName) === observedName;
  let target;
  try {
    target = realpathSync(absolute(selectedGit));
    const wanted = statSync(target, { bigint: true });
    const actual = observed && statSync(observed, { bigint: true });
    if (
      !bareResult &&
      wanted.isFile() &&
      wanted.ino !== 0n &&
      actual?.isFile() &&
      wanted.dev === actual.dev &&
      wanted.ino === actual.ino
    ) {
      return { executable: target, env };
    }
  } catch {
    /* Unknown physical identity cannot admit a different PATH Git. */
  }
  throw Object.assign(
    new Error(
      bareResult
        ? `Windows PATH Git resolves to bare ${observedName}, which GitHub CLI searches again. Use an absolute PATH directory for the selected policy executable or use WSL.`
        : `Selected Git ${target ?? selectedGit} does not match Windows PATH Git ${observed ?? "(not found)"}. Make the selected policy executable the actual PATH Git or use WSL.`,
    ),
    { code: "OPENCLAW_PR_GIT_CAPABILITY", status: 78 },
  );
}

// A selected policy launcher may delegate bare Git. Restore its discovery PATH,
// rather than letting our own alias become that launcher's backend recursively.
// The caller owns this directory's existing operation/drain cleanup lifetime.
export function bindGitInvocation(directory, selectedGit, env = process.env, cwd = process.cwd()) {
  // Native gh directly executes its PATH Git; .cmd/shell aliases cannot bind an
  // alternate executable. Matching native selection needs no PATH/PATHEXT edits.
  if (process.platform === "win32") {
    return windowsGitInvocation(selectedGit, env, cwd);
  }
  const root = realpathSync(directory);
  const executable = join(root, "git");
  const target = resolve(cwd, selectedGit);
  const path = env.PATH;
  writeFileSync(
    executable,
    `#!/bin/sh\n${path === undefined ? "unset PATH" : `PATH=${quote(path)}\nexport PATH`}\nexec ${quote(target)} "$@"\n`,
    { flag: "wx", mode: 0o700 },
  );
  return {
    executable,
    env: {
      ...env,
      PATH: path === undefined ? root : `${root}${delimiter}${path}`,
      OPENCLAW_PR_GIT: executable,
      GIT_EXEC: executable,
    },
  };
}
